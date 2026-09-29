// A server-sent events parser (WHATWG HTML, "Server-sent events",
// section 9.2.6 "Interpreting an event stream"), hand-written rather than
// a dependency (ADR-019): the part a chat stream needs is about sixty lines.
//
// It works on bytes, not decoded text. Lines end at LF, CR or CRLF, and
// neither byte can occur inside a UTF-8 multi-byte sequence, so splitting
// on them can never cut a character in half, even when a network chunk
// ends mid-character; each complete line is decoded on its own. Working on
// bytes also lets the per-event cap count real bytes.
//
// What it implements: `data:` lines joined with "\n", `event:` types
// (default "message"), comments (lines starting with ":"), one optional
// space after the colon, a line with no colon as a field with an empty
// value, a leading byte-order mark, and dispatch on a blank line only: an
// event the stream ends in the middle of is never dispatched, as the spec
// says, so a truncated stream cannot pass off half an event as whole.
// `id:` and `retry:` only matter to a browser that reconnects, and are
// ignored.

const LF = 0x0a;
const CR = 0x0d;

export interface SseEvent {
  readonly type: string;
  readonly data: string;
}

/** The lines of one event (comments and unknown fields included) passed
 * the byte limit before its blank line arrived. */
export class SseEventTooLargeError extends Error {
  constructor(limit: number) {
    super(`server-sent event larger than ${limit} bytes`);
    this.name = 'SseEventTooLargeError';
  }
}

export class SseParser {
  readonly #maxEventBytes: number;
  /** The current, unfinished line, in the pieces it arrived in. */
  #line: Uint8Array[] = [];
  #lineBytes = 0;
  /** Bytes of the finished lines of the current event. */
  #eventBytes = 0;
  #data: string[] = [];
  #type = '';
  /** The last chunk ended with CR: an LF starting the next one ends nothing. */
  #afterCR = false;
  #firstLine = true;

  constructor(maxEventBytes: number) {
    this.#maxEventBytes = maxEventBytes;
  }

  /** Takes the next bytes of the stream; returns the events they complete. */
  push(chunk: Uint8Array): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    if (this.#afterCR && chunk.length > 0) {
      if (chunk[0] === LF) start = 1;
      this.#afterCR = false;
    }
    for (let i = start; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte !== LF && byte !== CR) continue;
      this.#append(chunk.subarray(start, i));
      this.#endLine(events);
      if (byte === CR) {
        if (i + 1 === chunk.length) this.#afterCR = true;
        else if (chunk[i + 1] === LF) i++;
      }
      start = i + 1;
    }
    this.#append(chunk.subarray(start));
    return events;
  }

  #append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#line.push(bytes);
    this.#lineBytes += bytes.length;
    if (this.#eventBytes + this.#lineBytes > this.#maxEventBytes) {
      throw new SseEventTooLargeError(this.#maxEventBytes);
    }
  }

  #endLine(events: SseEvent[]): void {
    let line = Buffer.concat(this.#line).toString('utf8');
    this.#eventBytes += this.#lineBytes;
    this.#line = [];
    this.#lineBytes = 0;
    if (this.#firstLine) {
      this.#firstLine = false;
      if (line.startsWith('﻿')) line = line.slice(1);
    }

    if (line === '') {
      if (this.#data.length > 0) {
        events.push({ type: this.#type || 'message', data: this.#data.join('\n') });
      }
      this.#data = [];
      this.#type = '';
      this.#eventBytes = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#type = value;
  }
}
