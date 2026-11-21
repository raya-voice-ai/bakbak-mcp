/**
 * Hosted-mode configuration, from environment variables only. Every public URL
 * the server advertises is built from `MCP_PUBLIC_URL`, never from the request's
 * Host header.
 */

import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BlockList } from 'node:net';

import { parseTrustedProxies } from './ip.js';
import { Sealer } from './sealer.js';

export interface HostedConfig {
  /** Origin the server is reached at, e.g. `https://mcp.bakbak.si` (no trailing slash). */
  publicUrl: string;
  /** The MCP endpoint and OAuth resource identifier: `<publicUrl>/mcp`. */
  resourceUrl: string;
  sealer: Sealer;
  baseURL: string | undefined;
  audioDir: string;
  audioTtlMs: number;
  audioMaxBytes: number;
  port: number;
  host: string;
  trustedProxies: BlockList;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `3600` (seconds), `90s`, `30m`, `1h`. */
export function parseDuration(value: string, name: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!match?.[1])
    throw new ConfigError(`${name} must be a duration such as 3600, 90s, 30m or 1h.`);
  const ms = Number(match[1]) * (DURATION_UNITS[(match[2] ?? 's').toLowerCase()] ?? 1000);
  if (ms <= 0) throw new ConfigError(`${name} must be positive.`);
  return Math.round(ms);
}

const SIZE_UNITS: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** `1073741824`, `512M`, `2G` (binary units; a trailing B or iB is allowed). */
export function parseSize(value: string, name: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?$/i.exec(value.trim());
  if (!match?.[1]) throw new ConfigError(`${name} must be a size such as 1073741824, 512M or 2G.`);
  const bytes = Math.floor(Number(match[1]) * (SIZE_UNITS[(match[2] ?? '').toLowerCase()] ?? 1));
  if (bytes <= 0) throw new ConfigError(`${name} must be positive.`);
  return bytes;
}

function parsePublicUrl(value: string | undefined): string {
  if (!value) throw new ConfigError('MCP_PUBLIC_URL is required, e.g. https://mcp.bakbak.si');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`MCP_PUBLIC_URL is not a URL: ${value}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('MCP_PUBLIC_URL must be https (http is allowed only for localhost).');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
    throw new ConfigError(
      'MCP_PUBLIC_URL must be an origin only, without a path, e.g. https://mcp.bakbak.si',
    );
  }
  return url.origin;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const publicUrl = parsePublicUrl(env.MCP_PUBLIC_URL?.trim());
  const secret = env.MCP_TOKEN_SECRET;
  if (!secret) {
    throw new ConfigError(
      'MCP_TOKEN_SECRET is required (generate one with: openssl rand -base64 48).',
    );
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ConfigError('PORT must be a port number.');
  let trustedProxies: BlockList;
  try {
    trustedProxies = parseTrustedProxies(env.TRUSTED_PROXIES);
  } catch (error) {
    throw new ConfigError(`TRUSTED_PROXIES: ${(error as Error).message}`);
  }
  return {
    publicUrl,
    resourceUrl: `${publicUrl}/mcp`,
    sealer: Sealer.fromSecret(secret),
    baseURL: env.BAKBAK_BASE_URL?.trim() || undefined,
    audioDir: path.resolve(env.AUDIO_DIR?.trim() || path.join(tmpdir(), 'bakbak-mcp-audio')),
    audioTtlMs: env.AUDIO_TTL ? parseDuration(env.AUDIO_TTL, 'AUDIO_TTL') : 3_600_000,
    audioMaxBytes: env.AUDIO_MAX_BYTES
      ? parseSize(env.AUDIO_MAX_BYTES, 'AUDIO_MAX_BYTES')
      : 2 * 1024 ** 3,
    port,
    host: env.HOST?.trim() || '0.0.0.0',
    trustedProxies,
  };
}
