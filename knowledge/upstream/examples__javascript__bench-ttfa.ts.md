---
id: examples/javascript/bench-ttfa.ts
title: JavaScript example: bench-ttfa.ts
description: Time to first audio, p50/p95, SSE against the WebSocket.
url: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/bench-ttfa.ts
---

# examples/javascript/bench-ttfa.ts

A runnable example from the bakbak npm package. Time to first audio, p50/p95, SSE against the WebSocket.

Source: https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/bench-ttfa.ts

```ts
// Time to first audio (TTFA): SSE vs WebSocket, one request at a time, alternating.
//
// SSE TTFA runs from tts.stream() to its first chunk, on a kept-alive HTTPS connection.
// WebSocket TTFA runs from ctx.send() to the context's first chunk, on an open socket.
// Both are warmed up first, so neither pays DNS, TCP, TLS or the WebSocket handshake.
//
//   BAKBAK_API_KEY=… BAKBAK_BASE_URL=… npx tsx examples/bench-ttfa.ts [N]
// N defaults to 20 per transport. BAKBAK_BENCH_TEXT overrides the sentence.
import { Bakbak, type OutputFormat, type TTSWebSocket } from 'bakbak';
import { language, model, voice_id } from './_env.ts';

const N = Number(process.argv[2] ?? process.env.BAKBAK_BENCH_N ?? 20);
const text = process.env.BAKBAK_BENCH_TEXT ?? 'नमस्ते, आप कैसे हैं?';
const output_format: OutputFormat = { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 };
const params = { text, voice_id, language, model, output_format };

const client = new Bakbak();

async function sseTTFA(): Promise<number> {
  const started = performance.now();
  let ttfa = Number.NaN;
  for await (const _ of client.tts.stream(params)) {
    if (Number.isNaN(ttfa)) ttfa = performance.now() - started;
  }
  return ttfa;
}

async function wsTTFA(ws: TTSWebSocket): Promise<number> {
  const ctx = ws.context();
  const started = performance.now();
  await ctx.send({ text });
  ctx.endInput();
  let ttfa = Number.NaN;
  for await (const _ of ctx.audio()) {
    if (Number.isNaN(ttfa)) ttfa = performance.now() - started;
  }
  return ttfa;
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), mean, min: sorted[0] as number, max: at(1) };
}

const ws = client.tts.websocket({ voice_id, language, model, output_format });
try {
  await client.warmup();
  await ws.connect();
  for (let i = 0; i < 2; i++) {
    await sseTTFA();
    await wsTTFA(ws);
  }
  const results: Record<'SSE' | 'WebSocket', number[]> = { SSE: [], WebSocket: [] };
  for (let i = 0; i < N; i++) {
    results.SSE.push(await sseTTFA());
    results.WebSocket.push(await wsTTFA(ws));
  }
  console.log(`TTFA, ${model}, "${text}", ${N} sequential requests per transport, alternating\n`);
  console.log('| transport | n | p50 ms | p95 ms | mean ms | min ms | max ms |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, samples] of Object.entries(results)) {
    const s = stats(samples);
    const f = (x: number) => x.toFixed(1);
    console.log(
      `| ${name} | ${s.n} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.mean)} | ${f(s.min)} | ${f(s.max)} |`,
    );
  }
} finally {
  await ws.close();
}
```
