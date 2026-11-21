#!/usr/bin/env node
/**
 * `bakbak-mcp`          local mode: MCP over stdio, audio saved as files.
 * `bakbak-mcp --http`   hosted mode: streamable HTTP at /mcp with OAuth.
 */

import { createSdkBackend } from './backend/sdk.js';
import { ConfigError, loadHostedConfig } from './http/config.js';
import { SecretConfigError } from './http/sealer.js';
import { envValue, runStdio } from './local/stdio.js';
import { createLogger, parseLogLevel } from './log.js';
import { PACKAGE_NAME, VERSION } from './version.js';

const HELP = `${PACKAGE_NAME} ${VERSION}: the official MCP server for the Bakbak text-to-speech API.

Usage:
  bakbak-mcp            Run over stdio (for Claude Desktop, Claude Code, Cursor, VS Code…)
  bakbak-mcp --http     Run the hosted streamable HTTP server (/mcp, OAuth, audio links)
  bakbak-mcp --version  Print the version

Local mode environment:
  BAKBAK_API_KEY          Your API key (https://bakbak.getraya.app)
  BAKBAK_BASE_URL         API base URL (default https://hub.getraya.app)
  BAKBAK_MCP_OUTPUT_DIR   Where audio files go (default ~/Documents/Bakbak or ~/Bakbak)

Hosted mode environment:
  MCP_PUBLIC_URL, MCP_TOKEN_SECRET, BAKBAK_BASE_URL, AUDIO_DIR, AUDIO_TTL,
  AUDIO_MAX_BYTES, PORT, HOST, TRUSTED_PROXIES, LOG_LEVEL (see the README)
`;

function main(argv: readonly string[]): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const unknown = argv.filter((a) => a !== '--http');
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument: ${unknown.join(' ')}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    base: { service: PACKAGE_NAME },
  });
  const shutdownOn = (close: () => Promise<void>): void => {
    let closing = false;
    const stop = (signal: string): void => {
      if (closing) return;
      closing = true;
      logger.info('shutting down', { signal });
      close().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('shutdown failed', { error });
          process.exit(1);
        },
      );
    };
    process.on('SIGINT', () => {
      stop('SIGINT');
    });
    process.on('SIGTERM', () => {
      stop('SIGTERM');
    });
  };

  if (!argv.includes('--http')) {
    const backend = createSdkBackend({ baseURL: envValue(process.env.BAKBAK_BASE_URL), logger });
    const running = runStdio({ backend, logger });
    shutdownOn(() => running.close());
    return;
  }

  void (async () => {
    let config;
    try {
      config = loadHostedConfig();
    } catch (error) {
      if (error instanceof ConfigError || error instanceof SecretConfigError) {
        logger.error('invalid configuration', { error: error.message });
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    const { createHostedApp } = await import('./http/app.js');
    const backend = createSdkBackend({ baseURL: config.baseURL, logger });
    const app = createHostedApp({ config, backend, logger });
    const port = await app.listen();
    logger.info('bakbak-mcp ready (http)', {
      port,
      public_url: config.publicUrl,
      base_url: backend.baseURL,
      audio_dir: config.audioDir,
    });
    shutdownOn(() => app.close());
  })().catch((error: unknown) => {
    logger.error('failed to start', { error });
    process.exit(1);
  });
}

main(process.argv.slice(2));
