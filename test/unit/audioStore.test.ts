import { mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AudioStore, AudioTooLargeError, type StoredAudio } from '../../src/http/audioStore.js';
import { silentLogger } from '../../src/log.js';

interface StoreOptions {
  ttlMs?: number;
  maxBytes?: number;
  maxBytesPerOwner?: number;
  now?: () => number;
}

async function makeStore(options: StoreOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bakbak-audio-'));
  const store = new AudioStore({
    directory,
    ttlMs: options.ttlMs ?? 60_000,
    maxBytes: options.maxBytes ?? 1000,
    ...(options.maxBytesPerOwner !== undefined && { maxBytesPerOwner: options.maxBytesPerOwner }),
    publicUrl: 'https://mcp.example',
    logger: silentLogger,
    ...(options.now && { now: options.now }),
  });
  await store.start(3_600_000);
  return { store, directory };
}

async function put(
  store: AudioStore,
  bytes: number,
  owner = 'k1',
  ext = 'wav',
): Promise<StoredAudio> {
  const upload = await store.begin(ext, owner);
  await upload.sink.write(new Uint8Array(bytes));
  return upload.commit();
}

async function bytesOnDisk(directory: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(directory))
    total += (await stat(path.join(directory, name))).size;
  return total;
}

describe('AudioStore', () => {
  it('stores audio under a 128-bit id and serves it until expiry', async () => {
    let now = Date.now();
    const { store } = await makeStore({ now: () => now });
    const stored = await put(store, 8);
    expect(stored.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(stored.url).toBe(`https://mcp.example/audio/${stored.id}.wav`);
    const file = await store.get(`${stored.id}.wav`);
    expect(file).toMatchObject({ size: 8, contentType: 'audio/wav' });
    expect(stored.expiresAt.getTime()).toBeGreaterThan(now);

    now += 61_000;
    expect(await store.get(`${stored.id}.wav`)).toBeUndefined();
    expect(store.bytesStored).toBe(0);
    store.stop();
  });

  it('refuses malformed names', async () => {
    const { store } = await makeStore();
    for (const name of ['../etc/passwd', 'short.wav', `${'a'.repeat(22)}.WAV`, 'a'.repeat(22)]) {
      expect(await store.get(name)).toBeUndefined();
    }
    store.stop();
  });

  it('sweeps expired files, including ones from before a restart', async () => {
    let now = Date.now();
    const { store, directory } = await makeStore({ now: () => now });
    const kept = await put(store, 10, 'k1', 'mp3');
    const stale = path.join(directory, `${'b'.repeat(22)}.wav`);
    await writeFile(stale, 'old');
    const past = new Date(now - 120_000);
    await utimes(stale, past, past);
    const restarted = new AudioStore({
      directory,
      ttlMs: 60_000,
      maxBytes: 1000,
      publicUrl: 'https://x',
      logger: silentLogger,
      now: () => now,
    });
    await restarted.start(3_600_000);
    expect(await readdir(directory)).toEqual([`${kept.id}.mp3`]);
    now += 61_000;
    expect(await restarted.sweep()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
    store.stop();
    restarted.stop();
  });

  it('evicts the oldest audio to stay under the size cap', async () => {
    const { store, directory } = await makeStore({ maxBytes: 100, maxBytesPerOwner: 100 });
    const first = await put(store, 40);
    const second = await put(store, 40);
    const third = await put(store, 40);
    expect(store.bytesStored).toBe(80);
    const names = await readdir(directory);
    expect(names).not.toContain(`${first.id}.wav`);
    expect(names.sort()).toEqual([`${second.id}.wav`, `${third.id}.wav`].sort());
    await expect(put(store, 101)).rejects.toThrow(AudioTooLargeError);
    expect(await readdir(directory)).toHaveLength(2); // the refused upload left nothing behind
    store.stop();
  });

  it('keeps the cap under concurrent writes (no drift)', async () => {
    const { store, directory } = await makeStore({ maxBytes: 1000, maxBytesPerOwner: 1000 });
    for (let round = 0; round < 20; round++) {
      await Promise.all(Array.from({ length: 8 }, () => put(store, 400)));
      expect(store.bytesStored).toBeLessThanOrEqual(1000);
      expect(await bytesOnDisk(directory)).toBe(store.bytesStored);
    }
    store.stop();
  });

  it('gives each key a quota, so one key cannot push out everyone else', async () => {
    const { store, directory } = await makeStore({ maxBytes: 1000, maxBytesPerOwner: 300 });
    const others = [await put(store, 100, 'alice'), await put(store, 100, 'bob')];
    for (let i = 0; i < 10; i++) await put(store, 100, 'mallory');
    expect(store.bytesFor('mallory')).toBe(300);
    const names = await readdir(directory);
    for (const kept of others) expect(names).toContain(`${kept.id}.wav`);
    await expect(put(store, 301, 'mallory')).rejects.toThrow(/per key/);
    store.stop();
  });

  it('deletes the partial file of a discarded upload', async () => {
    const { store, directory } = await makeStore();
    const upload = await store.begin('wav', 'k1');
    await upload.sink.write(new Uint8Array(10));
    expect((await readdir(directory)).some((n) => n.endsWith('.part'))).toBe(true);
    await upload.discard();
    expect(await readdir(directory)).toEqual([]);
    store.stop();
  });
});
