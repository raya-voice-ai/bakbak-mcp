import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { VERSION } from '../../src/version.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const json = (file: string) =>
  JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;

describe('release metadata', () => {
  const pkg = json('package.json');
  const manifest = json('manifest.json');
  const server = json('server.json') as {
    name: string;
    version: string;
    packages: { identifier: string; version: string }[];
  };

  it('has one version everywhere', () => {
    expect(VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages) expect(p.version).toBe(pkg.version);
  });

  it('ties the registry entry to the npm package', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toBe('io.github.raya-voice-ai/bakbak-mcp');
    expect(server.packages[0]?.identifier).toBe(pkg.name);
  });

  it('declares the bundle as a node server with a sensitive key', () => {
    expect(manifest.server).toMatchObject({ type: 'node', entry_point: 'server/index.js' });
    expect(manifest.user_config).toMatchObject({
      api_key: { sensitive: true },
      output_dir: { type: 'directory' },
    });
    expect((manifest.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
      'list_voices',
      'text_to_speech',
    ]);
  });
});

describe('conformance manifest', () => {
  const dir = path.join(root, 'conformance');
  const listed = new Map(
    readFileSync(path.join(dir, 'MANIFEST.sha256'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash = '', file = ''] = line.split(/\s+/);
        return [path.normalize(file), hash] as const;
      }),
  );

  function walk(sub: string): string[] {
    return readdirSync(path.join(dir, sub)).flatMap((name) => {
      const rel = path.join(sub, name);
      return statSync(path.join(dir, rel)).isDirectory() ? walk(rel) : [rel];
    });
  }

  it('matches every file, and lists every file', () => {
    const files = walk('.').filter((f) => f !== 'MANIFEST.sha256' && !f.includes('__pycache__'));
    expect(files.sort()).toEqual([...listed.keys()].sort());
    for (const [file, hash] of listed) {
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(dir, file)))
          .digest('hex'),
        file,
      ).toBe(hash);
    }
  });
});
