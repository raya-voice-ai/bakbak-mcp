import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { filterVoices } from '../voices.js';
import type { ToolEnv } from './env.js';
import { apiError, missingKeyError, rateLimitedError } from './errors.js';
import type { ListVoicesArgs, ListVoicesOutput } from './schemas.js';

export const LIST_VOICES_DESCRIPTION =
  'List Bakbak voices, optionally filtered by language, model and a name substring. Free: uses no credits. Each voice has an id (pass it to text_to_speech as voice_id), a name, a language and a model (pass it as model).';

function describeFilters(args: ListVoicesArgs): string {
  const parts = [
    args.language !== undefined && `language ${args.language}`,
    args.model !== undefined && `model ${args.model}`,
    args.query && `name containing "${args.query}"`,
  ].filter(Boolean);
  return parts.length > 0 ? ` for ${parts.join(', ')}` : '';
}

export async function listVoices(
  args: ListVoicesArgs,
  env: ToolEnv,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const apiKey = env.apiKey;
  if (!apiKey) return missingKeyError(env.mode);
  const wait = env.rateLimit?.(apiKey);
  if (wait !== undefined) return rateLimitedError(wait);

  const client = env.backend.client(apiKey);
  try {
    const all = await env.voices.get(apiKey, () =>
      client.listVoices({ signal: ctx.mcpReq.signal }),
    );
    const matching = filterVoices(all, args);
    const voices = matching
      .slice(0, args.limit)
      .map(({ id, name, language, model }) => ({ id, name, language, model }));
    const output: ListVoicesOutput = { voices, count: voices.length, total: matching.length };
    const shown = output.count < output.total ? `; showing the first ${output.count}` : '';
    return {
      content: [
        { type: 'text', text: `Found ${output.total} voices${describeFilters(args)}${shown}.` },
        { type: 'text', text: JSON.stringify(output, null, 2) },
      ],
      structuredContent: output,
    };
  } catch (error) {
    const info = env.backend.describeError(error);
    if (!info) throw error;
    env.logger.warn('api error', {
      tool: 'list_voices',
      error_type: info.type,
      status: info.status,
      request_id: info.requestId,
    });
    return apiError(info, env.mode, env.backend.baseURL);
  }
}
