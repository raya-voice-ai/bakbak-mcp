// Builds src/knowledge/pages.generated.ts, the developer documentation bundled
// with the server (search_docs, read_docs, and the bakbak://docs/ resources),
// from:
//
//   knowledge/guides/*.md     integration guides written for this pack
//   knowledge/upstream/*.md   SDK and plugin READMEs, examples and API pages,
//                             copied by scripts/sync-knowledge.mjs
//   conformance/BEHAVIOR.md   the client behaviour contract
//   README.md                 this server's own documentation
//
//   node scripts/build-knowledge.mjs           write the file
//   node scripts/build-knowledge.mjs --check   exit 1 if it is out of date (CI)

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'src', 'knowledge', 'pages.generated.ts');
const REPO = 'https://github.com/raya-voice-ai/bakbak-mcp/blob/main';

/** Guides in reading order; every file in knowledge/guides must be listed. */
const GUIDE_ORDER = [
  'start-here',
  'best-practices',
  'livekit',
  'pipecat',
  'telephony',
  'voice-agents',
  'web',
  'long-form',
  'raw-api',
  'troubleshooting',
];

/** References in reading order; examples follow, sorted by id. */
const REFERENCE_ORDER = [
  'python-sdk',
  'javascript-sdk',
  'livekit-plugin',
  'websocket-api',
  'errors',
  'output-formats',
  'client-behavior',
  'mcp-server',
];

/** @param {string} text @param {string} file */
function parseFrontMatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) throw new Error(`${file}: no front matter`);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: bad front matter line: ${line}`);
    fields[kv[1]] = kv[2].trim();
  }
  for (const key of ['id', 'title', 'description']) {
    if (!fields[key]) throw new Error(`${file}: front matter needs ${key}`);
  }
  return { fields, body: text.replace(/\r\n/g, '\n').slice(match[0].length).trim() + '\n' };
}

async function guides() {
  const dir = path.join(root, 'knowledge', 'guides');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  const pages = [];
  for (const file of files) {
    const { fields, body } = parseFrontMatter(await readFile(path.join(dir, file), 'utf8'), file);
    if (`${fields.id}.md` !== file)
      throw new Error(`${file}: id ${fields.id} does not match the file name`);
    if (!GUIDE_ORDER.includes(fields.id))
      throw new Error(`${file}: add ${fields.id} to GUIDE_ORDER`);
    pages.push({
      id: fields.id,
      kind: 'guide',
      title: fields.title,
      description: fields.description,
      url: `${REPO}/knowledge/guides/${file}`,
      markdown: body,
    });
  }
  return pages.sort((a, b) => GUIDE_ORDER.indexOf(a.id) - GUIDE_ORDER.indexOf(b.id));
}

async function upstream() {
  const dir = path.join(root, 'knowledge', 'upstream');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  return Promise.all(
    files.map(async (file) => {
      const { fields, body } = parseFrontMatter(await readFile(path.join(dir, file), 'utf8'), file);
      if (!fields.url) throw new Error(`${file}: front matter needs url`);
      return {
        id: fields.id,
        kind: fields.id.startsWith('examples/') ? 'example' : 'reference',
        title: fields.title,
        description: fields.description,
        url: fields.url,
        markdown: body,
      };
    }),
  );
}

async function local() {
  const behavior = await readFile(path.join(root, 'conformance', 'BEHAVIOR.md'), 'utf8');
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  return [
    {
      id: 'client-behavior',
      kind: 'reference',
      title: 'Client behaviour specification',
      description:
        'The contract every official Bakbak client follows: the API in one page, naming across SDKs, error classes and messages, retries and the rule about audio, SSE parsing, the WebSocket client (contexts, cancel, reconnects, draining), segmentation, privacy.',
      url: 'https://github.com/raya-voice-ai/bakbak-mcp/blob/main/conformance/BEHAVIOR.md',
      markdown: behavior.replace(/\r\n/g, '\n').trim() + '\n',
    },
    {
      id: 'mcp-server',
      kind: 'reference',
      title: 'Bakbak MCP server (this server)',
      description:
        'Setting up bakbak-mcp in Claude Desktop, Claude Code, claude.ai, Cursor, VS Code and Windsurf; its tools; configuration; errors; privacy; self-hosting.',
      url: 'https://github.com/raya-voice-ai/bakbak-mcp#readme',
      markdown: readme.replace(/\r\n/g, '\n').trim() + '\n',
    },
  ];
}

const all = [...(await guides()), ...(await upstream()), ...(await local())];
const ids = new Set();
for (const page of all) {
  if (ids.has(page.id)) throw new Error(`duplicate page id ${page.id}`);
  ids.add(page.id);
}
for (const id of REFERENCE_ORDER) {
  if (!ids.has(id)) throw new Error(`missing reference page ${id}; run npm run knowledge:sync`);
}
const rank = (page) =>
  page.kind === 'guide'
    ? GUIDE_ORDER.indexOf(page.id)
    : page.kind === 'reference'
      ? 100 + REFERENCE_ORDER.indexOf(page.id)
      : 1000;
const pages = all.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

const source = [
  '// Generated by scripts/build-knowledge.mjs. Do not edit: change knowledge/, README.md',
  '// or conformance/BEHAVIOR.md, then run `npm run knowledge:build`.',
  '',
  "import type { KnowledgePage } from './types.js';",
  '',
  `export const PAGES: readonly KnowledgePage[] = ${JSON.stringify(pages, null, 2)};`,
  '',
].join('\n');

if (process.argv.includes('--check')) {
  const current = await readFile(outFile, 'utf8').catch(() => '');
  if (current !== source) {
    console.error(
      'src/knowledge/pages.generated.ts is out of date: run npm run knowledge:build and commit it',
    );
    process.exit(1);
  }
  console.log(`src/knowledge/pages.generated.ts is up to date (${pages.length} pages)`);
} else {
  await writeFile(outFile, source);
  const kb = Math.round(Buffer.byteLength(source) / 1024);
  console.log(`wrote src/knowledge/pages.generated.ts: ${pages.length} pages, ${kb} KiB`);
}
