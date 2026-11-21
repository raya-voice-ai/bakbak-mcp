/**
 * Hosted mode: stateless streamable HTTP at `/mcp`, the OAuth endpoints,
 * temporary audio downloads, and a health check, on plain `node:http`.
 */

import { createReadStream } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';

import type { Backend } from '../backend/types.js';
import type { Logger } from '../log.js';
import { createBakbakServer } from '../server.js';
import { fingerprint } from '../util.js';
import { VERSION } from '../version.js';
import { VoiceCache } from '../voices.js';
import { AudioStore } from './audioStore.js';
import type { HostedConfig } from './config.js';
import { KeyChecker, readCredential } from './credentials.js';
import { createHostedDelivery } from './delivery.js';
import { header, sendJson, sendText } from './io.js';
import { clientAddress } from './ip.js';
import { ClientMetadataResolver } from './oauth/cimd.js';
import { OAuthServer } from './oauth/server.js';
import { TokenIssuer } from './oauth/tokens.js';
import { RateLimiter } from './rateLimit.js';

export interface HostedAppOptions {
  config: HostedConfig;
  backend: Backend;
  logger: Logger;
  /** Overrides the client metadata document resolver (tests). */
  documents?: ClientMetadataResolver;
  /** Interval of SSE keep-alive comments on MCP responses (default 15 s). */
  keepAliveMs?: number;
}

export interface HostedApp {
  server: Server;
  /** Starts listening; resolves with the bound port. */
  listen(): Promise<number>;
  /** Stops accepting requests, lets open ones finish for up to `graceMs`, then cuts them. */
  close(graceMs?: number): Promise<void>;
  audioStore: AudioStore;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, X-API-Key, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Paths that answer cross-origin requests (browser-based MCP clients). */
function isCorsPath(path: string): boolean {
  return (
    path === '/mcp' || path.startsWith('/.well-known/') || path === '/register' || path === '/token'
  );
}

const AUDIO_PATH = /^\/audio\/([A-Za-z0-9_-]{22}\.[a-z0-9]{1,8})$/;

function parseRange(
  value: string,
  size: number,
): { start: number; end: number } | 'invalid' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return undefined; // unsupported (e.g. multiple ranges): send the whole file
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return 'invalid';
  let start: number;
  let end: number;
  if (from === '') {
    start = Math.max(0, size - Number(to));
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

export function createHostedApp(options: HostedAppOptions): HostedApp {
  const { config, backend, logger } = options;
  const voices = new VoiceCache();
  const keys = new KeyChecker(backend, voices);
  const tokens = new TokenIssuer(config.sealer);
  const audioStore = new AudioStore({
    directory: config.audioDir,
    ttlMs: config.audioTtlMs,
    maxBytes: config.audioMaxBytes,
    publicUrl: config.publicUrl,
    logger,
  });
  const clientIp = (req: IncomingMessage): string =>
    clientAddress(
      {
        peer: req.socket.remoteAddress,
        cfConnectingIp: header(req, 'cf-connecting-ip'),
        forwardedFor: header(req, 'x-forwarded-for'),
      },
      config.trustedProxies,
    );
  const oauth = new OAuthServer({
    publicUrl: config.publicUrl,
    resourceUrl: config.resourceUrl,
    sealer: config.sealer,
    tokens,
    documents: options.documents ?? new ClientMetadataResolver(),
    checkKey: (apiKey) => keys.check(apiKey),
    limits: {
      register: new RateLimiter({ burst: 20, perMinute: 20 }),
      authorizePost: new RateLimiter({ burst: 10, perMinute: 10 }),
      authorizeGet: new RateLimiter({ burst: 30, perMinute: 30 }),
    },
    clientIp,
    logger,
  });
  const toolLimiter = new RateLimiter({ burst: 30, perMinute: 60 });
  const delivery = createHostedDelivery(audioStore);

  const mcp = createMcpHandler(
    ({ authInfo }) => {
      const apiKey = authInfo?.extra?.apiKey;
      return createBakbakServer({
        mode: 'hosted',
        backend,
        apiKey: typeof apiKey === 'string' ? apiKey : undefined,
        voices,
        delivery,
        logger: logger.child({ key: typeof apiKey === 'string' ? fingerprint(apiKey) : undefined }),
        rateLimit: (key) => toolLimiter.take(fingerprint(key)),
      });
    },
    {
      legacy: 'stateless',
      // Always stream, so SSE keep-alive comments flow every 15 s during long calls:
      // proxies such as Cloudflare drop a response that is silent for about 100 s.
      responseMode: 'sse',
      keepAliveMs: options.keepAliveMs ?? 15_000,
      onerror: (error) => {
        logger.warn('mcp request error', { error });
      },
    },
  );
  const mcpNode = toNodeHandler(mcp, {
    onerror: (error) => {
      logger.error('mcp adapter error', { error });
    },
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credential = readCredential(req, tokens, config.resourceUrl);
    if (!credential.ok) {
      const challenge = oauth.challenge(
        credential.error === 'invalid_token' ? 'invalid_token' : undefined,
      );
      sendJson(
        res,
        401,
        {
          error: credential.error === 'missing' ? 'unauthorized' : 'invalid_token',
          error_description:
            'Authenticate with OAuth, or send a Bakbak API key as a Bearer token or X-API-Key.',
        },
        { 'WWW-Authenticate': challenge },
      );
      return;
    }
    if (credential.via !== 'oauth' && (await keys.check(credential.apiKey)) === 'invalid') {
      sendJson(
        res,
        401,
        { error: 'invalid_token', error_description: 'Bakbak did not accept this API key.' },
        { 'WWW-Authenticate': oauth.challenge('invalid_token') },
      );
      return;
    }
    const auth: AuthInfo = {
      token: fingerprint(credential.apiKey),
      clientId: credential.client ?? credential.via,
      scopes: [],
      extra: { apiKey: credential.apiKey },
    };
    (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    await mcpNode(req, res);
  }

  async function serveAudio(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
  ): Promise<void> {
    const file = await audioStore.get(name);
    if (!file) {
      sendText(res, 404, 'This audio link has expired or does not exist.\n', {
        'Cache-Control': 'no-store',
      });
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': file.contentType,
      'Content-Disposition': `inline; filename="${file.fileName}"`,
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
    };
    const rangeHeader = header(req, 'range');
    const range = rangeHeader === undefined ? undefined : parseRange(rangeHeader, file.size);
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}` });
      res.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    headers['Content-Length'] = String(file.size === 0 ? 0 : end - start + 1);
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || file.size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(file.path, { start, end });
    stream.on('error', (error) => {
      logger.warn('audio read failed', { error });
      res.destroy();
    });
    stream.pipe(res);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parsed against the configured origin: the Host header is never used for URLs.
    const url = new URL(req.url ?? '/', config.publicUrl);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isCorsPath(path)) {
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (path === '/mcp') {
      await handleMcp(req, res);
      return;
    }
    const audio = AUDIO_PATH.exec(path);
    if (audio?.[1] && (method === 'GET' || method === 'HEAD')) {
      await serveAudio(req, res, audio[1]);
      return;
    }
    const get = method === 'GET' || method === 'HEAD';
    switch (`${get ? 'GET' : method} ${path}`) {
      case 'GET /healthz':
        sendJson(res, 200, { status: 'ok', version: VERSION }, { 'Cache-Control': 'no-store' });
        return;
      case 'GET /':
        sendText(
          res,
          200,
          `Bakbak MCP server ${VERSION}.\nAdd ${config.resourceUrl} as a custom connector in your MCP client.\nDocs: https://github.com/raya-voice-ai/bakbak-mcp\n`,
        );
        return;
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        sendJson(res, 200, oauth.protectedResourceMetadata(), {
          'Cache-Control': 'public, max-age=3600',
        });
        return;
      case 'GET /.well-known/oauth-authorization-server':
      case 'GET /.well-known/oauth-authorization-server/mcp':
        sendJson(res, 200, oauth.authorizationServerMetadata(), {
          'Cache-Control': 'public, max-age=3600',
        });
        return;
      case 'POST /register':
        await oauth.register(req, res);
        return;
      case 'GET /authorize':
        await oauth.authorizeGet(req, res, url.searchParams);
        return;
      case 'POST /authorize':
        await oauth.authorizePost(req, res);
        return;
      case 'POST /token':
        await oauth.token(req, res);
        return;
      default:
        sendJson(res, 404, { error: 'not_found' });
    }
  }

  const server = createServer((req, res) => {
    const started = performance.now();
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        path: (req.url ?? '/').split('?')[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        ip: clientIp(req),
      });
    });
    route(req, res).catch((error: unknown) => {
      logger.error('unhandled request error', { error, path: (req.url ?? '/').split('?')[0] });
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
      else res.destroy();
    });
  });
  // Longer than any proxy's idle timeout, so the proxy closes idle connections first.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;

  return {
    server,
    audioStore,
    async listen() {
      await audioStore.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return (server.address() as AddressInfo).port;
    },
    async close(graceMs = 10_000) {
      audioStore.stop();
      await mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeIdleConnections();
        // Streams still open after the grace period (long legacy SSE calls) are cut.
        setTimeout(() => {
          server.closeAllConnections();
        }, graceMs).unref();
      });
      await backend.close();
    },
  };
}
