---
id: examples/javascript/websocket-contexts.ts
title: JavaScript example: websocket-contexts.ts
description: Two contexts on one WebSocket.
url: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/websocket-contexts.ts
---

# examples/javascript/websocket-contexts.ts

A runnable example from the bakbak npm package. Two contexts on one WebSocket.

Source: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/websocket-contexts.ts

```ts
// Two independent contexts on one WebSocket: their requests run at the same time, and each
// context's audio arrives in its own order.
//   BAKBAK_API_KEY=… BAKBAK_BASE_URL=… npx tsx examples/websocket-contexts.ts
import { writeFile } from 'node:fs/promises';
import { Bakbak, toWav, type WebSocketContext } from 'bakbak';
import { language, model, outPath, voice_id } from './_env.ts';

const client = new Bakbak();
const ws = client.tts.websocket({
  voice_id,
  language,
  model,
  output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
});
await ws.connect(); // optional: the first request then pays no handshake

async function speak(ctx: WebSocketContext, sentences: string[], file: string): Promise<void> {
  for (const text of sentences) await ctx.send({ text });
  ctx.endInput();
  const parts: Uint8Array[] = [];
  for await (const audio of ctx.audio()) parts.push(audio);
  await writeFile(outPath(file), toWav(Buffer.concat(parts), { encoding: 'pcm_s16le', sampleRate: 16000 }));
  console.log(`${ctx.contextId}: ${sentences.length} requests → out/${file}`);
}

try {
  await Promise.all([
    speak(ws.context({ contextId: 'agent' }), ['नमस्ते!', 'मैं आपकी कैसे मदद कर सकता हूँ?'], 'agent.wav'),
    speak(ws.context({ contextId: 'hold' }), ['कृपया लाइन पर बने रहें।'], 'hold.wav'),
  ]);
} finally {
  await ws.close();
}
```
