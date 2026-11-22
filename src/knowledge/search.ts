/**
 * Splits pages into sections at their headings and ranks sections for a query
 * with BM25. Small and dependency-free: the corpus is a few hundred sections.
 */

import type { KnowledgePage } from './types.js';

export interface Section {
  page: KnowledgePage;
  /** The heading's text, or the page title for text before the first heading. */
  heading: string;
  /** Headings above this one and itself, e.g. ["WebSocket", "Cancel (barge-in)"]. */
  path: string[];
  level: number;
  /** Line index of the heading in the page's Markdown. */
  start: number;
  /** Line index after the section's own text (before the next heading of any level). */
  end: number;
  /** Line index after the section including its subsections. */
  endWithChildren: number;
  text: string;
}

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** The page's sections, in order. Headings inside code blocks are ignored. */
export function splitSections(page: KnowledgePage): Section[] {
  const lines = page.markdown.split('\n');
  const heads: { line: number; level: number; text: string }[] = [];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (f?.[1]) {
      if (fence === undefined) fence = f[1];
      else if (f[1] === fence) fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    const h = HEADING.exec(line);
    if (h?.[1] && h[2]) heads.push({ line: i, level: h[1].length, text: stripInline(h[2]) });
  });

  const sections: Section[] = [];
  const first = heads[0]?.line ?? lines.length;
  if (lines.slice(0, first).some((l) => l.trim() !== '')) {
    sections.push({
      page,
      heading: page.title,
      path: [page.title],
      level: 0,
      start: 0,
      end: first,
      endWithChildren: lines.length,
      text: lines.slice(0, first).join('\n'),
    });
  }
  const stack: { level: number; text: string }[] = [];
  heads.forEach((h, k) => {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= h.level) stack.pop();
    stack.push(h);
    const end = heads[k + 1]?.line ?? lines.length;
    const after = heads.slice(k + 1).find((n) => n.level <= h.level);
    sections.push({
      page,
      heading: h.text,
      path: stack.map((s) => s.text),
      level: h.level,
      start: h.line,
      end,
      endWithChildren: after?.line ?? lines.length,
      text: lines.slice(h.line, end).join('\n'),
    });
  });
  return sections;
}

/** Heading text without Markdown emphasis, code ticks or links. */
export function stripInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/** A heading as an anchor: lower case, words joined by hyphens. */
export function slug(text: string): string {
  return stripInline(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

const STOP = new Set(
  (
    'a an and are as at be by can do does for from how i if in into is it its me my of on or ' +
    'our should so than that the their then there these this to use using via was we what when ' +
    'where which while who why will with you your'
  ).split(' '),
);

/** Light English stemming, applied to index and query alike. */
function stem(word: string): string {
  if (!/^[a-z]+$/.test(word) || word.length <= 4) return word;
  if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
  for (const suffix of ['ings', 'ions', 'ing', 'ion', 'ed']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      const base = word.slice(0, -suffix.length);
      return /([b-df-hj-np-tv-z])\1$/.test(base) ? base.slice(0, -1) : base;
    }
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

const WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u;

/**
 * Words of a text, lower-cased and stemmed. Identifiers also contribute their
 * parts: `send_stream` and `sendStream` both give `send` and `stream`.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const push = (w: string) => {
    const lower = w.toLowerCase();
    if (lower.length === 0 || STOP.has(lower)) return;
    out.push(stem(lower));
  };
  for (const match of text.matchAll(WORD)) {
    const raw = match[0];
    push(raw);
    const parts = raw
      .split('_')
      .flatMap((p) => p.split(CAMEL))
      .filter((p) => p.length > 0);
    if (parts.length > 1) for (const p of parts) push(p);
  }
  return out;
}

/** Words people use for things the docs name differently. */
const SYNONYMS: Record<string, string[]> = {
  interrupt: ['barge', 'cancel'],
  interruption: ['barge', 'cancel'],
  barge: ['cancel', 'interrupt'],
  stop: ['cancel'],
  phone: ['telephony', 'call'],
  call: ['telephony'],
  ivr: ['telephony'],
  sip: ['telephony'],
  ulaw: ['mulaw'],
  pcmu: ['mulaw'],
  pcma: ['alaw'],
  llm: ['send_stream', 'token'],
  openai: ['llm', 'send_stream'],
  anthropic: ['llm', 'send_stream'],
  gemini: ['llm', 'send_stream'],
  gpt: ['llm'],
  latency: ['first', 'audio', 'ttfa'],
  fast: ['latency'],
  slow: ['latency'],
  key: ['api_key'],
  auth: ['api_key', 'authentication'],
  browser: ['web'],
  frontend: ['browser'],
  react: ['browser'],
  nextjs: ['next', 'route'],
  node: ['javascript'],
  nodejs: ['javascript'],
  typescript: ['javascript'],
  ts: ['javascript'],
  js: ['javascript'],
  py: ['python'],
  ios: ['mobile'],
  android: ['mobile'],
  flutter: ['mobile'],
  file: ['generate'],
  mp3: ['container'],
  wav: ['container'],
  retry: ['retryable'],
  limit: ['concurrency'],
  pricing: ['billing', 'credit'],
  cost: ['billing', 'credit'],
  price: ['billing', 'credit'],
  voice_id: ['voice'],
  ws: ['websocket'],
};

export interface Hit {
  section: Section;
  score: number;
}

const K1 = 1.2;
const B = 0.75;
/** Heading words count this many times. */
const HEADING_WEIGHT = 3;

interface IndexedSection {
  section: Section;
  tf: Map<string, number>;
  length: number;
}

export class SectionIndex {
  readonly sections: Section[];
  #docs: IndexedSection[];
  #df = new Map<string, number>();
  #avgLength: number;

  constructor(pages: readonly KnowledgePage[]) {
    this.sections = pages.flatMap(splitSections);
    this.#docs = this.sections.map((section) => {
      const tf = new Map<string, number>();
      const add = (tokens: string[], weight: number) => {
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
      };
      add(tokenize(section.path.join(' ')), HEADING_WEIGHT);
      // The page id on every section ("livekit", "telephony"); the title only on the
      // page's opening section, or a word in a title would lift every section of the page.
      add(tokenize(section.page.id), 1);
      if (section.start === 0) add(tokenize(section.page.title), 1);
      add(tokenize(section.text), 1);
      let length = 0;
      for (const n of tf.values()) length += n;
      return { section, tf, length };
    });
    for (const doc of this.#docs) {
      for (const term of doc.tf.keys()) this.#df.set(term, (this.#df.get(term) ?? 0) + 1);
    }
    this.#avgLength = this.#docs.reduce((n, d) => n + d.length, 0) / Math.max(this.#docs.length, 1);
  }

  /** Query terms with their weights: the words themselves, and synonyms at half weight. */
  terms(query: string): Map<string, number> {
    const terms = new Map<string, number>();
    for (const t of tokenize(query)) terms.set(t, 1);
    for (const word of query.toLowerCase().match(WORD) ?? []) {
      for (const synonym of SYNONYMS[word] ?? []) {
        for (const t of tokenize(synonym)) if (!terms.has(t)) terms.set(t, 0.5);
      }
    }
    return terms;
  }

  search(query: string, options: { limit: number; perPage?: number }): Hit[] {
    const terms = this.terms(query);
    if (terms.size === 0) return [];
    const n = this.#docs.length;
    const hits: Hit[] = [];
    for (const doc of this.#docs) {
      let score = 0;
      for (const [term, weight] of terms) {
        const tf = doc.tf.get(term);
        if (tf === undefined) continue;
        const df = this.#df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / this.#avgLength)));
      }
      if (score > 0) {
        // Prefer the guides written for this pack, then references, then examples.
        const kind = doc.section.page.kind;
        hits.push({ section: doc.section, score: score * (kind === 'guide' ? 1.15 : kind === 'example' ? 0.9 : 1) });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const perPage = options.perPage ?? 2;
    const counts = new Map<string, number>();
    const out: Hit[] = [];
    for (const hit of hits) {
      const id = hit.section.page.id;
      const count = counts.get(id) ?? 0;
      if (count >= perPage) continue;
      counts.set(id, count + 1);
      out.push(hit);
      if (out.length >= options.limit) break;
    }
    return out;
  }
}

/**
 * A short excerpt of a section: the lines that match the query best, with a
 * line of context, at most `maxChars` characters.
 */
export function snippet(section: Section, terms: Map<string, number>, maxChars = 360): string {
  const text = (end: number) =>
    section.page.markdown
      .split('\n')
      .slice(section.level > 0 ? section.start + 1 : section.start, end)
      .filter((l) => l.trim() !== '' && !FENCE.test(l));
  // A heading followed straight by subheadings: show the start of its subsections.
  let lines = text(section.end);
  if (lines.length === 0) lines = text(section.endWithChildren);
  if (lines.length === 0) return '';
  let best = 0;
  let bestScore = -1;
  lines.forEach((line, i) => {
    let score = 0;
    for (const t of tokenize(line)) score += terms.get(t) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  const from = bestScore > 0 ? Math.max(0, best - 1) : 0;
  let out = '';
  for (const line of lines.slice(from)) {
    const next = out ? `${out}\n${line.trim()}` : line.trim();
    if (next.length > maxChars) {
      if (!out) out = line.trim().slice(0, maxChars - 1) + '…';
      else out += '\n…';
      break;
    }
    out = next;
  }
  return out;
}
