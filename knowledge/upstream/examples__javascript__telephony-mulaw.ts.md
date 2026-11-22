---
id: examples/javascript/telephony-mulaw.ts
title: JavaScript example: telephony-mulaw.ts
description: 8 kHz μ-law for telephony over the WebSocket.
url: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/telephony-mulaw.ts
---

# examples/javascript/telephony-mulaw.ts

A runnable example from the bakbak npm package. 8 kHz μ-law for telephony over the WebSocket.

Source: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/telephony-mulaw.ts

```ts
// Telephony audio: raw 8 kHz μ-law, ready for a SIP/RTP or Twilio media stream, with no
// transcoding. Chunks arrive as the model generates them; each one can go out as-is.
//   BAKBAK_API_KEY=… BAKBAK_BASE_URL=… npx tsx examples/telephony-mulaw.ts
import { writeFile } from 'node:fs/promises';
import { Bakbak, toWav } from 'bakbak';
import { language, model, outPath, voice_id } from './_env.ts';

const client = new Bakbak();
const ws = client.tts.websocket({
  voice_id,
  language,
  model,
  output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
});

try {
  await ws.connect();
  const call = ws.context({ contextId: 'call-1234' });
  await call.send({ text: 'नमस्ते, मैं रया बोल रही हूँ।' });
  await call.send({ text: 'आपकी कॉल हमारे लिए महत्वपूर्ण है।' });
  call.endInput();

  const frames: Uint8Array[] = [];
  for await (const audio of call.audio()) {
    // e.g. Twilio: ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: base64(audio) } }))
    frames.push(audio);
  }
  const ulaw = Buffer.concat(frames);
  await writeFile(outPath('call.ulaw'), ulaw);
  await writeFile(outPath('call.wav'), toWav(ulaw, { encoding: 'pcm_mulaw', sampleRate: 8000 }));
  console.log(
    `${ulaw.length} bytes = ${(ulaw.length / 8000).toFixed(2)} s of 8 kHz μ-law → out/call.ulaw, out/call.wav`,
  );
} finally {
  await ws.close();
}
```
