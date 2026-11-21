import { mkdtemp, mkdir, readFile, readlink, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  OutputPathError,
  buildFileName,
  compactTimestamp,
  defaultOutputDir,
  resolveOutputDir,
  resolveOutputPath,
  writeAudioFile,
} from '../../src/local/files.js';

describe('output directory', () => {
  it('uses ~/Documents/Bakbak when ~/Documents exists, else ~/Bakbak', () => {
    expect(defaultOutputDir('/home/u', () => true)).toBe(
      path.join('/home/u', 'Documents', 'Bakbak'),
    );
    expect(defaultOutputDir('/home/u', () => false)).toBe(path.join('/home/u', 'Bakbak'));
  });

  it('expands ~ and makes BAKBAK_MCP_OUTPUT_DIR absolute', () => {
    expect(resolveOutputDir('~/audio', '/home/u')).toBe(path.join('/home/u', 'audio'));
    expect(resolveOutputDir('/srv/out', '/home/u')).toBe('/srv/out');
    expect(path.isAbsolute(resolveOutputDir('rel/dir', '/home/u'))).toBe(true);
  });
});

describe('file names', () => {
  const date = new Date('2026-11-21T14:32:05.123Z');

  it('is <language>_<voice>_<UTC timestamp>_<6 random>.<ext>', () => {
    expect(compactTimestamp(date)).toBe('20261121T143205Z');
    expect(
      buildFileName({
        language: 'hi',
        voiceName: 'Anika M1',
        voiceId: 'x',
        extension: 'wav',
        date,
        random: 'abc123',
      }),
    ).toBe('hi_Anika-M1_20261121T143205Z_abc123.wav');
  });

  it('falls back to the voice id and generates the random part', () => {
    const name = buildFileName({
      language: 'en-in',
      voiceName: undefined,
      voiceId: '009ae8b5-4a03',
      extension: 'mp3',
      date,
    });
    expect(name).toMatch(/^en-in_009ae8b5-4a03_20261121T143205Z_[a-z0-9]{6}\.mp3$/);
  });

  it('cannot be steered out of the directory by the language or voice name', () => {
    const name = buildFileName({
      language: '../../etc',
      voiceName: '../../passwd',
      voiceId: 'x',
      extension: 'wav',
      date,
      random: 'aaaaaa',
    });
    expect(name).toBe('etc_passwd_20261121T143205Z_aaaaaa.wav');
    expect(name).not.toContain('/');
  });
});

describe('output_path', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bakbak-files-'));
  });

  it('accepts an absolute path with the right extension in an existing directory', async () => {
    const target = path.join(dir, 'speech.wav');
    await expect(
      resolveOutputPath({ outputDir: '/elsewhere', outputPath: target, extensions: ['wav'] }),
    ).resolves.toBe(target);
  });

  it('resolves relative paths inside the output directory', async () => {
    await mkdir(path.join(dir, 'sub'));
    await expect(
      resolveOutputPath({ outputDir: dir, outputPath: 'sub/a.mp3', extensions: ['mp3'] }),
    ).resolves.toBe(path.join(dir, 'sub', 'a.mp3'));
  });

  it.each(['../escape.wav', 'sub/../../escape.wav', '..', '.'])(
    'refuses traversal: %s',
    async (p) => {
      await expect(
        resolveOutputPath({ outputDir: dir, outputPath: p, extensions: ['wav'] }),
      ).rejects.toThrow(OutputPathError);
    },
  );

  it('allows names that merely start with two dots', async () => {
    await expect(
      resolveOutputPath({ outputDir: dir, outputPath: '..notes.wav', extensions: ['wav'] }),
    ).resolves.toBe(path.join(dir, '..notes.wav'));
  });

  it('refuses the wrong extension, a missing directory, and NUL bytes', async () => {
    await expect(
      resolveOutputPath({ outputDir: dir, outputPath: 'a.mp3', extensions: ['wav'] }),
    ).rejects.toThrow(/\.wav/);
    await expect(
      resolveOutputPath({
        outputDir: dir,
        outputPath: path.join(dir, 'nope', 'a.wav'),
        extensions: ['wav'],
      }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      resolveOutputPath({ outputDir: dir, outputPath: 'a\0.wav', extensions: ['wav'] }),
    ).rejects.toThrow(OutputPathError);
  });

  it('never overwrites without overwrite, and replaces atomically with it', async () => {
    const target = path.join(dir, 'a.wav');
    await writeAudioFile(target, Buffer.from('one'), false);
    await expect(writeAudioFile(target, Buffer.from('two'), false)).rejects.toThrow(
      /already exists/,
    );
    expect(await readFile(target, 'utf8')).toBe('one');
    await writeAudioFile(target, Buffer.from('two'), true);
    expect(await readFile(target, 'utf8')).toBe('two');
  });

  it('replaces a symlink at the target instead of writing through it', async () => {
    const victim = path.join(dir, 'victim.txt');
    await writeFile(victim, 'keep');
    const link = path.join(dir, 'link.wav');
    await symlink(victim, link);
    await expect(writeAudioFile(link, Buffer.from('audio'), false)).rejects.toThrow(
      /already exists/,
    );
    expect(await readlink(link)).toBe(victim);
    await writeAudioFile(link, Buffer.from('audio'), true);
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(victim, 'utf8')).toBe('keep');
  });
});

describe('environment values', () => {
  it('treats empty values and unexpanded host placeholders as unset', async () => {
    const { envValue } = await import('../../src/local/stdio.js');
    expect(envValue(undefined)).toBeUndefined();
    expect(envValue('  ')).toBeUndefined();
    expect(envValue('${user_config.output_dir}')).toBeUndefined();
    expect(envValue(' /tmp/x ')).toBe('/tmp/x');
    expect(envValue('key-with-${dollar}')).toBe('key-with-${dollar}');
  });
});
