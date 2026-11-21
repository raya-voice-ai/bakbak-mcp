/**
 * Programmatic API, for embedding the Bakbak MCP server in another process.
 * Most people run the `bakbak-mcp` command instead.
 */

export { createBakbakServer, TOOL_NAMES } from './server.js';
export { createSdkBackend, DEFAULT_BASE_URL, type SdkBackendOptions } from './backend/sdk.js';
export type * from './backend/types.js';
export { createLocalDelivery } from './local/delivery.js';
export { defaultOutputDir, resolveOutputDir } from './local/files.js';
export { runStdio, type StdioOptions, type RunningStdio } from './local/stdio.js';
export { createHostedApp, type HostedApp, type HostedAppOptions } from './http/app.js';
export { loadHostedConfig, type HostedConfig } from './http/config.js';
export type { Committed, Delivered, Delivery, DeliveryRequest, PendingAudio } from './delivery.js';
export type { ToolEnv } from './tools/env.js';
export type { ServerMode } from './tools/errors.js';
export { VoiceCache } from './voices.js';
export { createLogger, type Logger, type LogLevel } from './log.js';
export { PACKAGE_NAME, VERSION } from './version.js';
