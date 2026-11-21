import type { Delivery } from '../delivery.js';
import type { AudioStore } from './audioStore.js';

/** Hosted mode: audio goes into the store and the result carries a link and its expiry. */
export function createHostedDelivery(store: AudioStore): Delivery {
  return {
    prepare(request) {
      return Promise.resolve({
        async commit(data) {
          const stored = await store.put(data, request.extension);
          return { audio_url: stored.url, expires_at: stored.expiresAt.toISOString() };
        },
      });
    },
  };
}
