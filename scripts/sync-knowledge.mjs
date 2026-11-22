// Copies the upstream pages of the developer documentation pack into
// knowledge/upstream/: the SDK and plugin READMEs, their examples, and three
// pages of the documentation site (https://docs.bakbak.si, Fern). Each file gets
// a small front matter (id, title, description, url) that build-knowledge.mjs
// reads. Links to the documentation site's old address (docs.litwizlabs.com)
// are rewritten to their pages on docs.bakbak.si.
//
//   node scripts/sync-knowledge.mjs            from sibling checkouts, at origin/main
//   node scripts/sync-knowledge.mjs --check    exit 1 if knowledge/upstream/ is out of date
//   node scripts/sync-knowledge.mjs --remote   public repositories from GitHub instead
//                                              (the documentation site's source is private
//                                              and is skipped)
//
// Checkouts default to ../bakbak-python, ../bakbak-js, ../livekit-plugins-bakbak and
// ../bakbak-docs; override with BAKBAK_PYTHON_DIR, BAKBAK_JS_DIR, LIVEKIT_PLUGIN_DIR and
// BAKBAK_DOCS_DIR. KNOWLEDGE_REF picks the git ref (default origin/main): committed
// content only. BAKBAK_DOCS_REF overrides it for the documentation site; its value
// `worktree` reads the checkout's files as they are, for pages not yet committed.
//
// Run `npm run knowledge:build` afterwards to regenerate the bundled pack.

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'knowledge', 'upstream');
const check = process.argv.includes('--check');
const remote = process.argv.includes('--remote');
const ref = process.env.KNOWLEDGE_REF ?? 'origin/main';
const DOCS_SITE = 'https://docs.bakbak.si';

const repos = {
  python: {
    dir: process.env.BAKBAK_PYTHON_DIR ?? '../bakbak-python',
    github: 'raya-voice-ai/bakbak-python',
  },
  js: { dir: process.env.BAKBAK_JS_DIR ?? '../bakbak-js', github: 'raya-voice-ai/bakbak-js' },
  livekit: {
    dir: process.env.LIVEKIT_PLUGIN_DIR ?? '../livekit-plugins-bakbak',
    github: 'raya-voice-ai/livekit-plugins-bakbak',
  },
  docs: {
    dir: process.env.BAKBAK_DOCS_DIR ?? '../bakbak-docs',
    github: undefined,
    ref: process.env.BAKBAK_DOCS_REF,
  },
};

/**
 * Pages of the old documentation site and their paths on docs.bakbak.si (from
 * the site's fern/redirects.yml), so links in the READMEs land on the new site.
 */
const MOVED = {
  '': '',
  '/documentation/tts-overview': '/text-to-speech/overview',
  '/documentation/tts-getting-started': '/get-started/tts-quickstart',
  '/documentation/tts-features': '/text-to-speech/features',
  '/documentation/tts-output-formats': '/text-to-speech/output-formats',
  '/documentation/tts-errors': '/text-to-speech/errors',
  '/documentation/tts-use-cases': '/text-to-speech/use-cases',
  '/documentation/tts-best-practices': '/text-to-speech/best-practices',
  '/documentation/sdk-python': '/sdks/python',
  '/documentation/sdk-javascript': '/sdks/javascript',
  '/documentation/tts-livekit': '/integrations/livekit',
  '/documentation/tts-mcp': '/integrations/mcp',
  '/api-reference/tts-websocket': '/text-to-speech/websocket',
  '/api-reference/text-to-speech/text-to-speech': '/api-reference/text-to-speech/create-speech',
  '/api-reference/text-to-speech/text-to-speech-stream':
    '/api-reference/text-to-speech/stream-speech',
  '/api-reference/voices/list-voices': '/api-reference/voices/list-voices',
};

/** Fern's `api:METHOD/path` links, as pages of the API reference. */
const API_LINKS = {
  'POST/v1/text-to-speech': '/api-reference/text-to-speech/create-speech',
  'POST/v1/text-to-speech/stream': '/api-reference/text-to-speech/stream-speech',
  'GET/v1/voices': '/api-reference/voices/list-voices',
};

/** @param {string} text */
export function moveDocsLinks(text) {
  return text.replace(
    /https:\/\/docs\.litwizlabs\.com((?:\/[A-Za-z0-9._-]+)*)(#[A-Za-z0-9_-]*)?/g,
    (match, pagePath, anchor = '') => {
      const moved = MOVED[pagePath];
      if (moved === undefined) {
        throw new Error(`no docs.bakbak.si page for ${match}: add it to MOVED`);
      }
      return DOCS_SITE + moved + anchor;
    },
  );
}

/**
 * @typedef {{ id: string, title: string, description: string, repo: keyof typeof repos,
 *   path: string, url: string, transform: (text: string, source: Source) => string }} Source
 */

const readme = (text) => text;
const mdx = (text) => mdxToMarkdown(text);

/** @param {string} lang @param {string} note */
const example = (lang, note) => (text, source) =>
  [
    `# ${source.id}`,
    '',
    note,
    '',
    `Source: ${source.url}`,
    '',
    '```' + lang,
    text.replace(/\n+$/, ''),
    '```',
    '',
  ].join('\n');

/** @type {Source[]} */
const SOURCES = [
  {
    id: 'python-sdk',
    title: 'Python SDK reference (bakbak-python)',
    description:
      'The Python SDK README: install, configuration, whole files, SSE streaming, the WebSocket (contexts, send_stream, cancel), voices, segmentation, errors, retries, latency tips.',
    repo: 'python',
    path: 'README.md',
    url: 'https://github.com/raya-voice-ai/bakbak-python#readme',
    transform: readme,
  },
  {
    id: 'javascript-sdk',
    title: 'JavaScript SDK reference (bakbak on npm)',
    description:
      'The JavaScript/TypeScript SDK README: install, whole files, SSE streaming, the WebSocket (contexts, sendStream, cancel, telephony), segmentation, formats, configuration, errors, retries, runtimes and browsers.',
    repo: 'js',
    path: 'README.md',
    url: 'https://github.com/raya-voice-ai/bakbak-js#readme',
    transform: readme,
  },
  {
    id: 'livekit-plugin',
    title: 'LiveKit Agents plugin reference (livekit-plugins-bakbak)',
    description:
      'The LiveKit plugin README: install, quickstart, every bakbak.TTS option, voices, language codes, WebSocket and HTTP transports, sentence tokenizer, errors and retries, migration from livekit-plugins-raya.',
    repo: 'livekit',
    path: 'README.md',
    url: 'https://github.com/raya-voice-ai/livekit-plugins-bakbak#readme',
    transform: readme,
  },
  {
    id: 'websocket-api',
    title: 'WebSocket API reference',
    description:
      'The /v1/text-to-speech/ws protocol: connecting, request messages and context_id, chunk/done/error/cancelled messages, cancel, limits, close codes, Python and Node examples.',
    repo: 'docs',
    path: 'fern/docs/pages/text-to-speech/websocket.mdx',
    url: `${DOCS_SITE}/text-to-speech/websocket`,
    transform: mdx,
  },
  {
    id: 'errors',
    title: 'Errors and error codes',
    description:
      'Every error_code with its HTTP status, when it happens, whether to retry and what to do; error body examples; gateway errors.',
    repo: 'docs',
    path: 'fern/docs/pages/text-to-speech/errors.mdx',
    url: `${DOCS_SITE}/text-to-speech/errors`,
    transform: mdx,
  },
  {
    id: 'output-formats',
    title: 'Output formats',
    description:
      'output_format: containers, encodings (pcm_s16le, pcm_f32le, μ-law, A-law), sample rates, common choices, streaming and non-streaming examples.',
    repo: 'docs',
    path: 'fern/docs/pages/text-to-speech/output-formats.mdx',
    url: `${DOCS_SITE}/text-to-speech/output-formats`,
    transform: mdx,
  },
  ...[
    ['quickstart.py', 'List voices, synthesize a whole file and save it.'],
    ['streaming.py', 'Stream one request over SSE and write the audio as it arrives.'],
    ['websocket_contexts.py', 'Two contexts on one WebSocket, running at the same time.'],
    ['llm_streaming.py', "Speak an LLM's reply while it is still being written (send_stream)."],
    ['telephony.py', '8 kHz μ-law for phone calls over the WebSocket.'],
    ['bench_ttfa.py', 'Measure time to first audio: SSE against the WebSocket.'],
    ['_settings.py', 'Settings shared by the Python examples (voice, language, model).'],
  ].map(([file, note]) => ({
    id: `examples/python/${file}`,
    title: `Python example: ${file}`,
    description: note,
    repo: /** @type {const} */ ('python'),
    path: `examples/${file}`,
    url: `https://github.com/raya-voice-ai/bakbak-python/blob/main/examples/${file}`,
    transform: example('python', `A runnable example from bakbak-python. ${note}`),
  })),
  ...[
    ['quickstart.ts', 'List voices, synthesize, save a WAV.'],
    ['stream-to-file.ts', 'SSE streaming to a file, with time to first audio.'],
    ['websocket-contexts.ts', 'Two contexts on one WebSocket.'],
    ['llm-tokens.ts', "Speak an LLM's reply as it is written (sendStream)."],
    ['telephony-mulaw.ts', '8 kHz μ-law for telephony over the WebSocket.'],
    ['bench-ttfa.ts', 'Time to first audio, p50/p95, SSE against the WebSocket.'],
    ['_env.ts', 'Settings shared by the JavaScript examples.'],
  ].map(([file, note]) => ({
    id: `examples/javascript/${file}`,
    title: `JavaScript example: ${file}`,
    description: note,
    repo: /** @type {const} */ ('js'),
    path: `examples/${file}`,
    url: `https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/${file}`,
    transform: example('ts', `A runnable example from the bakbak npm package. ${note}`),
  })),
  ...[
    [
      'agent.py',
      'A complete Hindi LiveKit voice agent: Deepgram STT, an OpenAI LLM and Bakbak TTS.',
    ],
    ['synthesize_to_wav.py', 'Use the plugin outside a room: synthesize to a WAV file.'],
  ].map(([file, note]) => ({
    id: `examples/livekit/${file}`,
    title: `LiveKit example: ${file}`,
    description: note,
    repo: /** @type {const} */ ('livekit'),
    path: `examples/${file}`,
    url: `https://github.com/raya-voice-ai/livekit-plugins-bakbak/blob/main/examples/${file}`,
    transform: example('python', `A runnable example from livekit-plugins-bakbak. ${note}`),
  })),
];

/** @param {Source} source @returns {Promise<string | undefined>} */
async function readSource(source) {
  const repo = repos[source.repo];
  if (remote) {
    if (!repo.github) return undefined;
    const url = `https://raw.githubusercontent.com/${repo.github}/main/${source.path}`;
    const res = await fetch(url, { redirect: 'error' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.text();
  }
  const dir = path.resolve(root, repo.dir);
  if (repo.ref === 'worktree') return await readFile(path.join(dir, source.path), 'utf8');
  const at = repo.ref ?? ref;
  try {
    return execFileSync('git', ['-C', dir, 'show', `${at}:${source.path}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    const hint =
      source.repo === 'docs'
        ? ' Merge it there, or set BAKBAK_DOCS_REF=worktree to read the checkout.'
        : '';
    throw new Error(`${source.path} is not at ${at} in ${dir}.${hint}`);
  }
}

/** Front matter values are single lines; build-knowledge.mjs parses `key: value`. */
function frontMatter(fields) {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`front matter ${k} has a line break`);
    return `${k}: ${v}`;
  });
  return ['---', ...lines, '---', ''].join('\n');
}

/** @param {string} id */
function fileFor(id) {
  return path.join(outDir, id.replaceAll('/', '__') + '.md');
}

/**
 * The documentation site is Mintlify MDX. Turn it into plain Markdown: front
 * matter becomes a heading and a summary, callouts become block quotes, cards
 * become links, code groups are unwrapped, and site-relative links get the
 * site's origin.
 *
 * @param {string} text
 */
export function mdxToMarkdown(text) {
  let body = text.replace(/\r\n/g, '\n');
  let title = '';
  let description = '';
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (fm) {
    body = body.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = /^(\w+):\s*"?(.*?)"?\s*$/.exec(line);
      if (m?.[1] === 'title') title = m[2];
      // Mintlify called the summary `description`; Fern calls it `subtitle`.
      if (m?.[1] === 'description' || m?.[1] === 'subtitle') description = m[2];
    }
  }
  body = body
    .replace(/<\/?CodeGroup>\n?/g, '')
    .replace(/<\/?CardGroup[^>]*>\n?/g, '')
    .replace(
      /<Card\s+title="([^"]*)"[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/Card>/g,
      (_, t, href, inner) => `- [${t}](${href}): ${inner.trim().replace(/\s+/g, ' ')}`,
    )
    .replace(/<(Tip|Note|Warning|Info|Check)>\n?([\s\S]*?)\n?<\/\1>/g, (_, kind, inner) =>
      inner
        .trim()
        .split('\n')
        .map((line, i) => (i === 0 ? `> **${kind}:** ${line.trim()}` : `> ${line.trim()}`))
        .join('\n'),
    )
    .replace(/\]\(api:([A-Z]+\/[^)\s]*)\)/g, (match, endpoint) => {
      const page = API_LINKS[endpoint];
      if (page === undefined)
        throw new Error(`no API reference page for ${match}: add it to API_LINKS`);
      return `](${DOCS_SITE}${page})`;
    })
    .replace(/\]\(\/(?!\/)/g, `](${DOCS_SITE}/`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const head = [];
  if (title && !/^# /m.test(body.split('\n').find((l) => l.trim() !== '') ?? '')) {
    head.push(`# ${title}`, '');
  }
  if (description) head.push(description, '');
  return (head.length > 0 ? head.join('\n') + '\n' : '') + body + '\n';
}

const wanted = new Map();
for (const source of SOURCES) {
  const text = await readSource(source);
  if (text === undefined) {
    console.warn(`skipped ${source.id}: ${source.repo} is not public`);
    continue;
  }
  const content =
    frontMatter({
      id: source.id,
      title: source.title,
      description: source.description,
      url: source.url,
    }) +
    '\n' +
    moveDocsLinks(source.transform(text, source));
  wanted.set(fileFor(source.id), content);
}

if (check) {
  let stale = 0;
  for (const [file, content] of wanted) {
    const current = await readFile(file, 'utf8').catch(() => undefined);
    if (current !== content) {
      console.error(`out of date: ${path.relative(root, file)}`);
      stale++;
    }
  }
  if (stale > 0) {
    console.error(`${stale} upstream page(s) changed; run npm run knowledge:sync`);
    process.exit(1);
  }
  console.log(`knowledge/upstream is up to date (${wanted.size} pages)`);
} else {
  if (!remote) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const [file, content] of wanted) await writeFile(file, content);
  const files = await readdir(outDir);
  console.log(`wrote ${wanted.size} pages to knowledge/upstream (${files.length} files)`);
}
