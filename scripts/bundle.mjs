// Bundles the server (src/cli.ts and every dependency) into one ES module.
// Used by build-mcpb.mjs for the Claude Desktop bundle, and by the stdio test.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} outfile */
export async function bundleServer(outfile) {
  await build({
    entryPoints: [path.join(root, 'src', 'cli.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'external',
    // ws loads these native accelerators only if they are installed.
    external: ['bufferutil', 'utf-8-validate'],
    // CommonJS dependencies (ws) call require(); give the ES module one.
    banner: {
      js: "import { createRequire as __bakbakCreateRequire } from 'node:module'; const require = __bakbakCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}

/**
 * The server directory of the Claude Desktop bundle: `server/index.js`, an ES
 * module, with a `package.json` saying so (Node reads `.js` as CommonJS
 * otherwise).
 *
 * @param {string} dir
 */
export async function bundleMcpbServer(dir) {
  await mkdir(dir, { recursive: true });
  await bundleServer(path.join(dir, 'index.js'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ type: 'module', private: true }, null, 2) + '\n',
  );
}

// `node scripts/bundle.mjs <outfile>` (used by the Dockerfile).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundleServer(path.resolve(process.argv[2] ?? 'dist-bundle/server.mjs'));
}
