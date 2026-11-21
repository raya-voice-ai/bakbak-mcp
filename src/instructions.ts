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
  ].join('\n');
}
