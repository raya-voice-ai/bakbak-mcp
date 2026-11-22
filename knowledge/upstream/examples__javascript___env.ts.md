---
id: examples/javascript/_env.ts
title: JavaScript example: _env.ts
description: Settings shared by the JavaScript examples.
url: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/_env.ts
---

# examples/javascript/_env.ts

A runnable example from the bakbak npm package. Settings shared by the JavaScript examples.

Source: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/_env.ts

```ts
// Settings shared by the examples, from environment variables.
// BAKBAK_API_KEY is required; BAKBAK_BASE_URL defaults to production.
import { mkdirSync } from 'node:fs';

/** "Anika M1", an m1 Hindi voice. List others with `npx tsx examples/quickstart.ts`. */
export const voice_id = process.env.BAKBAK_VOICE_ID ?? '009ae8b5-4a03-492d-af1c-3055989ac734';
export const language = process.env.BAKBAK_LANGUAGE ?? 'hi';
export const model = process.env.BAKBAK_MODEL ?? 'm1';

/** Where examples write audio. */
export function outPath(name: string): string {
  mkdirSync('out', { recursive: true });
  return `out/${name}`;
}
```
