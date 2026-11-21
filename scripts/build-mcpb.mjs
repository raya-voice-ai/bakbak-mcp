// Builds the MCP Bundle (.mcpb) for Claude Desktop: the server bundled into a
// single ES module with esbuild (no node_modules to ship), plus manifest.json,
// the icon and the license. Then validates and packs it with the official
// mcpb CLI.
//
//   node scripts/build-mcpb.mjs            -> bakbak-mcp-<version>.mcpb
//   node scripts/build-mcpb.mjs --no-pack  -> only the mcpb-build/ directory

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleServer } from './bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'mcpb-build');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'server'), { recursive: true });

await bundleServer(path.join(out, 'server', 'index.js'));

await writeFile(
  path.join(out, 'server', 'package.json'),
  JSON.stringify({ type: 'module', private: true }, null, 2) + '\n',
);
await cp(path.join(root, 'manifest.json'), path.join(out, 'manifest.json'));
await cp(path.join(root, 'assets', 'icon.png'), path.join(out, 'icon.png'));
await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

const mcpb = (args) =>
  execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', ...args], {
    cwd: root,
    stdio: 'inherit',
  });

mcpb(['validate', path.join(out, 'manifest.json')]);
if (!process.argv.includes('--no-pack')) {
  mcpb(['pack', out, path.join(root, `bakbak-mcp-${pkg.version}.mcpb`)]);
}
