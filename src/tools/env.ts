import type { Backend } from '../backend/types.js';
import type { Delivery } from '../delivery.js';
import type { Logger } from '../log.js';
import type { VoiceCache } from '../voices.js';
import type { Admission } from './admission.js';
import type { ServerMode } from './errors.js';

/** Everything the tools need, for one connection (stdio) or one request (HTTP). */
export interface ToolEnv {
  mode: ServerMode;
  backend: Backend;
  /** The caller's Bakbak API key; undefined when none is configured. */
  apiKey: string | undefined;
  voices: VoiceCache;
  delivery: Delivery;
  logger: Logger;
  /** Per-key rate limit: seconds to wait when the call is refused, else undefined. */
  rateLimit?: ((apiKey: string) => number | undefined) | undefined;
  /** Hosted mode's size and concurrency limits on text_to_speech. */
  admission?: Admission | undefined;
}
