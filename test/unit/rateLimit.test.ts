import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../../src/http/rateLimit.js';

describe('RateLimiter', () => {
  it('allows a burst, then refills at the sustained rate', () => {
    let now = 0;
    const limiter = new RateLimiter({ burst: 3, perMinute: 60, now: () => now });
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(limiter.take('a')).toBe(1);
    expect(limiter.take('b')).toBeUndefined();
    now += 1000;
    expect(limiter.take('a')).toBeUndefined();
    expect(limiter.take('a')).toBe(1);
  });

  it('forgets the oldest keys beyond its bound', () => {
    const limiter = new RateLimiter({ burst: 1, perMinute: 1, maxKeys: 2, now: () => 0 });
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    expect(limiter.take('a')).toBeUndefined(); // forgotten, so a fresh bucket
    expect(limiter.take('c')).toBeGreaterThan(0);
  });
});
