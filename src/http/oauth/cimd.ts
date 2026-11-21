/**
 * Client ID Metadata Documents: an OAuth client whose `client_id` is an https
 * URL publishes its metadata there. Fetching a URL a stranger chose is a
 * server-side request forgery risk, so the fetch:
 *
 * - accepts only `https` on port 443, with no credentials or fragment;
 * - resolves the host itself and refuses unless every address is publicly
 *   routable, then connects to that vetted address (no DNS rebinding window);
 * - follows no redirects, waits at most 5 s, and reads at most 64 KiB;
 * - caches documents (bounded) so a client is not fetched on every request.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';

import { isPublicAddress } from '../ip.js';

export interface ClientMetadataDocument {
  client_id: string;
  client_name?: string | undefined;
  redirect_uris: string[];
  token_endpoint_auth_method?: string | undefined;
}

export class ClientMetadataError extends Error {
  override readonly name = 'ClientMetadataError';
}

/** Fetches the raw document text for a validated URL. Injectable for tests. */
export type DocumentFetcher = (
  url: URL,
) => Promise<{ body: string; maxAgeSeconds: number | undefined }>;

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const DEFAULT_TTL_S = 300;
const MIN_TTL_S = 60;
const MAX_TTL_S = 86_400;

/** Whether `clientId` is a CIMD URL this server may fetch (syntax only). */
export function isMetadataDocumentUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    url.pathname !== '/' &&
    !url.pathname.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/** A DNS lookup that refuses non-public addresses and pins the connection to the vetted one. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, order: 'verbatim' })
    .then((addresses) => {
      const usable = addresses.filter((a) => isPublicAddress(a.address));
      if (addresses.length === 0 || usable.length !== addresses.length) {
        throw new ClientMetadataError(`${hostname} does not resolve to public addresses only.`);
      }
      const [first] = usable;
      if (!first) throw new ClientMetadataError(`${hostname} did not resolve.`);
      if (options.all) callback(null, usable);
      else callback(null, first.address, first.family);
    })
    .catch((error: unknown) => {
      callback(error as NodeJS.ErrnoException, '', 0);
    });
};

function maxAge(cacheControl: string | undefined): number | undefined {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The production fetcher: https only, public addresses only, bounded in time and size. */
export const fetchDocument: DocumentFetcher = (url) =>
  new Promise((resolve, reject) => {
    if (/^\d+\.\d+\.\d+\.\d+$|^\[/.test(url.hostname) && !isPublicAddress(url.hostname)) {
      reject(new ClientMetadataError('The client metadata URL points at a non-public address.'));
      return;
    }
    const req = request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        lookup: publicOnlyLookup,
        timeout: TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new ClientMetadataError(
              `The client metadata URL answered HTTP ${res.statusCode ?? 0}.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BYTES) {
            req.destroy(new ClientMetadataError('The client metadata document is too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            maxAgeSeconds: maxAge(res.headers['cache-control']),
          });
        });
        res.on('error', reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new ClientMetadataError('The client metadata URL timed out.')),
      TIMEOUT_MS,
    );
    req.on('close', () => {
      clearTimeout(deadline);
    });
    req.on('timeout', () =>
      req.destroy(new ClientMetadataError('The client metadata URL timed out.')),
    );
    req.on('error', reject);
    req.end();
  });

/** Validates a fetched document against the URL it came from. */
export function parseDocument(url: string, body: string): ClientMetadataDocument {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ClientMetadataError('The client metadata document is not JSON.');
  }
  if (typeof value !== 'object' || value === null)
    throw new ClientMetadataError('The client metadata document is not an object.');
  const doc = value as Record<string, unknown>;
  if (doc.client_id !== url)
    throw new ClientMetadataError("The document's client_id does not match its URL.");
  const redirects = doc.redirect_uris;
  if (
    !Array.isArray(redirects) ||
    redirects.length === 0 ||
    !redirects.every((r) => typeof r === 'string')
  ) {
    throw new ClientMetadataError('The client metadata document has no redirect_uris.');
  }
  const method =
    typeof doc.token_endpoint_auth_method === 'string' ? doc.token_endpoint_auth_method : undefined;
  return {
    client_id: url,
    client_name: typeof doc.client_name === 'string' ? doc.client_name : undefined,
    redirect_uris: redirects,
    token_endpoint_auth_method: method,
  };
}

interface CacheEntry {
  expires: number;
  doc: Promise<ClientMetadataDocument>;
}

export class ClientMetadataResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly fetcher: DocumentFetcher = fetchDocument,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  /** The document for a CIMD `client_id`, from cache or freshly fetched. */
  resolve(clientId: string): Promise<ClientMetadataDocument> {
    const now = this.now();
    const hit = this.cache.get(clientId);
    if (hit && hit.expires > now) return hit.doc;

    const doc = this.fetcher(new URL(clientId)).then(({ body, maxAgeSeconds }) => {
      const parsed = parseDocument(clientId, body);
      const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, maxAgeSeconds ?? DEFAULT_TTL_S));
      const current = this.cache.get(clientId);
      if (current?.doc === doc) current.expires = this.now() + ttl * 1000;
      return parsed;
    });
    doc.catch(() => {
      if (this.cache.get(clientId)?.doc === doc) this.cache.delete(clientId);
    });
    this.cache.delete(clientId);
    this.cache.set(clientId, { expires: now + DEFAULT_TTL_S * 1000, doc });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) break;
      this.cache.delete(oldest);
    }
    return doc;
  }
}
