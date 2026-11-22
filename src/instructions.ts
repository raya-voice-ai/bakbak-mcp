import type { ServerMode } from './tools/errors.js';

/** Server `instructions`: short guidance the client gives the model. */
export function serverInstructions(mode: ServerMode): string {
  const delivery =
    mode === 'local'
      ? 'text_to_speech saves an audio file on this computer and returns its absolute path; tell the user where it is.'
      : 'text_to_speech returns a private download link that works for one hour; give the user the link.';
  return [
    'Bakbak turns text into natural speech in Indian languages and English (hi, mr, te, kn, bn, as, gu, ne, ml, ta, pa, en, en-in, en-us).',
    'Choose a voice with list_voices for the language, then pass its id as voice_id and its model as model: a voice works only with its own model.',
    'Write Hindi in Devanagari script, never romanised (नमस्ते, not namaste). Indian names inside English text sound best written in Devanagari.',
    `text_to_speech uses Bakbak credits for every character, so synthesize each text once; list_voices is free. ${delivery}`,
    "To help someone build with Bakbak (the Python or JavaScript SDK, the LiveKit Agents plugin, Pipecat, Twilio, Plivo, Exotel, Vonage or SIP calls, web and mobile apps, or the HTTP, SSE and WebSocket API from any language), read the bundled docs before writing code: read_docs page 'start-here' picks the integration, 'best-practices' and 'troubleshooting' cover production use, and search_docs finds any method, option or error_code. Don't guess SDK names, parameters or voice ids; get real voice ids from list_voices. The docs tools are free and need no API key.",
  ].join('\n');
}
