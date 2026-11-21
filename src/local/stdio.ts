/** Local mode: the MCP server on stdin/stdout, writing audio files on this machine. */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import type { Backend } from '../backend/types.js';
import type { Logger } from '../log.js';
import { createBakbakServer } from '../server.js';
import { VoiceCache } from '../voices.js';
import { createLocalDelivery } from './delivery.js';
import { resolveOutputDir } from './files.js';

/**
 * An environment value, or undefined when empty. A host that leaves an optional
 * setting unset may pass its placeholder through verbatim (`${user_config.x}`);
 * that counts as unset too.
 */
export function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !/^\$\{[^}]*\}$/.test(trimmed) ? trimmed : undefined;
}

export interface StdioOptions {
  backend: Backend;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}

export interface RunningStdio {
  outputDir: string;
  close(): Promise<void>;
}

export function runStdio(options: StdioOptions): RunningStdio {
  const env = options.env ?? process.env;
  const { backend, logger } = options;
  const apiKey = envValue(env.BAKBAK_API_KEY);
  const outputDir = resolveOutputDir(envValue(env.BAKBAK_MCP_OUTPUT_DIR));
  const voices = new VoiceCache();
  const delivery = createLocalDelivery(outputDir);

  const handle = serveStdio(
    () => createBakbakServer({ mode: 'local', backend, apiKey, voices, delivery, logger }),
    {
      onerror: (error) => {
        logger.warn('stdio error', { error });
      },
    },
  );

  if (apiKey) {
    // Prewarm: resolve DNS, open the TLS connection and cache the voice list before the first call.
    voices
      .get(apiKey, () => backend.client(apiKey).listVoices())
      .catch((error: unknown) => {
        logger.warn('prewarm failed', { error: backend.describeError(error)?.message ?? error });
      });
  } else {
    logger.warn('BAKBAK_API_KEY is not set: tool calls will return an error until it is.');
  }
  logger.info('bakbak-mcp ready (stdio)', { output_dir: outputDir, base_url: backend.baseURL });

  return {
    outputDir,
    async close() {
      await handle.close();
      await backend.close();
    },
  };
}
