---
id: examples/javascript/llm-tokens.ts
title: JavaScript example: llm-tokens.ts
description: Speak an LLM's reply as it is written (sendStream).
url: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/llm-tokens.ts
---

# examples/javascript/llm-tokens.ts

A runnable example from the bakbak npm package. Speak an LLM's reply as it is written (sendStream).

Source: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/llm-tokens.ts

```ts
// Speak an LLM's reply while it is still being written: sendStream() splits the tokens into
// sentences and sends each one as soon as it is complete.
//
// Without OPENAI_API_KEY it uses a fake token stream. With it, it streams from any
// OpenAI-compatible Chat Completions endpoint (OPENAI_BASE_URL, default api.openai.com)
// using fetch only; sendStream reads `choices[0].delta.content` from each chunk.
//   BAKBAK_API_KEY=… BAKBAK_BASE_URL=… [OPENAI_API_KEY=…] npx tsx examples/llm-tokens.ts
import { writeFile } from 'node:fs/promises';
import { Bakbak, toWav } from 'bakbak';
import { language, model, outPath, voice_id } from './_env.ts';

async function* fakeTokens(): AsyncGenerator<string> {
  const reply = 'जी हाँ, आपका रिचार्ज सफल रहा। आपका नया बैलेंस पाँच सौ रुपये है। क्या मैं और कुछ मदद करूँ?';
  for (const token of reply.match(/\S+\s*/g) ?? []) {
    await new Promise((r) => setTimeout(r, 30)); // an LLM's pace
    yield token;
  }
}

/** Chat Completions chunks from an OpenAI-compatible endpoint, as parsed JSON objects. */
async function* openAIChunks(prompt: string): AsyncGenerator<unknown> {
  const base = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`LLM request failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data: ') && line !== 'data: [DONE]') yield JSON.parse(line.slice(6));
      nl = buffer.indexOf('\n');
    }
  }
}

const tokens = process.env.OPENAI_API_KEY
  ? openAIChunks('Reply in two short Hindi sentences, in Devanagari: what is the weather like in monsoon?')
  : fakeTokens();

const client = new Bakbak();
const ws = client.tts.websocket({
  voice_id,
  language,
  model,
  output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
});
try {
  const ctx = ws.context();
  const started = performance.now();
  const sending = ctx.sendStream(tokens); // ends input when the tokens end
  const parts: Uint8Array[] = [];
  for await (const event of ctx.events()) {
    if (event.type === 'chunk') {
      if (parts.length === 0) console.log(`first audio after ${(performance.now() - started).toFixed(0)} ms`);
      parts.push(event.audio);
    } else if (event.type === 'failed') {
      console.error(`a sentence failed: ${event.error.message}`);
    }
  }
  await sending;
  await writeFile(
    outPath('llm.wav'),
    toWav(Buffer.concat(parts), { encoding: 'pcm_s16le', sampleRate: 24000 }),
  );
  console.log('wrote out/llm.wav');
} finally {
  await ws.close();
}
```
