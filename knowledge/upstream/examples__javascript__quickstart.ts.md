---
id: examples/javascript/quickstart.ts
title: JavaScript example: quickstart.ts
description: List voices, synthesize, save a WAV.
url: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/quickstart.ts
---

# examples/javascript/quickstart.ts

A runnable example from the bakbak npm package. List voices, synthesize, save a WAV.

Source: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/quickstart.ts

```ts
// Quickstart: list voices, synthesize a whole file, save it.
//   BAKBAK_API_KEY=… npx tsx examples/quickstart.ts
import { Bakbak } from 'bakbak';
import { language, model, outPath, voice_id } from './_env.ts';

const client = new Bakbak(); // reads BAKBAK_API_KEY (and BAKBAK_BASE_URL)

const { voices, count } = await client.voices.list({ model: 'm1', language: 'hi' });
console.log(
  `${count} m1 Hindi voices, e.g. ${voices
    .map((v) => v.name)
    .slice(0, 5)
    .join(', ')}`,
);

const audio = await client.tts.generate({
  text: 'नमस्ते! बकबक में आपका स्वागत है।',
  voice_id,
  language,
  model,
});
await audio.save(outPath('quickstart.wav'));
console.log(
  `saved out/quickstart.wav: ${audio.data.length} bytes, ${audio.contentType}, request ${audio.requestId}`,
);
```
