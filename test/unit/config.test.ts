import { describe, expect, it } from 'vitest';

import { ConfigError, loadHostedConfig, parseDuration, parseSize } from '../../src/http/config.js';

const SECRET = 'x'.repeat(48);

describe('hosted config', () => {
  it('parses durations and sizes', () => {
    expect(parseDuration('3600', 'T')).toBe(3_600_000);
    expect(parseDuration('90s', 'T')).toBe(90_000);
    expect(parseDuration('30m', 'T')).toBe(1_800_000);
    expect(parseDuration('1h', 'T')).toBe(3_600_000);
    expect(() => parseDuration('soon', 'T')).toThrow(ConfigError);
    expect(parseSize('1024', 'S')).toBe(1024);
    expect(parseSize('512M', 'S')).toBe(512 * 1024 ** 2);
    expect(parseSize('2GiB', 'S')).toBe(2 * 1024 ** 3);
    expect(() => parseSize('lots', 'S')).toThrow(ConfigError);
  });

  it('builds URLs from MCP_PUBLIC_URL only', () => {
    const config = loadHostedConfig({
      MCP_PUBLIC_URL: 'https://mcp.bakbak.si/',
      MCP_TOKEN_SECRET: SECRET,
    });
    expect(config.publicUrl).toBe('https://mcp.bakbak.si');
    expect(config.resourceUrl).toBe('https://mcp.bakbak.si/mcp');
    expect(config.audioTtlMs).toBe(3_600_000);
    expect(config.port).toBe(8080);
  });

  it.each([
    [{ MCP_TOKEN_SECRET: SECRET }, /MCP_PUBLIC_URL is required/],
    [{ MCP_PUBLIC_URL: 'http://mcp.bakbak.si', MCP_TOKEN_SECRET: SECRET }, /https/],
    [{ MCP_PUBLIC_URL: 'https://mcp.bakbak.si/mcp', MCP_TOKEN_SECRET: SECRET }, /origin only/],
    [{ MCP_PUBLIC_URL: 'https://mcp.bakbak.si' }, /MCP_TOKEN_SECRET/],
    [{ MCP_PUBLIC_URL: 'https://mcp.bakbak.si', MCP_TOKEN_SECRET: SECRET, PORT: 'eighty' }, /PORT/],
    [
      {
        MCP_PUBLIC_URL: 'https://mcp.bakbak.si',
        MCP_TOKEN_SECRET: SECRET,
        TRUSTED_PROXIES: 'nope',
      },
      /TRUSTED_PROXIES/,
    ],
  ])('refuses %j', (env, message) => {
    expect(() => loadHostedConfig(env)).toThrow(message);
  });

  it('allows plain http on localhost for development', () => {
    expect(
      loadHostedConfig({ MCP_PUBLIC_URL: 'http://127.0.0.1:8080', MCP_TOKEN_SECRET: SECRET })
        .publicUrl,
    ).toBe('http://127.0.0.1:8080');
  });
});
