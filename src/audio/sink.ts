/**
 * Audio is written to disk as it arrives, never collected in memory: a call's
 * memory use is one chunk, whatever the length of the text.
 */

import { type FileHandle, open, rm } from 'node:fs/promises';

/** Where synthesized audio is written, in order. */
export interface AudioSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Overwrites already-written bytes at `position` (to fill in a WAV header's sizes). */
  writeAt(chunk: Uint8Array, position: number): Promise<void>;
  readonly bytesWritten: number;
}

/** An {@link AudioSink} on a new file. */
export class FileSink implements AudioSink {
  private written = 0;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  /** Creates `path`, which must not exist. */
  static async create(path: string, mode = 0o666): Promise<FileSink> {
    return new FileSink(path, await open(path, 'wx', mode));
  }

  get bytesWritten(): number {
    return this.written;
  }

  private async writeFully(chunk: Uint8Array, position: number): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        position + offset,
      );
      offset += bytesWritten;
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writeFully(chunk, this.written);
    this.written += chunk.byteLength;
  }

  async writeAt(chunk: Uint8Array, position: number): Promise<void> {
    if (position + chunk.byteLength > this.written)
      throw new RangeError('writeAt past the end of the audio');
    await this.writeFully(chunk, position);
  }

  /** Flushes and closes the file. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  /** Closes and deletes the file. */
  async discard(): Promise<void> {
    await this.close().catch(() => undefined);
    await rm(this.path, { force: true });
  }
}
