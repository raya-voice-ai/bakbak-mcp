/**
 * The developer documentation bundled with the server: integration guides,
 * the SDK and plugin references, API pages and runnable examples. Built at
 * development time (scripts/build-knowledge.mjs), so it needs no network and
 * matches this release.
 */

import { PAGES } from './pages.generated.js';
import { type Hit, SectionIndex, snippet, slug, stripInline } from './search.js';
import type { KnowledgePage } from './types.js';

export type { KnowledgePage } from './types.js';

/** Names people (and models) use for pages, mapped to page ids. */
const ALIASES: Record<string, string> = {
  index: '',
  contents: '',
  toc: '',
  start: 'start-here',
  overview: 'start-here',
  'getting-started': 'start-here',
  quickstart: 'start-here',
  'best-practice': 'best-practices',
  practices: 'best-practices',
  python: 'python-sdk',
  'bakbak-python': 'python-sdk',
  py: 'python-sdk',
  javascript: 'javascript-sdk',
  js: 'javascript-sdk',
  typescript: 'javascript-sdk',
  ts: 'javascript-sdk',
  node: 'javascript-sdk',
  nodejs: 'javascript-sdk',
  npm: 'javascript-sdk',
  'livekit-plugins-bakbak': 'livekit-plugin',
  'livekit-agents': 'livekit',
  websocket: 'websocket-api',
  ws: 'websocket-api',
  error: 'errors',
  'error-codes': 'errors',
  formats: 'output-formats',
  'output-format': 'output-formats',
  output_format: 'output-formats',
  behavior: 'client-behavior',
  behaviour: 'client-behavior',
  spec: 'client-behavior',
  conformance: 'client-behavior',
  mcp: 'mcp-server',
  'bakbak-mcp': 'mcp-server',
  twilio: 'telephony',
  plivo: 'telephony',
  exotel: 'telephony',
  vonage: 'telephony',
  sip: 'telephony',
  asterisk: 'telephony',
  freeswitch: 'telephony',
  phone: 'telephony',
  ivr: 'telephony',
  agents: 'voice-agents',
  'voice-agent': 'voice-agents',
  browser: 'web',
  nextjs: 'web',
  'next.js': 'web',
  react: 'web',
  mobile: 'web',
  ios: 'web',
  android: 'web',
  flutter: 'web',
  'react-native': 'web',
  serverless: 'web',
  workers: 'web',
  go: 'raw-api',
  golang: 'raw-api',
  java: 'raw-api',
  kotlin: 'raw-api',
  csharp: 'raw-api',
  dotnet: 'raw-api',
  ruby: 'raw-api',
  php: 'raw-api',
  rust: 'raw-api',
  dart: 'raw-api',
  elixir: 'raw-api',
  rest: 'raw-api',
  http: 'raw-api',
  sse: 'raw-api',
  curl: 'raw-api',
  api: 'raw-api',
  batch: 'long-form',
  narration: 'long-form',
  audiobook: 'long-form',
  'long-text': 'long-form',
  debug: 'troubleshooting',
  faq: 'troubleshooting',
};

export interface SearchResult {
  page: string;
  title: string;
  section: string;
  url: string;
  snippet: string;
}

export class Knowledge {
  readonly pages: readonly KnowledgePage[];
  #byId: Map<string, KnowledgePage>;
  #index: SectionIndex | undefined;

  constructor(pages: readonly KnowledgePage[] = PAGES) {
    this.pages = pages;
    this.#byId = new Map(pages.map((p) => [p.id, p]));
  }

  /** Built on first use, so servers that never search pay nothing. */
  get #sections(): SectionIndex {
    this.#index ??= new SectionIndex(this.pages);
    return this.#index;
  }

  /**
   * The page a name refers to: its id (any case, with or without `.md` or a
   * `bakbak://docs/` prefix), an alias such as `python` or `twilio`, an
   * example's file name, or its exact title. `null` means the index.
   */
  find(name: string): KnowledgePage | null | undefined {
    const key = name
      .trim()
      .replace(/^bakbak:\/\/docs\//i, '')
      .replace(/\.md$/i, '')
      .replace(/^\/+|\/+$/g, '');
    if (key === '') return null;
    const lower = key.toLowerCase();
    const exact = this.#byId.get(key) ?? this.pages.find((p) => p.id.toLowerCase() === lower);
    if (exact) return exact;
    const alias = ALIASES[lower] ?? ALIASES[lower.replace(/[\s_]+/g, '-')];
    if (alias !== undefined) return alias === '' ? null : this.#byId.get(alias);
    const byFile = this.pages.filter(
      (p) => p.kind === 'example' && p.id.toLowerCase().endsWith(`/${lower}`),
    );
    if (byFile.length === 1) return byFile[0];
    return this.pages.find((p) => p.title.toLowerCase() === lower);
  }

  /** Ids of pages close to a name that matched nothing, for the error message. */
  suggest(name: string, limit = 5): string[] {
    const lower = name.toLowerCase();
    const ids = this.pages
      .filter((p) => p.id.toLowerCase().includes(lower) || lower.includes(p.id.toLowerCase()))
      .map((p) => p.id);
    for (const hit of this.#sections.search(name, { limit: 10, perPage: 1 })) {
      if (!ids.includes(hit.section.page.id)) ids.push(hit.section.page.id);
    }
    return ids.slice(0, limit);
  }

  /** The headings of a page, indented by level, for "section not found". */
  outline(page: KnowledgePage): string[] {
    return this.#sections.sections
      .filter((s) => s.page === page && s.level > 1)
      .map((s) => `${'  '.repeat(Math.max(0, s.level - 2))}- ${s.heading}`);
  }

  /**
   * A section of a page with its subsections, matched by heading text (exact,
   * then as a slug, then contained), or undefined.
   */
  section(page: KnowledgePage, heading: string): { heading: string; markdown: string } | undefined {
    const sections = this.#sections.sections.filter((s) => s.page === page && s.level > 0);
    const wanted = stripInline(heading).toLowerCase().replace(/^#+\s*/, '');
    const wantedSlug = slug(heading.replace(/^#/, ''));
    const match =
      sections.find((s) => s.heading.toLowerCase() === wanted) ??
      sections.find((s) => slug(s.heading) === wantedSlug) ??
      sections.find((s) => s.heading.toLowerCase().includes(wanted));
    if (!match) return undefined;
    const lines = page.markdown.split('\n').slice(match.start, match.endWithChildren);
    return { heading: match.heading, markdown: lines.join('\n').trim() + '\n' };
  }

  search(query: string, limit: number): SearchResult[] {
    const index = this.#sections;
    const terms = index.terms(query);
    return index.search(query, { limit }).map((hit: Hit) => ({
      page: hit.section.page.id,
      title: hit.section.page.title,
      section: hit.section.level > 0 ? hit.section.path.slice(1).join(' › ') || hit.section.heading : '',
      url: hit.section.page.url,
      snippet: snippet(hit.section, terms),
    }));
  }

  /** The table of contents read_docs returns when no page is named. */
  renderIndex(): string {
    const group = (kind: KnowledgePage['kind']) =>
      this.pages
        .filter((p) => p.kind === kind)
        .map((p) => `- \`${p.id}\`: ${p.title}. ${p.description}`);
    return [
      '# Bakbak developer documentation',
      '',
      'Bundled with this server, free, and needs no API key. Read a page with',
      '`read_docs` and its id; find anything with `search_docs`. Start with `start-here`,',
      'which says which SDK, plugin or API fits each platform.',
      '',
      '## Integration guides',
      '',
      ...group('guide'),
      '',
      '## References',
      '',
      ...group('reference'),
      '',
      '## Runnable examples',
      '',
      ...group('example'),
      '',
    ].join('\n');
  }
}

let shared: Knowledge | undefined;

/** The bundled documentation, shared by every server instance in the process. */
export function bundledKnowledge(): Knowledge {
  shared ??= new Knowledge();
  return shared;
}
