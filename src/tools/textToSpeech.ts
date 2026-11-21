import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import {
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_SAMPLE_RATE,
  acceptedExtensions,
  audioDuration,
  extensionFor,
  mimeTypeFor,
  roundSeconds,
} from '../audio/format.js';
import { SynthesisInputError, synthesize } from '../audio/synthesize.js';
import type { OutputFormat, TtsClient, Voice } from '../backend/types.js';
import { type Delivered, DeliveryError } from '../delivery.js';
import { buildFileName } from '../local/files.js';
import { codePointLength } from '../util.js';
import { filterVoices } from '../voices.js';
import type { ToolEnv } from './env.js';
import {
  type ServerMode,
  apiError,
  missingKeyError,
  rateLimitedError,
  toolError,
} from './errors.js';
import { MAX_INLINE_AUDIO_BYTES, type TtsArgs } from './schemas.js';

/** The tool description; only the sentence about where audio goes differs by mode. */
export function textToSpeechDescription(mode: ServerMode): string {
  const result =
    mode === 'local'
      ? 'Convert text to natural speech with Bakbak and save it as an audio file on this computer.'
      : 'Convert text to natural speech with Bakbak and return a download link for the audio (valid for one hour).';
  return [
    result,
    'Uses Bakbak credits for every character, so call it once per text and do not retry a success.',
    'Pick a voice for the language with list_voices first and pass its id as voice_id and its model as model (a voice works only with its own model).',
    'Hindi text must be in Devanagari script. Text up to 50,000 characters; long text is split at sentence boundaries and joined into one file.',
  ].join(' ');
}

interface ResolvedVoice {
  voiceId: string;
  voiceName: string | undefined;
  model: string | undefined;
}

function describeFilters(language: string, model: string | undefined): string {
  return model === undefined
    ? `language "${language}"`
    : `language "${language}" and model "${model}"`;
}

async function resolveVoice(
  args: TtsArgs,
  env: ToolEnv,
  apiKey: string,
  client: TtsClient,
  signal: AbortSignal,
): Promise<ResolvedVoice | CallToolResult> {
  const fetchVoices = (): Promise<Voice[]> =>
    env.voices.get(apiKey, () => client.listVoices({ signal }));
  if (args.voice_id !== undefined && args.model !== undefined) {
    // Nothing to look up; use a cached name for the file name if there is one.
    const known = env.voices.peek(apiKey)?.find((v) => v.id === args.voice_id);
    return { voiceId: args.voice_id, voiceName: known?.name, model: args.model };
  }
  const voices = await fetchVoices();
  if (args.voice_id !== undefined) {
    const voice = voices.find((v) => v.id === args.voice_id);
    // An unknown id goes to the API as given; its answer is the authoritative error.
    return { voiceId: args.voice_id, voiceName: voice?.name, model: voice?.model };
  }
  const [first] = filterVoices(voices, { language: args.language, model: args.model });
  if (!first) {
    return toolError({
      message: `No voice is available for ${describeFilters(args.language, args.model)}.`,
      next_step:
        'Call list_voices to see the languages and models that have voices, then pass a voice_id.',
    });
  }
  return { voiceId: first.id, voiceName: first.name, model: first.model };
}

function reportedFormat(format: OutputFormat) {
  const sampleRate =
    format.sample_rate ?? (format.container === 'mp3' ? undefined : DEFAULT_SAMPLE_RATE);
  return {
    container: format.container,
    ...(format.encoding !== undefined && { encoding: format.encoding }),
    ...(sampleRate !== undefined && { sample_rate: sampleRate }),
    mime_type: mimeTypeFor(format),
  };
}

function summary(
  delivered: Delivered,
  seconds: number,
  format: OutputFormat,
  language: string,
  voice: string,
): string {
  const what = `${seconds.toFixed(seconds < 10 ? 2 : 1)} s of ${format.container.toUpperCase()} audio (${language}, voice ${voice})`;
  return 'file_path' in delivered
    ? `Saved ${what} to ${delivered.file_path}`
    : `Created ${what}: ${delivered.audio_url} (link expires ${delivered.expires_at})`;
}

function progressReporter(ctx: ServerContext): ((done: number, total: number) => void) | undefined {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  return (done, total) => {
    void ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: done,
          total,
          message: `Synthesized part ${done} of ${total}`,
        },
      })
      .catch(() => undefined); // progress is best effort
  };
}

export async function textToSpeech(
  args: TtsArgs,
  env: ToolEnv,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const apiKey = env.apiKey;
  if (!apiKey) return missingKeyError(env.mode);
  const wait = env.rateLimit?.(apiKey);
  if (wait !== undefined) return rateLimitedError(wait);

  const started = performance.now();
  const characters = codePointLength(args.text);
  const format: OutputFormat = args.output_format ?? { ...DEFAULT_OUTPUT_FORMAT };
  const client = env.backend.client(apiKey);
  const signal = ctx.mcpReq.signal;
  const log = env.logger.child({ tool: 'text_to_speech', characters });
  let requestIds: string[] = [];

  try {
    const voice = await resolveVoice(args, env, apiKey, client, signal);
    if ('content' in voice) return voice;

    const extension = extensionFor(format);
    const target = await env.delivery.prepare({
      format,
      extension,
      acceptedExtensions: acceptedExtensions(format),
      mimeType: mimeTypeFor(format),
      fileName: buildFileName({
        language: args.language,
        voiceName: voice.voiceName,
        voiceId: voice.voiceId,
        extension,
      }),
      outputPath: args.output_path,
      overwrite: args.overwrite ?? false,
    });

    const result = await synthesize(
      env.backend,
      client,
      {
        text: args.text,
        voice_id: voice.voiceId,
        language: args.language,
        model: voice.model,
        speed: args.speed,
        output_format: format,
      },
      { signal, onPieceDone: progressReporter(ctx) },
    );
    requestIds = result.requestIds;
    const delivered = await target.commit(result.data);

    const seconds = roundSeconds(audioDuration(result.data, format));
    const output = {
      ...delivered,
      format: reportedFormat(format),
      duration_seconds: seconds,
      characters,
      voice_id: voice.voiceId,
      model: voice.model ?? 'standard',
      language: args.language,
      request_ids: requestIds,
    };
    log.info('synthesized', {
      pieces: result.pieces,
      bytes: result.data.byteLength,
      audio_seconds: seconds,
      request_ids: requestIds,
      ms: Math.round(performance.now() - started),
    });

    const where =
      'file_path' in delivered
        ? `saved to ${delivered.file_path}`
        : `available at ${delivered.audio_url}`;
    if (args.include_audio && result.data.byteLength > MAX_INLINE_AUDIO_BYTES) {
      const mb = (result.data.byteLength / (1024 * 1024)).toFixed(1);
      return toolError({
        message: `The audio was created and ${where}, but at ${mb} MB it is over the 1 MB limit for include_audio, so it is not returned inline. Do not synthesize this text again.`,
        next_step:
          'Give the user the file location instead. For inline audio, use shorter text, mp3, or a lower sample_rate.',
        request_id: requestIds.join(','),
      });
    }

    const text = summary(
      delivered,
      seconds,
      format,
      args.language,
      voice.voiceName ?? voice.voiceId,
    );
    return {
      content: [
        { type: 'text', text },
        { type: 'text', text: JSON.stringify(output, null, 2) },
        ...(args.include_audio
          ? [
              {
                type: 'audio' as const,
                data: Buffer.from(
                  result.data.buffer,
                  result.data.byteOffset,
                  result.data.byteLength,
                ).toString('base64'),
                mimeType: mimeTypeFor(format),
              },
            ]
          : []),
      ],
      structuredContent: output,
    };
  } catch (error) {
    if (error instanceof DeliveryError || error instanceof SynthesisInputError) {
      return toolError({
        message: error.message,
        next_step:
          requestIds.length > 0
            ? 'The audio was synthesized but could not be delivered; change the destination or format before trying again.'
            : 'Fix the argument and call text_to_speech again.',
        request_id: requestIds.length > 0 ? requestIds.join(',') : undefined,
      });
    }
    const info = env.backend.describeError(error);
    if (info) {
      log.warn('api error', {
        error_type: info.type,
        status: info.status,
        error_code: info.errorCode,
        request_id: info.requestId,
        ms: Math.round(performance.now() - started),
      });
      return apiError(info, env.mode, env.backend.baseURL);
    }
    log.error('unexpected error', { error, request_ids: requestIds });
    return toolError({
      message:
        env.mode === 'local' && error instanceof Error
          ? `Unexpected error: ${error.message}`
          : 'Unexpected server error.',
      next_step:
        requestIds.length > 0
          ? 'The audio was synthesized but could not be saved. Fix the problem above before trying again.'
          : 'Try again. If it keeps failing, report it to support@getraya.app.',
      request_id: requestIds.length > 0 ? requestIds.join(',') : undefined,
    });
  }
}
