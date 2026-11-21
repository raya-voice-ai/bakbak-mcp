/**
 * Where finished audio goes. Local mode writes a file; hosted mode stores the
 * audio for a while and returns a link. Both validate the destination before
 * any credits are spent.
 */

import type { AudioSink } from './audio/sink.js';
import type { OutputFormat } from './backend/types.js';

/** A destination problem; the message tells the caller what to change. */
export class DeliveryError extends Error {
  override readonly name: string = 'DeliveryError';
}

export interface DeliveryRequest {
  format: OutputFormat;
  /** File extension for the format, without the dot. */
  extension: string;
  /** Extensions a caller-chosen path may have. */
  acceptedExtensions: readonly string[];
  mimeType: string;
  /** A generated file name, `<language>_<voice>_<timestamp>_<random>.<ext>`. */
  fileName: string;
  /** The caller's `output_path` (local mode only). */
  outputPath?: string | undefined;
  overwrite: boolean;
  /** Who the audio belongs to (a key fingerprint), for per-key storage quotas. */
  owner: string;
}

export type Delivered = { file_path: string } | { audio_url: string; expires_at: string };

export interface Committed {
  delivered: Delivered;
  /** Where the finished file is on this machine. */
  filePath: string;
}

/** Audio being written to its destination: a temporary file until `commit`. */
export interface PendingAudio extends AudioSink {
  /** Moves the finished file into place. Throws a {@link DeliveryError} if it cannot. */
  commit(): Promise<Committed>;
  /** Deletes the partial file. */
  discard(): Promise<void>;
}

export interface Delivery {
  /**
   * Checks the destination and opens it for writing, before any credits are
   * spent. Throws a {@link DeliveryError} whose message is meant for the caller.
   */
  begin(request: DeliveryRequest): Promise<PendingAudio>;
}
