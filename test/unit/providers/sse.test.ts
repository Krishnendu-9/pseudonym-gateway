// The server-sent events parser (ADR-019): the parts of the WHATWG
// algorithm a chat stream uses, that network chunking never changes the
// result (cut anywhere, even inside a UTF-8 character or between CR and
// LF), and the per-event byte cap (ADR-020).
//
// No personal data: event payloads are arbitrary generated text.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SseEventTooLargeError, SseParser, type SseEvent } from '../../../src/providers/sse.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Parses `chunks` in order with a generous cap; returns every event. */
function parse(chunks: readonly (string | Uint8Array)[], maxEventBytes = 1_000_000): SseEvent[] {
  const parser = new SseParser(maxEventBytes);
  return chunks.flatMap((chunk) => parser.push(typeof chunk === 'string' ? bytes(chunk) : chunk));
}

const message = (data: string): SseEvent => ({ type: 'message', data });

describe('SseParser: the event stream format', () => {
  it('dispatches an event at a blank line', () => {
    expect(parse(['data: {"a":1}\n\n'])).toEqual([message('{"a":1}')]);
  });

  it('joins several data lines with "\\n"', () => {
    expect(parse(['data: one\ndata: two\ndata:\n\n'])).toEqual([message('one\ntwo\n')]);
  });

  it('strips exactly one space after the colon, and none is needed', () => {
    expect(parse(['data:no-space\n\n', 'data:  two spaces\n\n'])).toEqual([
      message('no-space'),
      message(' two spaces'),
    ]);
  });

  it('keeps colons in the value', () => {
    expect(parse(['data: {"url":"https://x.example"}\n\n'])).toEqual([
      message('{"url":"https://x.example"}'),
    ]);
  });

  it('a line with no colon is a field with an empty value', () => {
    expect(parse(['data\n\n'])).toEqual([message('')]);
  });

  it('ignores comments, id, retry and unknown fields', () => {
    expect(parse([': keep-alive\nid: 7\nretry: 1000\nfoo: bar\ndata: x\n\n'])).toEqual([
      message('x'),
    ]);
  });

  it('reads the event type, which resets after each event', () => {
    expect(parse(['event: error\ndata: a\n\ndata: b\n\n'])).toEqual([
      { type: 'error', data: 'a' },
      message('b'),
    ]);
  });

  it('a blank line with no data dispatches nothing (and resets the type)', () => {
    expect(parse(['\n\n: comment\n\nevent: x\n\ndata: y\n\n'])).toEqual([message('y')]);
  });

  it('never dispatches an event the stream ends in the middle of', () => {
    expect(parse(['data: done\n\ndata: cut off\n'])).toEqual([message('done')]);
    expect(parse(['data: no newline at all'])).toEqual([]);
  });

  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
  ])('accepts %s line endings', (_name, eol) => {
    expect(parse([`data: a${eol}data: b${eol}${eol}data: c${eol}${eol}`])).toEqual([
      message('a\nb'),
      message('c'),
    ]);
  });

  it('accepts mixed line endings', () => {
    expect(parse(['data: a\r\ndata: b\rdata: c\n\r\ndata: d\r\r'])).toEqual([
      message('a\nb\nc'),
      message('d'),
    ]);
  });

  it('CR at the end of one chunk and LF at the start of the next are one line ending', () => {
    // Read as two endings, the LF would be a blank line and dispatch early.
    expect(parse(['data: a\r', '\ndata: b\r\n\r\n'])).toEqual([message('a\nb')]);
  });

  it('CR at the end of a chunk ends the line even when no LF follows', () => {
    expect(parse(['data: a\r', 'data: b\r', '\r'])).toEqual([message('a\nb')]);
  });

  it('an empty chunk after a CR does not lose the pending CR', () => {
    expect(parse(['data: a\r', '', '\n\n'])).toEqual([message('a')]);
  });

  it('drops a byte-order mark at the very start only, even split across chunks', () => {
    const bom = bytes('﻿');
    expect(parse([bom.subarray(0, 1), bom.subarray(1), 'data: a\n\n'])).toEqual([message('a')]);
    expect(parse(['data: a\n\n﻿data: b\n\n'])).toEqual([message('a')]);
  });

  it('decodes a UTF-8 character split across chunks', () => {
    const encoded = bytes('data: ₹ 🙂 हिन्दी\n\n');
    for (let cut = 0; cut <= encoded.length; cut++) {
      expect(parse([encoded.subarray(0, cut), encoded.subarray(cut)])).toEqual([
        message('₹ 🙂 हिन्दी'),
      ]);
    }
  });

  it('replaces invalid UTF-8 rather than throwing', () => {
    const invalid = Uint8Array.from([...bytes('data: a'), 0xff, 0xfe, ...bytes('b\n\n')]);
    expect(parse([invalid])).toEqual([message('a��b')]);
  });
});

describe('SseParser: chunking never changes the events (property)', () => {
  const lineArb = fc.string({ unit: 'binary', maxLength: 12 }).filter((s) => !/[\r\n]/.test(s));
  const eventArb = fc.record({
    type: fc.constantFrom('', 'message', 'error'),
    comment: fc.boolean(),
    lines: fc.array(lineArb, { minLength: 1, maxLength: 3 }),
  });
  const streamArb = fc.record({
    events: fc.array(eventArb, { maxLength: 6 }),
    eol: fc.constantFrom('\n', '\r', '\r\n'),
    cuts: fc.array(fc.nat(), { maxLength: 12 }),
  });

  it('any events, any line ending, cut at any bytes: the events come out whole', () => {
    assertPropertyQuietly(
      fc.property(streamArb, ({ events, eol, cuts }) => {
        const text = events
          .map(
            (e) =>
              (e.comment ? `: note${eol}` : '') +
              (e.type ? `event: ${e.type}${eol}` : '') +
              e.lines.map((line) => `data: ${line}${eol}`).join('') +
              eol,
          )
          .join('');
        const encoded = bytes(text);
        const positions = [...new Set(cuts.map((c) => c % (encoded.length + 1)))].sort(
          (a, b) => a - b,
        );
        const chunks: Uint8Array[] = [];
        let from = 0;
        for (const at of [...positions, encoded.length]) {
          chunks.push(encoded.subarray(from, at));
          from = at;
        }
        const expected = events.map((e) => ({
          type: e.type || 'message',
          data: e.lines.join('\n'),
        }));
        return JSON.stringify(parse(chunks)) === JSON.stringify(expected);
      }),
      { numRuns: 500 },
    );
  });
});

describe('SseParser: the per-event cap (ADR-020)', () => {
  const tooLarge = (chunks: readonly string[], cap: number): boolean => {
    try {
      parse(chunks, cap);
      return false;
    } catch (error) {
      return error instanceof SseEventTooLargeError;
    }
  };

  it('an event exactly at the cap is fine; one byte over is not', () => {
    // "data: " + 4 bytes = 10 bytes of line.
    expect(parse(['data: abcd\n\n'], 10)).toEqual([message('abcd')]);
    expect(tooLarge(['data: abcde\n\n'], 10)).toBe(true);
  });

  it('counts a line before its end arrives, so a line that never ends cannot grow', () => {
    const parser = new SseParser(100);
    expect(parser.push(bytes('data: '))).toEqual([]);
    expect(() => parser.push(bytes('x'.repeat(95)))).toThrow(SseEventTooLargeError);
  });

  it('counts every line of one event, comments and unknown fields included', () => {
    expect(tooLarge(['data: 1234\n', 'data: 1234\n', 'data: 1234\n\n'], 25)).toBe(true);
    expect(tooLarge([': 123456789\n: 123456789\n: 123456789\n'], 25)).toBe(true);
  });

  it('starts again at every blank line: many small events are fine', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => `data: ${i}\n\n`);
    expect(parse(many, 16)).toHaveLength(1_000);
  });

  it('counts bytes, not characters', () => {
    // 3 characters, 9 bytes: over a cap of 12 with "data: ".
    expect(tooLarge(['data: ₹₹₹\n\n'], 12)).toBe(true);
    expect(parse(['data: ₹₹\n\n'], 12)).toEqual([message('₹₹')]);
  });

  it('the error names the limit, never the content', () => {
    expect(() => parse(['data: secret-looking-text\n\n'], 8)).toThrow(
      'server-sent event larger than 8 bytes',
    );
  });
});
