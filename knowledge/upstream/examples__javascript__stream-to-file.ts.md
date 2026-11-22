---
id: examples/javascript/stream-to-file.ts
title: JavaScript example: stream-to-file.ts
description: SSE streaming to a file, with time to first audio.
url: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/stream-to-file.ts
---

# examples/javascript/stream-to-file.ts

A runnable example from the bakbak npm package. SSE streaming to a file, with time to first audio.

Source: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/stream-to-file.ts

```ts
// Stream one request over Server-Sent Events and write the audio as it arrives.
//   BAKBAK_API_KEY=… npx tsx examples/stream-to-file.ts
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Bakbak, toWav } from 'bakbak';
import { language, model, outPath, voice_id } from './_env.ts';

const client = new Bakbak();
const started = performance.now();
const stream = client.tts.stream({
  text: 'आपका पैकेज आज शाम तक पहुँच जाएगा। डिलीवरी से पहले राहुल आपको कॉल करेगा।',
  voice_id,
  language,
  model,
  output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
});

const raw = createWriteStream(outPath('stream.pcm'));
const parts: Uint8Array[] = [];
let first: number | undefined;
for await (const chunk of stream) {
  first ??= performance.now() - started;
  raw.write(chunk.audio); // play or forward it here; chunks always hold whole samples
  parts.push(chunk.audio);
}
raw.end();

const pcm = Buffer.concat(parts);
await writeFile(outPath('stream.wav'), toWav(pcm, { encoding: 'pcm_s16le', sampleRate: 24000 }));
console.log(
  `time to first audio ${first?.toFixed(0)} ms; ${pcm.length} bytes; request ${await stream.requestId}`,
);
console.log('wrote out/stream.pcm and out/stream.wav');
```
