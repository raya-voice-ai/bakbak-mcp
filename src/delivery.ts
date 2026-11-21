/**
 * Where finished audio goes. Local mode writes a file; hosted mode stores the
 * audio for a while and returns a link. Both validate the destination before
 * any credits are spent.
 */

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
}

export type Delivered = { file_path: string } | { audio_url: string; expires_at: string };

/** A validated destination, ready to receive the audio. */
export interface DeliveryTarget {
  commit(data: Uint8Array): Promise<Delivered>;
}

export interface Delivery {
  /** Checks the destination; throws an error whose message is meant for the caller. */
  prepare(request: DeliveryRequest): Promise<DeliveryTarget>;
}
