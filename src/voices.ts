/**
 * A per-key cache of `GET /v1/voices`. The list changes rarely and is needed
 * for `list_voices`, for picking a default voice, and for a voice's model, so
 * it is fetched once per key and shared by concurrent callers.
 */

import type { Voice } from './backend/types.js';
import { fingerprint } from './util.js';

export interface VoiceFilter {
  language?: string | undefined;
  model?: string | undefined;
  /** Case-insensitive substring of the voice name. */
  query?: string | undefined;
}

interface Entry {
  expires: number;
  voices: Promise<Voice[]>;
  /** The list, once the fetch has succeeded. */
  settled?: Voice[];
}

export class VoiceCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached voice list for this key, if one has already arrived; never fetches. */
  peek(apiKey: string): Voice[] | undefined {
    const hit = this.entries.get(fingerprint(apiKey));
    return hit && hit.expires > this.now() ? hit.settled : undefined;
  }

  /** The voice list for this key, from cache or from `fetch`. Failures are not cached. */
  get(apiKey: string, fetch: () => Promise<Voice[]>): Promise<Voice[]> {
    const id = fingerprint(apiKey);
    const now = this.now();
    const hit = this.entries.get(id);
    if (hit && hit.expires > now) return hit.voices;

    const voices = fetch();
    const entry: Entry = { expires: now + this.ttlMs, voices };
    this.entries.delete(id); // re-insert at the end, so eviction drops the oldest first
    this.entries.set(id, entry);
    voices.then(
      (list) => {
        entry.settled = list;
      },
      () => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      },
    );
    // Map iteration is insertion order: drop the oldest entries beyond the bound.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
    return voices;
  }
}

/** Voices matching every given filter, in the API's order. */
export function filterVoices(voices: readonly Voice[], filter: VoiceFilter): Voice[] {
  const query = filter.query?.trim().toLowerCase();
  return voices.filter(
    (v) =>
      (filter.language === undefined || v.language === filter.language) &&
      (filter.model === undefined || v.model === filter.model) &&
      (!query || v.name.toLowerCase().includes(query)),
  );
}
