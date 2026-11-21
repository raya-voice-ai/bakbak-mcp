// Bundles the server (src/cli.ts and every dependency) into one ES module.
// Used by build-mcpb.mjs for the Claude Desktop bundle, and by the stdio test.

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
