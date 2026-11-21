/**
 * The MCP server: two tools and short instructions, identical in local and
 * hosted mode except for where audio goes.
 */

import { McpServer } from '@modelcontextprotocol/server';

import { serverInstructions } from './instructions.js';
import type { ToolEnv } from './tools/env.js';
import { LIST_VOICES_DESCRIPTION, listVoices } from './tools/listVoices.js';
import {
  hostedTtsInput,
  hostedTtsOutput,
  listVoicesInput,
  listVoicesOutput,
  localTtsInput,
  localTtsOutput,
} from './tools/schemas.js';
import { TEXT_TO_SPEECH_DESCRIPTION, textToSpeech } from './tools/textToSpeech.js';
import { PACKAGE_NAME, VERSION } from './version.js';

export const TOOL_NAMES = ['text_to_speech', 'list_voices'] as const;

const TTS_ANNOTATIONS = {
  title: 'Text to speech',
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const VOICES_ANNOTATIONS = {
  title: 'List voices',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function createBakbakServer(env: ToolEnv): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      title: 'Bakbak',
      version: VERSION,
      websiteUrl: 'https://bakbak.getraya.app',
    },
    { instructions: serverInstructions(env.mode), capabilities: { tools: {} } },
  );

  if (env.mode === 'local') {
    server.registerTool(
      'text_to_speech',
      {
        title: TTS_ANNOTATIONS.title,
        description: TEXT_TO_SPEECH_DESCRIPTION,
        inputSchema: localTtsInput,
        outputSchema: localTtsOutput,
        annotations: TTS_ANNOTATIONS,
      },
      (args, ctx) => textToSpeech(args, env, ctx),
    );
  } else {
    server.registerTool(
      'text_to_speech',
      {
        title: TTS_ANNOTATIONS.title,
        description: TEXT_TO_SPEECH_DESCRIPTION,
        inputSchema: hostedTtsInput,
        outputSchema: hostedTtsOutput,
        annotations: TTS_ANNOTATIONS,
      },
      (args, ctx) => textToSpeech(args, env, ctx),
    );
  }

  server.registerTool(
    'list_voices',
    {
      title: VOICES_ANNOTATIONS.title,
      description: LIST_VOICES_DESCRIPTION,
      inputSchema: listVoicesInput,
      outputSchema: listVoicesOutput,
      annotations: VOICES_ANNOTATIONS,
    },
    (args, ctx) => listVoices(args, env, ctx),
  );

  return server;
}
