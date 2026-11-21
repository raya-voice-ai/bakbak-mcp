/**
 * OAuth clients. Two kinds of `client_id` are accepted:
 *
 * - Dynamic Client Registration (RFC 7591): `/register` returns a `client_id`
 *   that is a sealed blob of the registered metadata, so nothing is stored.
 * - Client ID Metadata Documents: the `client_id` is an https URL whose
 *   document lists the client's metadata (fetched with SSRF protections).
 *
 * Redirect URIs must be https, or http on a loopback address for native apps.
 * Matching is exact, except that a loopback redirect may use any port
 * (RFC 8252 §7.3), because native apps listen on an ephemeral port.
 */

import { createHash } from 'node:crypto';

import type { Sealer } from '../sealer.js';
import { type ClientMetadataResolver, isMetadataDocumentUrl } from './cimd.js';

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export const SUPPORTED_AUTH_METHODS: readonly AuthMethod[] = [
  'none',
  'client_secret_post',
  'client_secret_basic',
];

export interface OAuthClient {
  clientId: string;
  /** Shown on the consent page. */
  name: string;
  redirectUris: string[];
  authMethod: AuthMethod;
}

export class ClientError extends Error {
  override readonly name = 'ClientError';
  constructor(
    readonly code: 'invalid_client' | 'invalid_redirect_uri' | 'invalid_client_metadata',
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;
const MAX_NAME_LENGTH = 80;

function parseRedirect(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

/** Whether a redirect URI is acceptable at registration: https, or http on loopback; no fragment or credentials. */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return false;
  const url = parseRedirect(uri);
  if (!url || url.hash !== '' || uri.includes('#') || url.username !== '' || url.password !== '')
    return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** Exact match, except any port on a registered loopback http redirect. */
export function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const a = parseRedirect(registered);
  const b = parseRedirect(presented);
  if (!a || !b || a.protocol !== 'http:' || !LOOPBACK_HOSTS.has(a.hostname)) return false;
  return (
    b.protocol === 'http:' &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search &&
    b.hash === '' &&
    b.username === '' &&
    b.password === ''
  );
}

/** A short hash binding codes and tokens to the client they were issued to. */
export function clientHash(clientId: string): string {
  return createHash('sha256').update(clientId).digest('base64url').slice(0, 22);
}

/** Removes control characters and squeezes whitespace in a display name. */
export function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/\p{Cc}|\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return undefined;
  // Truncate by grapheme, so a name never ends in half a character.
  const graphemes = Array.from(new Intl.Segmenter().segment(cleaned), (s) => s.segment);
  return graphemes.slice(0, MAX_NAME_LENGTH).join('');
}

function fallbackName(redirectUris: readonly string[]): string {
  const host = parseRedirect(redirectUris[0] ?? '')?.hostname;
  return host ? `An app at ${host}` : 'An MCP client';
}

export interface RegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: AuthMethod;
  application_type?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
}

/** RFC 7591 registration: validates the metadata and seals it into the client id. */
export function registerClient(
  sealer: Sealer,
  metadata: Record<string, unknown>,
  now = Date.now(),
): RegistrationResponse {
  const redirectUris = metadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS
  ) {
    throw new ClientError(
      'invalid_redirect_uri',
      `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
      throw new ClientError(
        'invalid_redirect_uri',
        'Each redirect URI must be https, or http on 127.0.0.1, [::1] or localhost, without a fragment.',
      );
    }
  }
  const requestedMethod = metadata.token_endpoint_auth_method ?? 'none';
  if (
    typeof requestedMethod !== 'string' ||
    !(SUPPORTED_AUTH_METHODS as readonly string[]).includes(requestedMethod)
  ) {
    throw new ClientError(
      'invalid_client_metadata',
      `token_endpoint_auth_method must be one of ${SUPPORTED_AUTH_METHODS.join(', ')}.`,
    );
  }
  const grantTypes = metadata.grant_types ?? ['authorization_code'];
  if (
    !Array.isArray(grantTypes) ||
    !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')
  ) {
    throw new ClientError(
      'invalid_client_metadata',
      'grant_types may contain only authorization_code and refresh_token.',
    );
  }
  const responseTypes = metadata.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) {
    throw new ClientError('invalid_client_metadata', 'response_types may contain only code.');
  }
  const method = requestedMethod as AuthMethod;
  const uris = redirectUris as string[];
  const name = cleanName(metadata.client_name) ?? fallbackName(uris);
  const applicationType =
    metadata.application_type === 'native' || metadata.application_type === 'web'
      ? metadata.application_type
      : undefined;
  const issuedAt = Math.floor(now / 1000);
  const clientId = sealer.seal('client', { n: name, r: uris, m: method, iat: issuedAt });
  const secret = method === 'none' ? undefined : sealer.clientSecret(clientId);
  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    ...(applicationType !== undefined && { application_type: applicationType }),
    ...(secret !== undefined && { client_secret: secret, client_secret_expires_at: 0 }),
  };
}

/** Opens a sealed (registered) client id, without any network access. */
export function openRegisteredClient(sealer: Sealer, clientId: string): OAuthClient | undefined {
  const data = sealer.open('client', clientId);
  if (!data) return undefined;
  const { n, r, m } = data;
  if (typeof n !== 'string' || !Array.isArray(r) || !r.every((u) => typeof u === 'string'))
    return undefined;
  if (typeof m !== 'string' || !(SUPPORTED_AUTH_METHODS as readonly string[]).includes(m))
    return undefined;
  return { clientId, name: n, redirectUris: r, authMethod: m as AuthMethod };
}

/** Resolves any accepted `client_id`: a registered one, or a metadata document URL. */
export async function resolveClient(
  sealer: Sealer,
  documents: ClientMetadataResolver,
  clientId: string,
): Promise<OAuthClient> {
  const registered = openRegisteredClient(sealer, clientId);
  if (registered) return registered;
  if (!isMetadataDocumentUrl(clientId))
    throw new ClientError('invalid_client', 'Unknown client_id.');
  let doc;
  try {
    doc = await documents.resolve(clientId);
  } catch (error) {
    throw new ClientError(
      'invalid_client',
      `Could not load the client's metadata document: ${(error as Error).message}`,
    );
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    throw new ClientError(
      'invalid_client',
      'Clients identified by a metadata document must use token_endpoint_auth_method "none".',
    );
  }
  const redirectUris = doc.redirect_uris.filter(isAllowedRedirectUri);
  if (redirectUris.length === 0) {
    throw new ClientError(
      'invalid_redirect_uri',
      'The client metadata document lists no acceptable redirect URIs.',
    );
  }
  return {
    clientId,
    name: cleanName(doc.client_name) ?? new URL(clientId).hostname,
    redirectUris,
    authMethod: 'none',
  };
}
