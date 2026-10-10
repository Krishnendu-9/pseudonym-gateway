// The HTTP server: one endpoint, POST /v1/chat/completions, in OpenAI's
// format, streaming (server-sent events) or not.
//
// A request's life: Fastify parses the JSON body (application/json only,
// capped at the body limit) -> parseChatRequest() applies the allowlist ->
// with names on, the name finder finds person names in every piece of
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
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChatProvider } from '../providers/provider.js';
import { PlaceholderMapping } from '../redaction/mapping.js';
import { restore, StreamRestorer } from '../redaction/restore.js';
import { GatewayError, safeErrorDetails, toGatewayError } from './errors.js';
import { loggerOptions, type LogStream } from './logging.js';
import type { NameSpans } from '../redaction/redact.js';
import { redactRequest, requestTexts } from './redact-request.js';
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
    else request.log.info(details, 'request rejected');
    return reply.code(safe.statusCode).send(safe.body());
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
        .send(Readable.from(events));
    }

    const result = await provider.complete(outbound, controller.signal);
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
