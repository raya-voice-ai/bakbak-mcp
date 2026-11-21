import type { Delivery } from '../delivery.js';
import type { AudioStore } from './audioStore.js';

/** Hosted mode: audio streams into the store; the result carries a link and its expiry. */
export function createHostedDelivery(store: AudioStore): Delivery {
  return {
    async begin(request) {
      const upload = await store.begin(request.extension, request.owner);
      return {
        write: (chunk) => upload.sink.write(chunk),
        writeAt: (chunk, position) => upload.sink.writeAt(chunk, position),
        get bytesWritten() {
          return upload.sink.bytesWritten;
        },
        async commit() {
          const stored = await upload.commit();
          return {
            delivered: { audio_url: stored.url, expires_at: stored.expiresAt.toISOString() },
            filePath: stored.path,
          };
        },
        discard: () => upload.discard(),
      };
    },
  };
}
