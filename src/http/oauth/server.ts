/**
 * The OAuth 2.1 authorization server built into hosted mode, so claude.ai
 * custom connectors (and any MCP client that speaks the MCP authorization
 * spec) can connect with a user's Bakbak API key:
 *
 * - discovery: RFC 9728 protected resource metadata, RFC 8414 server metadata;
 * - clients: Dynamic Client Registration, or Client ID Metadata Documents;
 * - `/authorize`: a form asking for the user's Bakbak API key, checked with
 *   `GET /v1/voices` (free) before a code is issued;
 * - `/token`: `authorization_code` with PKCE S256 (required), `refresh_token`.
 *
 * Every artifact is a sealed blob (see `../sealer.ts`), so the server is
 * stateless: a restart or a second instance needs no shared database.
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from '../../log.js';
import {
  BodyTooLargeError,
  cookie,
  header,
  mediaType,
  parseFields,
  readBody,
  redirect,
  sendHtml,
  sendJson,
} from '../io.js';
import type { RateLimiter } from '../rateLimit.js';
import { SEALED_PREFIX, type Sealer } from '../sealer.js';
import type { ClientMetadataResolver } from './cimd.js';
import {
  ClientError,
  type OAuthClient,
  SUPPORTED_AUTH_METHODS,
  clientHash,
  redirectMatches,
  registerClient,
  resolveClient,
} from './clients.js';
import { consentPage, errorPage } from './page.js';
import { type TokenIssuer, isValidChallenge, isValidVerifier, pkceChallenge } from './tokens.js';

/** Result of checking a Bakbak API key against the API. */
export type KeyCheck = 'valid' | 'invalid' | 'unavailable';

export interface OAuthServerOptions {
  /** Issuer and base of every endpoint, e.g. `https://mcp.bakbak.si`. */
  publicUrl: string;
  /** The protected resource: `<publicUrl>/mcp`. */
  resourceUrl: string;
  sealer: Sealer;
  tokens: TokenIssuer;
  documents: ClientMetadataResolver;
  checkKey: (apiKey: string) => Promise<KeyCheck>;
  limits: {
    register: RateLimiter;
    authorizePost: RateLimiter;
    /** Bounds the client metadata fetches an address can cause. */
    authorizeGet: RateLimiter;
  };
  clientIp: (req: IncomingMessage) => string;
  logger: Logger;
}

const PENDING_REQUEST_TTL_S = 15 * 60;
const MAX_FORM_BYTES = 16 * 1024;
const MAX_STATE_LENGTH = 2048;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** Canonical form of a resource indicator: lower-case scheme and host, no trailing slash or fragment. */
export function canonicalResource(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    const text = url.href;
    return text.endsWith('/') ? text.slice(0, -1) : text;
  } catch {
    return undefined;
  }
}

interface PendingRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  resource: string;
  scope: string | undefined;
  /** Whether the client sent redirect_uri (then /token must send it too). */
  redirectPresented: boolean;
  nonce: string;
}

export class OAuthServer {
  private readonly cookieName: string;
  private readonly secureCookie: boolean;

  constructor(private readonly options: OAuthServerOptions) {
    this.secureCookie = options.publicUrl.startsWith('https:');
    // `__Host-` cookies must be Secure; plain http is only allowed on localhost (development and tests).
    this.cookieName = this.secureCookie ? '__Host-bakbak_csrf' : 'bakbak_csrf';
  }

  /** RFC 9728 protected resource metadata. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.options.resourceUrl,
      authorization_servers: [this.options.publicUrl],
      bearer_methods_supported: ['header'],
      resource_name: 'Bakbak text-to-speech',
      resource_documentation: 'https://docs.litwizlabs.com/documentation/tts-mcp',
    };
  }

  /** RFC 8414 authorization server metadata. */
  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.options.publicUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: SUPPORTED_AUTH_METHODS,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: 'https://docs.litwizlabs.com/documentation/tts-mcp',
    };
  }

  /** Whether a `resource` parameter names this server: its MCP endpoint, or (leniently) its origin. */
  private isOwnResource(value: string): boolean {
    const canonical = canonicalResource(value);
    return canonical === this.options.resourceUrl || canonical === this.options.publicUrl;
  }

  /** The `WWW-Authenticate` value for a 401 from the MCP endpoint. */
  challenge(error?: 'invalid_token'): string {
    const metadata = `${this.options.publicUrl}/.well-known/oauth-protected-resource/mcp`;
    return error
      ? `Bearer error="${error}", resource_metadata="${metadata}"`
      : `Bearer resource_metadata="${metadata}"`;
  }

  private tooMany(res: ServerResponse, retryAfter: number, html: boolean): void {
    const headers = { 'Retry-After': String(retryAfter) };
    if (html) {
      const nonce = randomBytes(16).toString('base64');
      sendHtml(
        res,
        429,
        errorPage(nonce, 'Too many attempts', `Wait ${retryAfter} seconds and try again.`),
        {
          ...headers,
          ...this.pageHeaders(nonce, undefined),
        },
      );
    } else {
      sendJson(
        res,
        429,
        { error: 'too_many_requests', error_description: `Retry in ${retryAfter} s.` },
        headers,
      );
    }
  }

  // ---- /register ----------------------------------------------------------------

  async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const wait = this.options.limits.register.take(this.options.clientIp(req));
    if (wait !== undefined) {
      this.tooMany(res, wait, false);
      return;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readBody(req, MAX_FORM_BYTES));
    } catch (error) {
      const description =
        error instanceof BodyTooLargeError
          ? 'The registration request is too large.'
          : 'The body must be JSON.';
      sendJson(
        res,
        400,
        { error: 'invalid_client_metadata', error_description: description },
        NO_STORE,
      );
      return;
    }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      sendJson(
        res,
        400,
        { error: 'invalid_client_metadata', error_description: 'The body must be a JSON object.' },
        NO_STORE,
      );
      return;
    }
    try {
      const registration = registerClient(this.options.sealer, metadata as Record<string, unknown>);
      this.options.logger.info('client registered', {
        client: clientHash(registration.client_id),
        auth_method: registration.token_endpoint_auth_method,
      });
      sendJson(res, 201, registration, NO_STORE);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      sendJson(res, 400, { error: error.code, error_description: error.message }, NO_STORE);
    }
  }

  // ---- /authorize ---------------------------------------------------------------

  private pageHeaders(nonce: string, formTarget: string | undefined): Record<string, string> {
    const formAction = formTarget ? `'self' ${formTarget}` : `'self'`;
    return {
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    };
  }

  private showError(res: ServerResponse, status: number, title: string, message: string): void {
    const nonce = randomBytes(16).toString('base64');
    sendHtml(res, status, errorPage(nonce, title, message), this.pageHeaders(nonce, undefined));
  }

  private redirectWithError(
    res: ServerResponse,
    redirectUri: string,
    state: string | undefined,
    error: string,
    description: string,
  ): void {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state !== undefined) url.searchParams.set('state', state);
    url.searchParams.set('iss', this.options.publicUrl);
    redirect(res, url.href);
  }

  private renderConsent(
    res: ServerResponse,
    client: OAuthClient,
    pending: Omit<PendingRequest, 'nonce'>,
    status = 200,
    error?: string,
  ): void {
    const nonce = randomBytes(16).toString('base64');
    const csrf = randomBytes(18).toString('base64url');
    const request = this.options.sealer.seal('request', {
      c: pending.clientId,
      ru: pending.redirectUri,
      cc: pending.codeChallenge,
      res: pending.resource,
      ...(pending.state !== undefined && { st: pending.state }),
      ...(pending.scope !== undefined && { s: pending.scope }),
      ...(pending.redirectPresented && { rp: 1 }),
      n: csrf,
      exp: Math.floor(Date.now() / 1000) + PENDING_REQUEST_TTL_S,
    });
    const target = new URL(pending.redirectUri);
    const web = target.protocol === 'https:' || target.protocol === 'http:';
    // A native app's own scheme has no origin; CSP and the page name the scheme instead.
    const formTarget = web ? target.origin : target.protocol;
    const returnTo = web ? target.host : `${target.protocol}//${target.host}`;
    const cookieFlags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${PENDING_REQUEST_TTL_S}${this.secureCookie ? '; Secure' : ''}`;
    sendHtml(
      res,
      status,
      consentPage({
        nonce,
        clientName: client.name,
        redirectHost: returnTo,
        request,
        csrfToken: csrf,
        error,
      }),
      {
        ...this.pageHeaders(nonce, formTarget),
        'Set-Cookie': `${this.cookieName}=${csrf}; ${cookieFlags}`,
      },
    );
  }

  async authorizeGet(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const single = (name: string): string | undefined => {
      const values = query.getAll(name);
      return values.length === 1 ? values[0] : undefined;
    };
    const clientId = single('client_id');
    if (!clientId) {
      this.showError(
        res,
        400,
        'Missing client',
        'The request has no client_id, so it cannot continue.',
      );
      return;
    }
    if (!clientId.startsWith(`${SEALED_PREFIX.client}.`)) {
      // Resolving a metadata document URL may fetch it: bound how often one address can cause that.
      const wait = this.options.limits.authorizeGet.take(this.options.clientIp(req));
      if (wait !== undefined) {
        this.tooMany(res, wait, true);
        return;
      }
    }
    let client: OAuthClient;
    try {
      client = await resolveClient(this.options.sealer, this.options.documents, clientId);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      this.options.logger.debug('client not resolved', { error: error.cause ?? error });
      this.showError(res, 400, 'Unknown app', `This app could not be identified: ${error.message}`);
      return;
    }

    const presented = single('redirect_uri');
    const [onlyRedirect] = client.redirectUris;
    const redirectUri =
      presented === undefined
        ? client.redirectUris.length === 1
          ? onlyRedirect
          : undefined
        : client.redirectUris.some((r) => redirectMatches(r, presented))
          ? presented
          : undefined;
    if (redirectUri === undefined) {
      this.showError(
        res,
        400,
        'Redirect not allowed',
        'The redirect_uri does not match one registered for this app.',
      );
      return;
    }

    // Until the person has acted on the consent page, problems are shown here and never
    // redirected: anyone can register a redirect URI, so redirecting errors from this
    // GET would make this server an open redirector (RFC 9700 §4.11.2).
    const refuse = (message: string): void => {
      this.showError(res, 400, 'This connection request is invalid', message);
    };
    const state = single('state');
    if (state !== undefined && state.length > MAX_STATE_LENGTH) {
      refuse('The state parameter is too long.');
      return;
    }
    if (single('response_type') !== 'code') {
      refuse('Only response_type=code is supported.');
      return;
    }
    const challenge = single('code_challenge');
    if (single('code_challenge_method') !== 'S256' || !challenge || !isValidChallenge(challenge)) {
      refuse('PKCE is required: send code_challenge with code_challenge_method=S256.');
      return;
    }
    const resources = query.getAll('resource');
    if (
      resources.length > 1 ||
      (resources.length === 1 && !this.isOwnResource(resources[0] ?? ''))
    ) {
      refuse(`The only resource here is ${this.options.resourceUrl}.`);
      return;
    }
    this.renderConsent(res, client, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      state,
      resource: this.options.resourceUrl,
      scope: single('scope'),
      redirectPresented: presented !== undefined,
    });
  }

  private openPending(blob: string): PendingRequest | undefined {
    const data = this.options.sealer.open('request', blob);
    if (!data || typeof data.exp !== 'number' || data.exp <= Math.floor(Date.now() / 1000))
      return undefined;
    const { c, ru, cc, res, st, s, n } = data;
    if (
      typeof c !== 'string' ||
      typeof ru !== 'string' ||
      typeof cc !== 'string' ||
      typeof res !== 'string' ||
      typeof n !== 'string'
    ) {
      return undefined;
    }
    return {
      clientId: c,
      redirectUri: ru,
      codeChallenge: cc,
      resource: res,
      state: typeof st === 'string' ? st : undefined,
      scope: typeof s === 'string' ? s : undefined,
      redirectPresented: data.rp === 1,
      nonce: n,
    };
  }

  async authorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const wait = this.options.limits.authorizePost.take(this.options.clientIp(req));
    if (wait !== undefined) {
      this.tooMany(res, wait, true);
      return;
    }
    let fields: Map<string, string> | undefined;
    try {
      fields =
        mediaType(req) === 'application/x-www-form-urlencoded'
          ? parseFields(await readBody(req, MAX_FORM_BYTES), 'application/x-www-form-urlencoded')
          : undefined;
    } catch {
      fields = undefined;
    }
    const pending = fields ? this.openPending(fields.get('request') ?? '') : undefined;
    if (!fields || !pending) {
      this.showError(
        res,
        400,
        'This page has expired',
        'The connection request is missing or has expired.',
      );
      return;
    }
    const csrf = fields.get('csrf_token');
    if (!csrf || csrf !== pending.nonce || cookie(req, this.cookieName) !== pending.nonce) {
      this.showError(
        res,
        403,
        'Could not verify this request',
        'The form was not submitted from this page, or it was open in another tab. Start connecting again from your app.',
      );
      return;
    }
    if (fields.get('action') === 'cancel') {
      this.redirectWithError(
        res,
        pending.redirectUri,
        pending.state,
        'access_denied',
        'The user cancelled.',
      );
      return;
    }
    let client: OAuthClient;
    try {
      client = await resolveClient(this.options.sealer, this.options.documents, pending.clientId);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      this.options.logger.debug('client not resolved', { error: error.cause ?? error });
      this.showError(res, 400, 'Unknown app', `This app could not be identified: ${error.message}`);
      return;
    }
    const apiKey = (fields.get('api_key') ?? '').trim();
    const check: KeyCheck =
      apiKey.length < 8 || apiKey.length > 512 ? 'invalid' : await this.options.checkKey(apiKey);
    if (check !== 'valid') {
      const message =
        check === 'invalid'
          ? 'Bakbak did not accept that API key. Check it and try again.'
          : 'Bakbak could not be reached to check the key. Try again in a moment.';
      this.renderConsent(res, client, pending, check === 'invalid' ? 400 : 503, message);
      return;
    }
    const code = this.options.tokens.issueCode({
      apiKey,
      clientHash: clientHash(pending.clientId),
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scope: pending.scope,
      redirectPresented: pending.redirectPresented,
    });
    this.options.logger.info('authorized', { client: clientHash(pending.clientId) });
    const url = new URL(pending.redirectUri);
    url.searchParams.set('code', code);
    if (pending.state !== undefined) url.searchParams.set('state', pending.state);
    url.searchParams.set('iss', this.options.publicUrl);
    redirect(res, url.href, {
      'Set-Cookie': `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookie ? '; Secure' : ''}`,
    });
  }

  // ---- /token -------------------------------------------------------------------

  private tokenError(
    res: ServerResponse,
    status: number,
    error: string,
    description: string,
  ): void {
    const headers: Record<string, string> = { ...NO_STORE };
    if (status === 401) headers['WWW-Authenticate'] = 'Basic realm="bakbak-mcp"';
    sendJson(res, status, { error, error_description: description }, headers);
  }

  /** Client authentication at the token endpoint; returns the client id or undefined after answering. */
  private authenticateClient(
    req: IncomingMessage,
    res: ServerResponse,
    fields: Map<string, string>,
  ): string | undefined {
    let clientId = fields.get('client_id');
    let secret = fields.get('client_secret');
    const authorization = header(req, 'authorization');
    if (authorization?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) {
        this.tokenError(res, 401, 'invalid_client', 'Malformed Basic credentials.');
        return undefined;
      }
      let basicId: string;
      try {
        basicId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      } catch {
        this.tokenError(res, 401, 'invalid_client', 'Malformed Basic credentials.');
        return undefined;
      }
      if (clientId !== undefined && clientId !== basicId) {
        this.tokenError(
          res,
          401,
          'invalid_client',
          'client_id does not match the Basic credentials.',
        );
        return undefined;
      }
      clientId = basicId;
    }
    if (!clientId) {
      this.tokenError(res, 401, 'invalid_client', 'client_id is required.');
      return undefined;
    }
    const registered = this.options.sealer.open('client', clientId);
    const method = typeof registered?.m === 'string' ? registered.m : 'none';
    if (
      method !== 'none' &&
      (!secret || !this.options.sealer.verifyClientSecret(clientId, secret))
    ) {
      this.tokenError(res, 401, 'invalid_client', 'Client authentication failed.');
      return undefined;
    }
    return clientId;
  }

  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = mediaType(req);
    let fields: Map<string, string> | undefined;
    try {
      const body = await readBody(req, MAX_FORM_BYTES);
      fields =
        type === 'application/x-www-form-urlencoded' || type === 'application/json'
          ? parseFields(body, type)
          : undefined;
    } catch {
      fields = undefined;
    }
    if (!fields) {
      this.tokenError(
        res,
        400,
        'invalid_request',
        'Send the token request as application/x-www-form-urlencoded.',
      );
      return;
    }
    const clientId = this.authenticateClient(req, res, fields);
    if (clientId === undefined) return;
    const resourceParam = fields.get('resource');
    if (resourceParam !== undefined && !this.isOwnResource(resourceParam)) {
      this.tokenError(
        res,
        400,
        'invalid_target',
        `The only resource here is ${this.options.resourceUrl}.`,
      );
      return;
    }

    const grantType = fields.get('grant_type');
    if (grantType === 'authorization_code') {
      // Everything is checked before the code is marked used, so a failed attempt
      // (wrong verifier, wrong client) cannot spend the legitimate client's code.
      const grant = this.options.tokens.openCode(fields.get('code') ?? '');
      if (!grant || grant.clientHash !== clientHash(clientId)) {
        this.tokenError(
          res,
          400,
          'invalid_grant',
          'The authorization code is invalid, expired, already used, or for another client.',
        );
        return;
      }
      // redirect_uri is required here exactly when it was sent to /authorize (RFC 6749 §4.1.3).
      const redirectUri = fields.get('redirect_uri');
      if (
        (grant.redirectPresented || redirectUri !== undefined) &&
        redirectUri !== grant.redirectUri
      ) {
        this.tokenError(
          res,
          400,
          'invalid_grant',
          'redirect_uri does not match the authorization request.',
        );
        return;
      }
      const verifier = fields.get('code_verifier') ?? '';
      if (!isValidVerifier(verifier) || pkceChallenge(verifier) !== grant.codeChallenge) {
        this.tokenError(res, 400, 'invalid_grant', 'PKCE verification failed.');
        return;
      }
      if (!this.options.tokens.markRedeemed(grant)) {
        this.tokenError(res, 400, 'invalid_grant', 'The authorization code was already used.');
        return;
      }
      this.options.logger.info('tokens issued', {
        client: grant.clientHash,
        grant: 'authorization_code',
      });
      sendJson(res, 200, this.options.tokens.issueTokens(grant), NO_STORE);
      return;
    }

    if (grantType === 'refresh_token') {
      const grant = this.options.tokens.verifyRefreshToken(fields.get('refresh_token') ?? '');
      if (!grant || grant.clientHash !== clientHash(clientId)) {
        this.tokenError(
          res,
          400,
          'invalid_grant',
          'The refresh token is invalid, expired, or for another client.',
        );
        return;
      }
      // A revoked key ends the connection; a Bakbak outage does not.
      if ((await this.options.checkKey(grant.apiKey)) === 'invalid') {
        this.tokenError(
          res,
          400,
          'invalid_grant',
          'The Bakbak API key behind this connection is no longer valid. Connect again.',
        );
        return;
      }
      this.options.logger.info('tokens issued', {
        client: grant.clientHash,
        grant: 'refresh_token',
      });
      sendJson(res, 200, this.options.tokens.issueTokens(grant), NO_STORE);
      return;
    }

    this.tokenError(
      res,
      400,
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token.',
    );
  }
}
