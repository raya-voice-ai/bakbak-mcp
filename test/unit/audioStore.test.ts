import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AudioStore, AudioTooLargeError } from '../../src/http/audioStore.js';
import { silentLogger } from '../../src/log.js';

async function makeStore(options: { ttlMs?: number; maxBytes?: number; now?: () => number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bakbak-audio-'));
  const store = new AudioStore({
    directory,
    ttlMs: options.ttlMs ?? 60_000,
    maxBytes: options.maxBytes ?? 1000,
    publicUrl: 'https://mcp.example',
    logger: silentLogger,
    ...(options.now && { now: options.now }),
  });
  await store.start(3_600_000);
  return { store, directory };
}

describe('AudioStore', () => {
  it('stores audio under a 128-bit id and serves it until expiry', async () => {
    let now = Date.now();
    const { store } = await makeStore({ now: () => now });
    const stored = await store.put(Buffer.from('RIFFdata'), 'wav');
    expect(stored.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(stored.url).toBe(`https://mcp.example/audio/${stored.id}.wav`);
    const file = await store.get(`${stored.id}.wav`);
    expect(file).toMatchObject({ size: 8, contentType: 'audio/wav' });
    expect(stored.expiresAt.getTime()).toBeGreaterThan(now);

    now += 61_000;
    expect(await store.get(`${stored.id}.wav`)).toBeUndefined();
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
    const kept = await store.put(Buffer.alloc(10), 'mp3');
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
    const { store, directory } = await makeStore({ maxBytes: 100 });
    const first = await store.put(Buffer.alloc(40), 'wav');
    const second = await store.put(Buffer.alloc(40), 'wav');
    const third = await store.put(Buffer.alloc(40), 'wav');
    expect(store.bytesStored).toBe(80);
    const names = await readdir(directory);
    expect(names).not.toContain(`${first.id}.wav`);
    expect(names.sort()).toEqual([`${second.id}.wav`, `${third.id}.wav`].sort());
    await expect(store.put(Buffer.alloc(101), 'wav')).rejects.toThrow(AudioTooLargeError);
    store.stop();
  });
});
