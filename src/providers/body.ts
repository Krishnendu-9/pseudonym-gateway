// Reading a provider's response under the response size cap (ADR-020).
//
// The model writes the response, and a prompt-injected or broken provider
// can make it as long as it likes. Without a cap the gateway would hold all
// of it in memory, parse it, and restore it while serving nothing else. Two
// checks: a declared Content-Length over the cap fails before a byte is
// read, and every byte actually read is counted, since a chunked response
// declares nothing.

import { ProviderError } from './provider.js';

/** Fails (and releases the connection) if the declared length is over the cap. */
export async function rejectDeclaredTooLarge(response: Response, maxBytes: number): Promise<void> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new ProviderError('too_large');
  }
}

/** Reads a body a chunk at a time, failing once more than `maxBytes` arrived. */
export class CappedReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(body: ReadableStream<Uint8Array> | null, maxBytes: number) {
    this.#reader = body?.getReader();
    this.#maxBytes = maxBytes;
  }

  /** The next chunk, or undefined at the end of the body. */
  async next(): Promise<Uint8Array | undefined> {
    if (this.#reader === undefined) return undefined;
    const { done, value } = await this.#reader.read();
    if (done) return undefined;
    this.#bytes += value.byteLength;
    if (this.#bytes > this.#maxBytes) throw new ProviderError('too_large');
    return value;
  }

  /** The whole body as text (a leading byte-order mark dropped, as `Response.text()` does). */
  async text(): Promise<string> {
    const chunks: Uint8Array[] = [];
    for (let chunk = await this.next(); chunk !== undefined; chunk = await this.next()) {
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  /** Stops reading and releases the connection. Never throws. */
  async cancel(): Promise<void> {
    await this.#reader?.cancel().catch(() => undefined);
  }
}
