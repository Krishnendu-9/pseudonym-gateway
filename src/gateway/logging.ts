// Logger settings (ADR-001 logging correction; design doc, "Errors and
// logs"). Request and response bodies are never logged at all: the
// serializers below are the mechanism, and they keep only the method, the
// route *pattern* (the raw URL could carry a query string), the status code
// and, from Fastify, the response time and request id. Pino's `redact` is a
// second layer for known paths, not the defence: it cannot clean free text.

import type { FastifyLoggerOptions, FastifyServerOptions } from 'fastify';
import { safeErrorDetails } from './errors.js';

type LoggerSerializers = FastifyLoggerOptions['serializers'];

/** Where log lines are written: Pino's destination-stream shape. */
export interface LogStream {
  write(line: string): void;
}

interface LoggedRequest {
  readonly method: string;
  readonly routeOptions?: { readonly url?: string | undefined };
}

export function loggerOptions(
  level: string,
  stream?: LogStream,
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    serializers: {
      req: (request: LoggedRequest) => ({
        method: request.method,
        route: request.routeOptions?.url ?? 'unmatched',
      }),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      // Fastify's type for this describes its default serializer, which
      // returns `message` and `stack`: exactly what this one leaves out.
      err: safeErrorDetails as unknown as NonNullable<NonNullable<LoggerSerializers>['err']>,
    },
    redact: {
      paths: ['req.headers', 'req.body', 'req.url', 'res.body', 'body', 'headers'],
      censor: '[hidden]',
    },
    ...(stream === undefined ? {} : { stream }),
  };
}
