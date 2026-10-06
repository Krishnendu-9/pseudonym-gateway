import { describe, expect, it } from 'vitest';
import {
  LATENCY_SIZES_KIB,
  median,
  perKiB,
  speedText,
  tokensByScript,
} from '../../../../eval/names/latency.js';

describe('median', () => {
  it('takes the middle value, the lower one of an even count, and none of nothing', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2);
    expect(median([7])).toBe(7);
    expect(median([])).toBeUndefined();
  });
});

describe('tokensByScript', () => {
  it('splits messages by whether they hold Devanagari, and totals them', () => {
    const counts = tokensByScript(['abcd', 'नाम', 'xy'], (text) => text.length * 10);
    // "नाम" is 3 characters and 9 bytes of UTF-8.
    expect(counts.devanagari).toEqual({ kib: 9 / 1024, tokens: 30 });
    expect(counts.latin).toEqual({ kib: 6 / 1024, tokens: 60 });
    expect(counts.all).toEqual({ kib: 15 / 1024, tokens: 90 });
    expect(perKiB(counts.latin)).toBe(10240);
    expect(perKiB(tokensByScript([], () => 1).all)).toBe(0);
  });

  it('measures at 1, 4, 16 and 64 KiB', () => {
    expect([...LATENCY_SIZES_KIB]).toEqual([1, 4, 16, 64]);
  });
});

describe('speedText (moved from the comparison script in step 4b)', () => {
  it('joins messages by blank lines until the next would pass the byte budget', () => {
    expect(speedText(['aa', 'bb', 'cc'], 6)).toBe('aa\n\nbb');
    expect(speedText(['aa', 'bb', 'cc'], 5)).toBe('aa');
  });

  it('counts UTF-8 bytes, starts at `from` and goes round the messages again', () => {
    expect(speedText(['é', 'b'], 2)).toBe('é');
    expect(speedText(['a', 'b'], 9, 1)).toBe('b\n\na\n\nb');
  });
});
