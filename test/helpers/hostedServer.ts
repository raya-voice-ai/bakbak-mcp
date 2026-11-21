/** Starts hosted mode on a random local port, against the mock API. */

import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSdkBackend } from '../../src/backend/sdk.js';
import { type HostedApp, createHostedApp } from '../../src/http/app.js';
import { loadHostedConfig } from '../../src/http/config.js';
import { ClientMetadataResolver, type DocumentFetcher } from '../../src/http/oauth/cimd.js';
import { silentLogger } from '../../src/log.js';

export const TEST_SECRET = 'test-secret-that-is-long-enough-0123456789';

export interface HostedHarness {
  app: HostedApp;
  url: string;
  config: ReturnType<typeof loadHostedConfig>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

export async function startHosted(
  baseURL: string,
  options: { env?: Record<string, string>; documents?: DocumentFetcher } = {},
): Promise<HostedHarness> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const config = loadHostedConfig({
    MCP_PUBLIC_URL: url,
    MCP_TOKEN_SECRET: TEST_SECRET,
    BAKBAK_BASE_URL: baseURL,
    AUDIO_DIR: await mkdtemp(path.join(tmpdir(), 'bakbak-hosted-audio-')),
    PORT: String(port),
    HOST: '127.0.0.1',
    ...options.env,
  });
  const app = createHostedApp({
    config,
    backend: createSdkBackend({ baseURL, logger: silentLogger }),
    logger: silentLogger,
    ...(options.documents && { documents: new ClientMetadataResolver(options.documents) }),
  });
  await app.listen();
  return { app, url, config, close: () => app.close(100) };
}
