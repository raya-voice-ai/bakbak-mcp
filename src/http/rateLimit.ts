/**
 * In-memory token buckets keyed by a string (an IP address or a key
 * fingerprint). Per instance: with several instances each enforces its own
 * share, which is enough to blunt abuse without shared state.
 */

export interface RateLimitOptions {
  /** Requests allowed in a burst. */
  burst: number;
  /** Sustained requests per minute. */
  perMinute: number;
  /** Most keys tracked at once; the oldest are forgotten first. */
  maxKeys?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly burst: number;
  private readonly perMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    this.burst = options.burst;
    this.perMs = options.perMinute / 60_000;
    this.maxKeys = options.maxKeys ?? 50_000;
    this.now = options.now ?? Date.now;
  }

  /** Takes one token. Returns undefined if allowed, else the seconds until a token is available. */
  take(key: string): number | undefined {
    const now = this.now();
    const bucket = this.buckets.get(key);
    const tokens = bucket
      ? Math.min(this.burst, bucket.tokens + (now - bucket.updated) * this.perMs)
      : this.burst;
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updated: now });
      return Math.max(1, Math.ceil((1 - tokens) / this.perMs / 1000));
    }
    this.buckets.delete(key); // re-insert at the end: Map order then tracks recency
    this.buckets.set(key, { tokens: tokens - 1, updated: now });
    for (const oldest of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(oldest);
    }
    return undefined;
  }
}
