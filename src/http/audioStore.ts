/**
 * Hosted mode's audio store: generated audio kept on disk for a limited time
 * under an unguessable 128-bit id, served at `/audio/<id>.<ext>`.
 *
 * A file's age is its modification time, so expiry survives restarts without
 * any index. The directory is swept periodically, and the total size is capped
 * by deleting the oldest files first.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DeliveryError } from '../delivery.js';
import type { Logger } from '../log.js';

export interface AudioStoreOptions {
  directory: string;
  /** How long audio stays available, in milliseconds. */
  ttlMs: number;
  /** Upper bound on the bytes kept on disk. */
  maxBytes: number;
  /** Public base URL; audio URLs are `<publicUrl>/audio/<id>.<ext>`. */
  publicUrl: string;
  logger: Logger;
  now?: () => number;
}

export interface StoredAudio {
  id: string;
  url: string;
  expiresAt: Date;
}

export interface AudioFile {
  path: string;
  size: number;
  contentType: string;
  fileName: string;
}

/** 16 random bytes, base64url: 22 characters. */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

const CONTENT_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  pcm: 'audio/pcm',
  f32: 'audio/pcm',
  ulaw: 'audio/basic',
  alaw: 'application/octet-stream',
  raw: 'application/octet-stream',
};

export class AudioTooLargeError extends DeliveryError {
  override readonly name = 'AudioTooLargeError';
}

interface Entry {
  name: string;
  size: number;
  mtime: number;
}

export class AudioStore {
  private readonly directory: string;
  private readonly now: () => number;
  /** Files on disk, oldest first. */
  private entries: Entry[] = [];
  private totalBytes = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AudioStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.now = options.now ?? Date.now;
  }

  /** Creates the directory, indexes what is there, and starts sweeping. */
  async start(
    sweepIntervalMs = Math.min(60_000, Math.max(1000, this.options.ttlMs / 4)),
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.reindex();
    await this.sweep();
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.options.logger.error('audio sweep failed', { error });
      });
    }, sweepIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  get bytesStored(): number {
    return this.totalBytes;
  }

  private async reindex(): Promise<void> {
    const entries: Entry[] = [];
    for (const name of await readdir(this.directory)) {
      if (!this.parseName(name)) continue;
      const info = await stat(path.join(this.directory, name)).catch(() => undefined);
      if (info?.isFile()) entries.push({ name, size: info.size, mtime: info.mtimeMs });
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    this.entries = entries;
    this.totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  }

  private parseName(name: string): { id: string; ext: string } | undefined {
    const dot = name.indexOf('.');
    const id = name.slice(0, dot);
    const ext = name.slice(dot + 1);
    return dot > 0 && ID_PATTERN.test(id) && EXTENSION_PATTERN.test(ext) ? { id, ext } : undefined;
  }

  private async remove(entry: Entry): Promise<void> {
    await rm(path.join(this.directory, entry.name), { force: true });
    this.entries = this.entries.filter((e) => e !== entry);
    this.totalBytes -= entry.size;
  }

  /** Deletes expired files. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.options.ttlMs;
    // Entries are oldest first, so the expired ones are a prefix.
    const firstLive = this.entries.findIndex((e) => e.mtime > cutoff);
    const expired = this.entries.splice(0, firstLive === -1 ? this.entries.length : firstLive);
    for (const entry of expired) {
      await rm(path.join(this.directory, entry.name), { force: true });
      this.totalBytes -= entry.size;
    }
    // Temporary files from writes interrupted by a crash.
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.tmp')) continue;
      const info = await stat(path.join(this.directory, name)).catch(() => undefined);
      if (info && info.mtimeMs <= cutoff)
        await rm(path.join(this.directory, name), { force: true });
    }
    return expired.length;
  }

  /** Stores audio and returns its URL. Evicts the oldest audio if needed to stay under the cap. */
  async put(data: Uint8Array, extension: string): Promise<StoredAudio> {
    if (!EXTENSION_PATTERN.test(extension))
      throw new Error(`Unsupported audio extension: ${extension}`);
    if (data.byteLength > this.options.maxBytes) {
      throw new AudioTooLargeError(
        `The audio (${data.byteLength} bytes) is larger than this server stores (${this.options.maxBytes} bytes).`,
      );
    }
    while (this.totalBytes + data.byteLength > this.options.maxBytes && this.entries.length > 0) {
      const [oldest] = this.entries;
      if (oldest) await this.remove(oldest);
    }
    const id = randomBytes(16).toString('base64url');
    const name = `${id}.${extension}`;
    const finalPath = path.join(this.directory, name);
    const temp = `${finalPath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await rename(temp, finalPath);
    const mtime = (await stat(finalPath)).mtimeMs;
    this.entries.push({ name, size: data.byteLength, mtime });
    this.totalBytes += data.byteLength;
    return {
      id,
      url: `${this.options.publicUrl}/audio/${name}`,
      expiresAt: new Date(mtime + this.options.ttlMs),
    };
  }

  /** The file for `/audio/<name>`, or undefined if the name is malformed, unknown or expired. */
  async get(name: string): Promise<AudioFile | undefined> {
    const parsed = this.parseName(name);
    if (!parsed) return undefined;
    const filePath = path.join(this.directory, name);
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    if (info.mtimeMs + this.options.ttlMs <= this.now()) {
      const entry = this.entries.find((e) => e.name === name);
      if (entry) await this.remove(entry);
      else await rm(filePath, { force: true });
      return undefined;
    }
    return {
      path: filePath,
      size: info.size,
      contentType: CONTENT_TYPES[parsed.ext] ?? 'application/octet-stream',
      fileName: `bakbak-${parsed.id.slice(0, 8)}.${parsed.ext}`,
    };
  }
}
