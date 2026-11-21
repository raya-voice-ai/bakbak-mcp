/**
 * Hosted mode's audio store: generated audio kept on disk for a limited time
 * under an unguessable 128-bit id, served at `/audio/<id>.<ext>`.
 *
 * - A file's age is its modification time, so expiry survives restarts
 *   without any index. The directory is swept periodically.
 * - Audio is streamed into a temporary file and added to the store only when
 *   complete. Adding (with any eviction it needs) is serialized, so the byte
 *   accounting never drifts.
 * - The total size is capped by deleting the oldest files first, and each key
 *   has its own quota, met by deleting that key's oldest files: one key cannot
 *   push everyone else's links out.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { FileSink } from '../audio/sink.js';
import { DeliveryError } from '../delivery.js';
import type { Logger } from '../log.js';

export interface AudioStoreOptions {
  directory: string;
  /** How long audio stays available, in milliseconds. */
  ttlMs: number;
  /** Upper bound on the bytes kept on disk. */
  maxBytes: number;
  /** Upper bound on the bytes kept for one owner (default: a quarter of `maxBytes`). */
  maxBytesPerOwner?: number;
  /** Public base URL; audio URLs are `<publicUrl>/audio/<id>.<ext>`. */
  publicUrl: string;
  logger: Logger;
  now?: () => number;
}

export interface StoredAudio {
  id: string;
  url: string;
  expiresAt: Date;
  /** The file on disk. */
  path: string;
}

export interface AudioFile {
  path: string;
  size: number;
  contentType: string;
  fileName: string;
}

/** Audio being written into the store. */
export interface AudioUpload {
  readonly sink: FileSink;
  /** Adds the finished file to the store and returns its link. */
  commit(): Promise<StoredAudio>;
  /** Deletes the partial file. */
  discard(): Promise<void>;
}

/** 16 random bytes, base64url: 22 characters. */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;
const PARTIAL_SUFFIX = '.part';

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
  /** Empty for files found on disk at startup (their owner is not recorded). */
  owner: string;
}

export class AudioStore {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly maxBytesPerOwner: number;
  /** Files on disk, oldest first. */
  private entries: Entry[] = [];
  private totalBytes = 0;
  private readonly ownerBytes = new Map<string, number>();
  private lock: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AudioStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.now = options.now ?? Date.now;
    this.maxBytesPerOwner = options.maxBytesPerOwner ?? Math.floor(options.maxBytes / 4);
  }

  /** Runs `work` alone: adds, sweeps and expiry removals never interleave. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work);
    this.lock = run.catch(() => undefined);
    return run;
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

  /** Bytes kept for one owner. */
  bytesFor(owner: string): number {
    return this.ownerBytes.get(owner) ?? 0;
  }

  private async reindex(): Promise<void> {
    const entries: Entry[] = [];
    for (const name of await readdir(this.directory)) {
      if (!this.parseName(name)) continue;
      const info = await stat(path.join(this.directory, name)).catch(() => undefined);
      if (info?.isFile()) entries.push({ name, size: info.size, mtime: info.mtimeMs, owner: '' });
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    this.entries = entries;
    this.totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    this.ownerBytes.clear();
  }

  private parseName(name: string): { id: string; ext: string } | undefined {
    const dot = name.indexOf('.');
    const id = name.slice(0, dot);
    const ext = name.slice(dot + 1);
    return dot > 0 && ID_PATTERN.test(id) && EXTENSION_PATTERN.test(ext) ? { id, ext } : undefined;
  }

  /** Forgets an entry and deletes its file. Idempotent: a second call does nothing. */
  private async remove(entry: Entry): Promise<void> {
    const index = this.entries.indexOf(entry);
    if (index === -1) return;
    this.entries.splice(index, 1);
    this.totalBytes -= entry.size;
    if (entry.owner) {
      const left = (this.ownerBytes.get(entry.owner) ?? 0) - entry.size;
      if (left > 0) this.ownerBytes.set(entry.owner, left);
      else this.ownerBytes.delete(entry.owner);
    }
    await rm(path.join(this.directory, entry.name), { force: true });
  }

  /** Deletes expired files, and partial files abandoned by a crash. */
  sweep(): Promise<number> {
    return this.exclusive(async () => {
      const cutoff = this.now() - this.options.ttlMs;
      const expired = this.entries.filter((e) => e.mtime <= cutoff);
      for (const entry of expired) await this.remove(entry);
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith(PARTIAL_SUFFIX)) continue;
        const info = await stat(path.join(this.directory, name)).catch(() => undefined);
        if (info && info.mtimeMs <= cutoff)
          await rm(path.join(this.directory, name), { force: true });
      }
      return expired.length;
    });
  }

  /** Starts storing audio for `owner`: write it to `sink`, then `commit`. */
  async begin(extension: string, owner: string): Promise<AudioUpload> {
    if (!EXTENSION_PATTERN.test(extension))
      throw new Error(`Unsupported audio extension: ${extension}`);
    const id = randomBytes(16).toString('base64url');
    const name = `${id}.${extension}`;
    const sink = await FileSink.create(
      path.join(this.directory, `${name}.${randomBytes(4).toString('hex')}${PARTIAL_SUFFIX}`),
      0o600,
    );
    return {
      sink,
      commit: async () => {
        await sink.close();
        try {
          return await this.exclusive(() => this.add(sink, name, owner));
        } catch (error) {
          await sink.discard();
          throw error;
        }
      },
      discard: () => sink.discard(),
    };
  }

  /** Makes room, then moves a finished file into the store. Runs exclusively. */
  private async add(sink: FileSink, name: string, owner: string): Promise<StoredAudio> {
    const size = sink.bytesWritten;
    if (size > this.options.maxBytes || size > this.maxBytesPerOwner) {
      throw new AudioTooLargeError(
        `The audio (${size} bytes) is larger than this server keeps (${Math.min(this.options.maxBytes, this.maxBytesPerOwner)} bytes per key).`,
      );
    }
    // The owner's own oldest links go first, then everyone's oldest.
    for (const entry of this.entries.filter((e) => e.owner === owner)) {
      if (this.bytesFor(owner) + size <= this.maxBytesPerOwner) break;
      await this.remove(entry);
    }
    while (this.totalBytes + size > this.options.maxBytes) {
      const [oldest] = this.entries;
      if (!oldest) break;
      await this.remove(oldest);
    }
    const finalPath = path.join(this.directory, name);
    await rename(sink.path, finalPath);
    const mtime = (await stat(finalPath)).mtimeMs;
    this.entries.push({ name, size, mtime, owner });
    this.totalBytes += size;
    this.ownerBytes.set(owner, this.bytesFor(owner) + size);
    return {
      id: name.slice(0, name.indexOf('.')),
      url: `${this.options.publicUrl}/audio/${name}`,
      expiresAt: new Date(mtime + this.options.ttlMs),
      path: finalPath,
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
      await this.exclusive(async () => {
        const entry = this.entries.find((e) => e.name === name);
        if (entry) await this.remove(entry);
        else await rm(filePath, { force: true });
      });
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
