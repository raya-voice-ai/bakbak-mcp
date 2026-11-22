/**
 * Prompts: ready-made requests a person can pick from their MCP client (slash
 * commands in Claude Code, the prompt menu elsewhere). Each one points the
 * model at the bundled documentation and the tools, in the order that gives a
 * correct integration.
 */

import { type GetPromptResult, type McpServer, completable } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { KNOWN_LANGUAGES } from './backend/types.js';
import { bundledKnowledge } from './knowledge/index.js';

export const PROMPT_NAMES = [
  'integrate_bakbak',
  'review_bakbak_integration',
  'choose_voice',
] as const;

const PLATFORMS = [
  'livekit',
  'pipecat',
  'twilio',
  'plivo',
  'exotel',
  'vonage',
  'sip',
  'web',
  'nextjs',
  'mobile',
  'python',
  'javascript',
  'go',
  'java',
  'batch',
  'voice-agent',
] as const;

/** The package to build with, by the page a platform maps to. */
const PACKAGE_FOR_PAGE: Record<string, string> = {
  livekit: 'livekit-plugins-bakbak',
  pipecat: 'the Python SDK (bakbak-python) inside a custom Pipecat TTSService',
  telephony: 'the Python or JavaScript SDK, whichever the project uses, over the WebSocket',
  'voice-agents': 'the Python or JavaScript SDK over the WebSocket',
  web: 'the JavaScript or Python SDK on the server, never in the browser or app',
  'long-form': 'the Python or JavaScript SDK, whichever the project uses',
  'python-sdk': 'the Python SDK (pip install --pre bakbak-python, import bakbak)',
  'javascript-sdk': 'the JavaScript SDK (npm install bakbak)',
  'raw-api': 'the HTTP, SSE or WebSocket API directly (there is no SDK for this language)',
};

function user(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

const startsWith = (options: readonly string[]) => (value: string | undefined) =>
  options.filter((o) => o.startsWith((value ?? '').toLowerCase()));

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'integrate_bakbak',
    {
      title: 'Integrate Bakbak text-to-speech',
      description:
        'Add Bakbak speech to the current project: picks the right SDK, plugin or API for the platform, a voice, the audio format, and production error handling, from the bundled docs.',
      argsSchema: z.object({
        // The completable schema goes inside optional(): the SDK unwraps optional
        // fields before it looks for a completer.
        platform: completable(z.string(), startsWith(PLATFORMS))
          .optional()
          .describe(
            'Where speech goes: livekit, pipecat, twilio, plivo, exotel, vonage, sip, web, nextjs, mobile, python, javascript, go, java, batch… (optional)',
          ),
        goal: z
          .string()
          .optional()
          .describe(
            'What you are building, e.g. "a Hindi support agent on phone calls" (optional)',
          ),
      }),
    },
    ({ platform, goal }) => {
      const page = platform ? bundledKnowledge().find(platform) : null;
      const pkg = page ? PACKAGE_FOR_PAGE[page.id] : undefined;
      return user(
        [
          `Add Bakbak text-to-speech to this project${platform ? ` (platform: ${platform})` : ''}.${goal ? ` Goal: ${goal}.` : ''}`,
          '',
          "Work with the Bakbak MCP server's tools:",
          '1. Look at the project first: its language and framework, how audio is produced and played today, and any existing text-to-speech code to replace.',
          page
            ? `2. Read the docs with read_docs: '${page.id}', then 'best-practices'. Use search_docs for anything specific. Don't guess SDK method names, parameters or voice ids.`
            : "2. Read the docs with read_docs: 'start-here' to choose the integration for this project, the page it points to, then 'best-practices'. Use search_docs for anything specific. Don't guess SDK method names, parameters or voice ids.",
          '3. Pick a voice with list_voices for the language, and pass its model with it. Offer to let me hear two or three candidates with text_to_speech before one is hard-coded (that uses credits, so ask first).',
          `4. Implement it with ${pkg ?? 'the official package for this stack'}. Read the key from BAKBAK_API_KEY; never hard-code it or send it to a browser or app. Ask for the output_format the audio is played or forwarded in. Handle errors by error_code and log request_id.`,
          '5. Then tell me how to run and test it, and what to configure (environment variables, voice id).',
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'review_bakbak_integration',
    {
      title: 'Review a Bakbak integration',
      description:
        "Check this project's Bakbak code against the documented best practices: transport, formats, retries, cancel, key handling, text and voices.",
      argsSchema: z.object({
        focus: z
          .string()
          .optional()
          .describe('Anything to look at first, e.g. "latency", "errors", "telephony" (optional)'),
      }),
    },
    ({ focus }) =>
      user(
        [
          `Review how this project uses Bakbak text-to-speech${focus ? `, focusing on ${focus}` : ''}.`,
          '',
          "First read_docs 'best-practices' and 'troubleshooting', and the page for the platform the project uses (see 'start-here'). Then find every place the project calls Bakbak and check:",
          '- the transport (WebSocket for conversational audio, opened early and reused; one context per turn);',
          '- output_format matches where the audio goes, and the decoding matches output_format;',
          '- voice_id and model belong together; Hindi is in Devanagari; speed only on standard voices;',
          '- retries happen only before audio, errors are handled by error_code, request_id is logged;',
          '- interruptions cancel the context and clear any downstream buffer;',
          '- the API key stays on the server, from BAKBAK_API_KEY, and is never logged;',
          '- text over 5,000 characters is split with the SDK segmenter.',
          '',
          'List each problem with its file and line, why it matters, and the fix. Use search_docs to confirm SDK behaviour before claiming a bug.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'choose_voice',
    {
      title: 'Choose a Bakbak voice',
      description:
        'Find voices for a language, compare a few on a sample sentence, and get the voice_id and model to use in code.',
      argsSchema: z.object({
        language: completable(
          z
            .string()
            .describe('Language code: hi, mr, te, kn, bn, as, gu, ne, ml, ta, en, en-in, en-us'),
          startsWith(KNOWN_LANGUAGES),
        ),
        use_case: z
          .string()
          .optional()
          .describe('What the voice is for, e.g. "a calm support agent on phone calls" (optional)'),
      }),
    },
    ({ language, use_case }) =>
      user(
        [
          `Help me choose a Bakbak voice for language "${language}"${use_case ? ` for ${use_case}` : ''}.`,
          '',
          `1. Call list_voices with language "${language}" and show the voices with their model.`,
          '2. Suggest a short sample sentence that fits the use case (Hindi and other Indian languages in their own script).',
          '3. Ask me which two or three to hear, then synthesize the sample with each using text_to_speech (it uses credits).',
          '4. When I pick one, give me its voice_id and model exactly as they go in code, and remind me that speed changes standard voices only.',
        ].join('\n'),
      ),
  );
}
