// The HTTP server: one endpoint, POST /v1/chat/completions, in OpenAI's
// format, streaming (server-sent events) or not.
//
// A request's life: Fastify parses the JSON body (application/json only,
// capped at the body limit) -> parseChatRequest() applies the allowlist ->
// the model is checked, then any field the provider was measured refusing
// (option 3, refusals.ts) -> with names on, the name finder finds person names in every piece of
// client text, or the request is refused (ADR-037) ->
// one PlaceholderMapping is created -> redactRequest() redacts every piece of
// client text into it -> the provider answers in placeholders -> restoration
// puts real values back into the answer -> the response is built field by
// field. The mapping is referenced only from the handler's scope (and, when
// streaming, from the stream's restorer), so it is unreachable once the
// response is sent or the stream ends (ADR-012).
//
// Redaction and restoration run in the route handler, not in the
// preValidation/onSend hooks ADR-001 first sketched (ADR-001 amendment):
// onSend only sees the serialised payload, the wrong place to restore.
//
// Streaming (ADR-019): everything up to the provider's first chunk happens
// before a byte is sent, so every failure there (a provider error status,
// no answer in time, a first chunk we cannot use) is an ordinary HTTP error
// from the error handler. After that the response is 200 and a failure
// becomes an `error` event at the end of the stream (stream.ts).

import { Readable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { ModelRefusals } from '../providers/openai-compatible.js';
import type { ChatProvider, DroppedExtras, UsageCount } from '../providers/provider.js';
import { PlaceholderMapping } from '../redaction/mapping.js';
import { restore, StreamRestorer } from '../redaction/restore.js';
import { GatewayError, isProviderRejection, safeErrorDetails, toGatewayError } from './errors.js';
import { loggerOptions, type LogStream } from './logging.js';
import type { NameSpans } from '../redaction/redact.js';
import { redactRequest, requestTexts } from './redact-request.js';
import { refusedParameter } from './refusals.js';
import { parseChatRequest } from './schema.js';
import { sseEvents } from './stream.js';

/** Finds person names in a request's texts (ADR-037; NameDetector in names.ts). */
export interface NameFinder {
  /**
   * The names in each of `texts`, one entry per text, in order. Rejects
   * with NameDetectionUnavailable (503) when they cannot be found.
   */
  find(texts: readonly string[], signal?: AbortSignal): Promise<NameSpans[]>;
  /** False once the name model has crashed, until the process restarts. */
  readonly healthy: boolean;
}

export interface ServerConfig {
  /** The one model requests must name (ADR-014). */
  readonly model: string;
  /** The provider's profile name, for log lines about the provider. */
  readonly providerName: string;
  /**
   * What the provider was measured refusing for this model (ADR-041 section
   * 16, option 3). Absent: nothing is refused before sending.
   */
  readonly refusals?: ModelRefusals;
  readonly bodyLimit: number;
  readonly restoreInUnsafeRegions: boolean;
  readonly placeholderInstruction: boolean;
  /**
   * Names on: every request's names are found first, and a request whose
   * names cannot be found is refused (ADR-036). Absent: no name step at all.
   */
  readonly names?: NameFinder;
  readonly logLevel: string;
  /** Where log lines go; stdout when omitted. Tests capture them here. */
  readonly logStream?: LogStream;
}

/**
 * One `info` line per answer that carried `extra_content` (ADR-041 section
 * 15, decision 3): how many, and each thought signature's length, nothing
 * else. There is no metrics surface, so the count is the number of these
 * lines; the content itself was dropped by the adapter.
 */
function logDropped(log: FastifyBaseLogger, dropped: DroppedExtras | undefined): void {
  if (dropped === undefined || dropped.extraContent === 0) return;
  log.info(
    {
      extraContent: dropped.extraContent,
      thoughtSignatureLengths: dropped.thoughtSignatureLengths,
    },
    'provider extra content dropped',
  );
}

/**
 * One `warn` line for a stream whose usage counts went down from one chunk
 * to the next (bug-log 75; ADR-041 section 16): the last usage was passed on
 * anyway, never a failure. The provider's name and which counts went down,
 * by name (`prompt`, `completion`, `total`): never their values, which
 * would weakly track the length of the input, and never a body.
 */
function logUsageDecreased(
  log: FastifyBaseLogger,
  provider: string,
  decreased: readonly UsageCount[] | undefined,
): void {
  if (decreased !== undefined && decreased.length > 0) {
    log.warn({ provider, decreased }, 'provider usage counts decreased');
  }
}

/** Yields `events`, then runs `done` however the stream ends. */
async function* thenRun(events: AsyncGenerator<string>, done: () => void): AsyncGenerator<string> {
  try {
    yield* events;
  } finally {
    done();
  }
}

export function buildServer(config: ServerConfig, provider: ChatProvider): FastifyInstance {
  const app = Fastify({
    bodyLimit: config.bodyLimit,
    logger: loggerOptions(config.logLevel, config.logStream),
  });

  // Fastify parses text/plain by default; only JSON is accepted (415 otherwise).
  app.removeContentTypeParser('text/plain');

  app.setErrorHandler((error, request, reply) => {
    const safe = toGatewayError(error, config.bodyLimit);
    const details = { error: safeErrorDetails(error), statusCode: safe.statusCode };
    if (safe.statusCode >= 500) request.log.error(details, 'request failed');
    else if (isProviderRejection(error)) {
      request.log.warn(
        { ...details, provider: config.providerName },
        'provider rejected the request',
      );
    } else request.log.info(details, 'request rejected');
    return reply.code(safe.statusCode).headers(safe.headers).send(safe.body());
  });

  // The URL is never echoed: it could carry a query string.
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(new GatewayError(404, 'not_found', 'unknown endpoint').body()),
  );

  // Unhealthy only once the name model has crashed: it is not restarted, so
  // the process has to be (ADR-036).
  app.get('/health', (_request, reply) =>
    config.names === undefined || config.names.healthy
      ? reply.send({ status: 'ok' })
      : reply.code(503).send({ status: 'unhealthy' }),
  );

  app.post('/v1/chat/completions', async (request, reply) => {
    const chat = parseChatRequest(request.body);
    if (chat.model !== config.model) {
      throw new GatewayError(
        400,
        'model_not_found',
        'model does not match the model this gateway is configured to use',
      );
    }
    // Option 3: a measured refusal is refused here, before names, redaction
    // or the provider, so such a request sends nothing (ADR-041 section 16).
    const refused = refusedParameter(chat, config.refusals);
    if (refused !== undefined) throw refused;

    // A client that disconnects should not keep a provider call running, nor
    // a place in the name queue.
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });

    // Names first, on exactly the texts that will be redacted. A failure
    // here is a 503 before the provider is ever called.
    const names = config.names && (await config.names.find(requestTexts(chat), controller.signal));

    const mapping = new PlaceholderMapping();
    const outbound = redactRequest(chat, mapping, {
      placeholderInstruction: config.placeholderInstruction,
      ...(names === undefined ? {} : { names }),
    });
    const restoreOptions = { restoreInUnsafeRegions: config.restoreInUnsafeRegions };

    if (chat.stream === true) {
      const includeUsage = chat.stream_options?.include_usage === true;
      const stream = await provider.stream(outbound, controller.signal, { includeUsage });
      const events = sseEvents(stream, {
        model: config.model,
        includeUsage,
        restorer: new StreamRestorer(mapping, restoreOptions),
        refusalRestorer: new StreamRestorer(mapping, restoreOptions),
        onError: (error) => {
          const safe = toGatewayError(error, config.bodyLimit);
          const details = { error: safeErrorDetails(error), code: safe.code };
          if (controller.signal.aborted) request.log.info(details, 'stream ended: client left');
          else request.log.error(details, 'stream failed');
          return safe;
        },
      });
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(
          Readable.from(
            thenRun(events, () => {
              logDropped(request.log, stream.dropped?.());
              logUsageDecreased(request.log, config.providerName, stream.usageDecreased?.());
            }),
          ),
        );
    }

    const result = await provider.complete(outbound, controller.signal);
    logDropped(request.log, result.dropped);
    // A refusal is model text like content: restored, with restoration
    // safety, as a text of its own (ADR-041 section 15, decision 1). As in
    // OpenAI's response, `refusal` is on every message, null when there is
    // none (the specification lists it as required).
    const content =
      result.content === null ? null : restore(result.content, mapping, restoreOptions);
    const refusal =
      result.refusal === undefined ? null : restore(result.refusal, mapping, restoreOptions);

    return {
      id: result.id,
      object: 'chat.completion',
      created: result.created,
      model: config.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, refusal },
          finish_reason: result.finishReason,
        },
      ],
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  });

  return app;
}
