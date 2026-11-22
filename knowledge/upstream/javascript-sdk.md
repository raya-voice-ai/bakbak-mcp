---
id: javascript-sdk
title: JavaScript SDK reference (bakbak on npm)
description: The JavaScript/TypeScript SDK README: install, whole files, SSE streaming, the WebSocket (contexts, sendStream, cancel, telephony), segmentation, formats, configuration, errors, retries, runtimes and browsers.
url: https://github.com/raya-voice-ai/bakbak-js#readme
---

# Bakbak JavaScript SDK

The official JavaScript and TypeScript client for the **Bakbak text-to-speech API** by Raya:
natural Hindi, Indic and Indian-English voices, streamed with low latency.

- One small package, **zero runtime dependencies**, typed end to end.
- Whole files, Server-Sent Events streaming, and a **WebSocket** that carries many requests
  in ordered contexts, made for voice agents and LLM output.
- Runs on **Node 20+**, **Bun**, **Deno**, **Cloudflare Workers** and browsers.
- Retries, timeouts and errors that behave the same in every official Bakbak client.

```sh
npm install bakbak
# On Node, also install ws for the WebSocket (optional; Node 22+ can do without it):
npm install ws
```

## Quickstart

```ts
import { Bakbak } from 'bakbak';

const client = new Bakbak(); // reads BAKBAK_API_KEY

const audio = await client.tts.generate({
  text: 'नमस्ते! बकबक में आपका स्वागत है।',
  voice_id: '009ae8b5-4a03-492d-af1c-3055989ac734', // "Anika M1"
  language: 'hi',
  model: 'm1',
});
await audio.save('hello.wav'); // Node, Bun and Deno
```

Request fields keep the API's own names (`voice_id`, `output_format`, `sample_rate`), so
code, curl commands and the [API reference](https://docs.bakbak.si/text-to-speech/websocket)
read the same. Full documentation: [the JavaScript SDK guide](https://docs.bakbak.si/sdks/javascript).

## Contents

- [Voices](#voices)
- [Languages and models](#languages-and-models)
- [Whole files](#whole-files)
- [Streaming over SSE](#streaming-over-sse)
- [WebSocket](#websocket): contexts, LLM token streams, cancel, telephony
- [Sentence splitting](#sentence-splitting)
- [Audio formats and WAV](#audio-formats-and-wav)
- [Configuration](#configuration)
- [Errors](#errors)
- [Retries and timeouts](#retries-and-timeouts)
- [Latency tips](#latency-tips)
- [Runtimes and browsers](#runtimes-and-browsers)
- [Examples](#examples)

## Voices

```ts
const { voices, count } = await client.voices.list({ model: 'm1', language: 'hi' });
for (const v of voices) console.log(v.id, v.name, v.language, v.model);
```

The API returns the whole catalog; the `model` and `language` filters are applied by the SDK.
A voice belongs to one model, and `model` in a request must match it. m1 English voices use
`language: 'en'`.

## Languages and models

| Model      | Languages                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `m1`       | Hindi `hi`, English `en`, Kannada `kn`                                                                                                                                               |
| `standard` | Hindi `hi`, Indian English `en-in`, US English `en-us`, Assamese `as`, Bengali `bn`, Gujarati `gu`, Kannada `kn`, Malayalam `ml`, Marathi `mr`, Nepali `ne`, Tamil `ta`, Telugu `te` |

That is the voice catalog of 22 November 2026; `client.voices.list()` is the source of truth.
Punjabi (`pa`) is accepted by the API and the `Language` type but has no voice yet.

`speed` (0.5 to 1.5, default 1.0) changes `standard` voices only. `m1` voices accept it and
speak at their own pace.

## Whole files

```ts
const audio = await client.tts.generate({ text, voice_id, language: 'hi', model: 'm1' });
audio.data; // Uint8Array, exactly the bytes received
audio.requestId; // quote it to support
audio.contentType; // 'audio/wav' by default
audio.encoding; // e.g. 'pcm_s16le', from the response headers or the WAV's own header
audio.sampleRate; // e.g. 24000
audio.toWav(); // the bytes as a WAV file (raw audio gets a header)
await audio.save('out.wav');
```

Without `output_format` the API returns 24 kHz WAV and no format headers; `encoding` and
`sampleRate` are then read from the WAV file itself. Choose another format with
[`output_format`](#audio-formats-and-wav).

## Streaming over SSE

`tts.stream()` starts the request at once and yields audio as the model produces it:

```ts
const stream = client.tts.stream({
  text,
  voice_id,
  language: 'hi',
  model: 'm1',
  output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
});

for await (const chunk of stream) {
  play(chunk.audio); // Uint8Array; chunks always hold whole samples
}
console.log(await stream.requestId, stream.encoding, stream.sampleRate);
```

`encoding` and `sampleRate` come from the response headers, which the API sends when the
request has an `output_format`; without one they are `undefined` (the default stream is
32-bit float PCM at 24 kHz).

An `AudioStream` can be read once, in whichever way suits you:

```ts
const bytes = await stream.bytes(); // Uint8Array
const buffer = await stream.arrayBuffer(); // ArrayBuffer
const audio = await stream.toAudio(); // Audio, with toWav() and save()
const web = stream.toReadableStream(); // ReadableStream<Uint8Array>, e.g. for a Response
```

Breaking out of the loop, or cancelling the `ReadableStream`, aborts the request. Streaming
accepts only the `raw` container.

## WebSocket

The WebSocket carries many streaming requests on one connection. It pays the TCP, TLS and
gateway cost once instead of per request, which makes it the fastest transport for voice
agents. Requests are grouped in **contexts**: requests on one context run one after another,
in order; different contexts run at the same time.

```ts
const ws = client.tts.websocket({ voice_id, language: 'hi', model: 'm1' }); // defaults for every request
await ws.connect(); // optional: open now so the first request pays no handshake

const ctx = ws.context(); // or ws.context({ contextId: 'turn-7', ...overrides })
await ctx.send({ text: 'नमस्ते!' });
await ctx.send({ text: 'मैं आपकी कैसे मदद कर सकती हूँ?' });
ctx.endInput(); // no more requests on this context

for await (const audio of ctx.audio()) play(audio);

await ws.close();
```

`ctx.send()` resolves once the request is on the wire; its outcome arrives through the
context. Read a context in one of these ways:

- `ctx.audio()` yields only the bytes, in order, and throws the first failure.
- `ctx.events()` yields every event: `chunk` (with `audio`, `stepTime` and `request`), then
  `done`, `failed` (with `error`) or `cancelled` for each request. An error ends its own
  request only; later requests on the context still run.
- The request returned by `send()` has `result()` (a promise of
  `{ requestId, audioBytes, cancelled }`, rejected if it failed) and its own `audio()`.

Each event is delivered once, to whichever reader takes it first, and its audio is released
as soon as it is taken, so pick one way per context. Iteration ends after `endInput()`, once
every request has finished. A context with nothing unfinished holds no resources in the
handle, so a long-lived context (one per caller) and a context per utterance both work for
as long as the connection lives.

### Speaking an LLM's reply as it is written

`ctx.sendStream()` takes tokens as they arrive, splits them into sentences, sends each
sentence as soon as it is complete, and calls `endInput()` at the end. It accepts strings,
stream events from the OpenAI (Chat Completions and Responses), Anthropic, Google Gemini and
Vercel AI SDKs, and Gemini's raw REST/SSE JSON (`candidates`, with thought parts skipped),
found by duck typing, without importing any of them:

```ts
const llm = await openai.chat.completions.create({ model, messages, stream: true });

const ctx = ws.context();
const sending = ctx.sendStream(llm); // or any (async) iterable of strings
for await (const audio of ctx.audio()) play(audio);
await sending;
```

Options: `sendStream(tokens, { params, segmenter: { minChars: 30 }, endInput: false })`, where
`params` holds request fields for every sentence, over the context's defaults.

Items without text, such as tool calls, are skipped. If the tokens end without any text and
some item had none of the shapes above, `sendStream()` ends input as usual and then rejects
with a `BakbakError` that names the shapes it reads, rather than return having sent nothing.
Map other events to strings first; `null` or `undefined` for an event without text is fine.

### Cancel (barge-in)

```ts
await ctx.cancel();
```

`cancel()` stops the running request and drops the queued ones; each ends as `cancelled`.
All of the context's audio that arrived but was not read yet is discarded too, including that
of requests that had already finished, so the context goes silent at once. A `sendStream()`
feeding the context stops: it sends nothing more, lets go of its token source and returns
(calling `endInput()`, as when its tokens end, unless you passed `endInput: false`).
`cancel()` resolves when the API acknowledges; the context then stays usable for `send()`.

### Telephony

Ask for the format your telephony stack uses and forward the chunks as they are:

```ts
const ws = client.tts.websocket({
  voice_id,
  language: 'hi',
  model: 'm1',
  output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
});
```

### Connection behaviour

The WebSocket opens on `connect()` or the first `send()`. It answers the server's pings,
waits instead of exceeding the server's per-connection limits (64 unfinished requests, 16
contexts generating at once), reconnects and resends when the server restarts or drains,
and fails a request with `StreamInterruptedError` if the connection breaks after its audio
began. When a server drains, the SDK moves to a new connection at once and resends what was
refused, without counting it as a retry; a request refused again backs off and counts. A
chunk with invalid audio data fails its own request only. Messages about no request at all
go to `ws.onNotice`:

```ts
ws.onNotice = (error) => console.warn('websocket notice:', error.message);
```

## Sentence splitting

The segmenter behind `sendStream()` is exported. It never splits where a sentence does not
end (decimals, domains, `Dr.`, `e.g.`, list markers), handles the danda `।`, and gives the
same result however the text is cut into pieces. Lengths are counted in Unicode code points.

```ts
import { Segmenter, splitSentences } from 'bakbak';

splitSentences('डॉ. शर्मा आज क्लिनिक में हैं। प्रो. वर्मा कल आएँगे।');
// ['डॉ. शर्मा आज क्लिनिक में हैं।', 'प्रो. वर्मा कल आएँगे।']

splitSentences('हाँ। ठीक है। मैं आपकी कैसे मदद कर सकती हूँ?');
// ['हाँ।', 'ठीक है। मैं आपकी कैसे मदद कर सकती हूँ?']

const segmenter = new Segmenter({ minChars: 20, maxChars: 400 });
for await (const token of tokens) for (const sentence of segmenter.push(token)) speak(sentence);
for (const sentence of segmenter.flush()) speak(sentence);
```

| Option                | Default |                                                                                    |
| --------------------- | ------- | ---------------------------------------------------------------------------------- |
| `minChars`            | 20      | Shorter sentences (after the first) merge with the next.                           |
| `firstMinChars`       | 1       | The minimum for the first sentence; 1 sends it as soon as it ends.                 |
| `maxChars`            | 400     | Longer text is wrapped at a clause, a space, or a cluster boundary. At most 5,000. |
| `eagerFirstClause`    | false   | Until the first sentence is sent, also split after a clause (`,` `;` `:` `—`).     |
| `firstClauseMinChars` | 24      | The shortest first clause `eagerFirstClause` sends alone.                          |

Not every `।`, `॥` or `.` starts a new request: after the first sentence, a sentence shorter
than `minChars` (default 20) is joined with the next, as `ठीक है।` is above.

## Audio formats and WAV

```ts
output_format: { container: 'raw' | 'wav' | 'mp3', encoding: 'pcm_s16le', sample_rate: 16000 }
```

| Field         | Values                                            |                                                        |
| ------------- | ------------------------------------------------- | ------------------------------------------------------ |
| `container`   | `raw`, `wav`, `mp3`                               | Streaming (SSE and WebSocket) accepts only `raw`.      |
| `encoding`    | `pcm_f32le`, `pcm_s16le`, `pcm_mulaw`, `pcm_alaw` | Required for `raw` and `wav`; omit it for `mp3`. Mono. |
| `sample_rate` | 8000, 16000, 22050, 24000                         | Default 24000.                                         |

Without `output_format`, streams send 24 kHz 32-bit float PCM. Language, model, encoding
and similar types list the known values but accept any string, so a new value needs no SDK
release.

Wrap raw audio in a WAV header with `toWav`:

```ts
import { toWav } from 'bakbak';
const wav = toWav(pcmBytes, { encoding: 'pcm_s16le', sampleRate: 24000 });
```

`toWav` refuses bytes that are not a whole number of samples (an odd length for
`pcm_s16le`, a length that is not a multiple of 4 for `pcm_f32le`) rather than write a header
that disagrees with them. An odd length of 8-bit audio gets the pad byte WAV requires.

`audio.toWav()` returns WAV unchanged and wraps raw audio using its `encoding` and
`sampleRate`. It refuses mp3, which has to be decoded with an audio library instead. For mp3,
`audio.encoding` is `'mp3'` and `audio.sampleRate` is `undefined`: the rate is in the MP3
frames. A stream sent without `output_format` does not state its encoding and rate, so its
`toAudio().toWav()` throws; send `output_format`, or call
`toWav(audio.data, { encoding, sampleRate })` if you know them.

Decoded chunks start at offset 0 of their own `ArrayBuffer`, so you can view them directly:
`new Int16Array(chunk.audio.buffer, 0, chunk.audio.length / 2)`.

## Configuration

```ts
const client = new Bakbak({
  apiKey: 'sk_…', // default: BAKBAK_API_KEY
  baseURL: 'https://…', // default: BAKBAK_BASE_URL, then https://hub.getraya.app
  timeout: 60_000, // read timeout, ms
  maxRetries: 2,
});
```

| Option                    | Default                                           | Meaning                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                  | `BAKBAK_API_KEY`                                  | Your API key. Without one the constructor throws.                                                                                                                                                   |
| `baseURL`                 | `BAKBAK_BASE_URL`, then `https://hub.getraya.app` | The API's base URL. The WebSocket URL is derived from it.                                                                                                                                           |
| `timeout`                 | 60 000 ms                                         | Read timeout: the longest wait for the next bytes of a response, or the next message of a WebSocket context with unfinished requests. It includes the time to first audio. `Infinity` turns it off. |
| `connectTimeout`          | 5 000 ms                                          | WebSocket connect timeout (TCP, TLS and upgrade).                                                                                                                                                   |
| `maxRetries`              | 2                                                 | Retries of a failure before any audio.                                                                                                                                                              |
| `defaultHeaders`          | none                                              | Headers sent with every request.                                                                                                                                                                    |
| `fetch`                   | global `fetch`                                    | A `fetch` implementation (proxies, tests).                                                                                                                                                          |
| `webSocket`               | `'auto'`                                          | `'auto'`, `'ws'` or `'global'`; see [Runtimes](#runtimes-and-browsers).                                                                                                                             |
| `logger`                  | none                                              | `{ debug?, info?, warn?, error? }`. The SDK logs nothing by default, and never logs the API key or synthesis text.                                                                                  |
| `sleep`                   | `setTimeout`                                      | The wait between retries; replace it in tests.                                                                                                                                                      |
| `dangerouslyAllowBrowser` | false                                             | See [browsers](#runtimes-and-browsers).                                                                                                                                                             |

Every method takes per-call options as its last argument:

```ts
await client.tts.generate(params, {
  signal: AbortSignal.timeout(10_000), // a total deadline, or a user's cancel
  timeout: 20_000, // read timeout for this call
  maxRetries: 0,
  headers: { 'X-Trace-Id': traceId },
  extraBody: { new_field: true }, // API fields the SDK does not model yet
});
```

The API refuses fields it does not know with a 422, so `extraBody` is for fields the API
supports before the SDK models them, not for experiments.

An aborted call rejects with the signal's reason (an `AbortError`, or a `TimeoutError` for
`AbortSignal.timeout`).

## Errors

Everything the SDK throws is a `BakbakError`:

```
BakbakError
├── APIError                        the API answered with an error, or a stream broke
│   ├── APIStatusError              an HTTP error status, or an error before any audio
│   │   ├── BadRequestError             400
│   │   ├── AuthenticationError         401
│   │   ├── InsufficientCreditsError    402
│   │   ├── PermissionDeniedError       403
│   │   ├── NotFoundError               404
│   │   ├── RequestTooLargeError        413
│   │   ├── UnprocessableEntityError    422
│   │   ├── RateLimitError              429
│   │   └── InternalServerError         5xx
│   └── StreamInterruptedError      failed after audio was delivered
└── APIConnectionError              no usable answer: network, TLS, DNS
    ├── APITimeoutError
    └── WebSocketClosedError        the WebSocket closed and a request could not continue
```

Each error has `status`, `errorCode` (the API's `error_code`), `message` (a sentence to show
a person), `retryable`, `requestId` and `body` (the parsed response, so fields such as
`required_inr` stay readable). `StreamInterruptedError` also has `audioBytes`.

```ts
import { InsufficientCreditsError, RateLimitError, StreamInterruptedError } from 'bakbak';

try {
  await client.tts.generate(params);
} catch (err) {
  if (err instanceof InsufficientCreditsError) console.log('top up:', err.body);
  else if (err instanceof RateLimitError) console.log('concurrency limit reached; retry later');
  else if (err instanceof StreamInterruptedError) console.log(`cut off after ${err.audioBytes} bytes`);
  else throw err;
}
```

`instanceof` works even if your application loads both the ESM and the CommonJS build.
Every error code and what to do about it: [TTS errors](https://docs.bakbak.si/text-to-speech/errors).

The API key never appears in an error, its causes, or a log line. A key that is empty or
contains whitespace or control characters is refused when the client is created. The SDK
never follows a redirect, on HTTP or the WebSocket handshake, because that would send the
key to another address: a 3xx surfaces as an `APIStatusError` with its status.

## Retries and timeouts

- The SDK retries failures **before any audio**: connection errors, timeouts, and errors whose
  `retryable` is true (408, 429, 500, 502, 503 and 504 unless the API says otherwise), up to
  `maxRetries` times.
- It **never retries once audio has been delivered**: the request is billed, and a retry
  would play the start twice. It raises `StreamInterruptedError` instead.
- Waits follow `Retry-After` (capped at 60 s), else exponential backoff with jitter: about
  0.5 s, 1 s, then 2 s.
- A stream that ends without its final event is never returned as a short success.
- The read timeout is an inactivity timer, measured between chunks rather than over the
  whole response, so long audio streams never time out while data flows. For a deadline on
  the whole call, pass `signal: AbortSignal.timeout(ms)`.

## Latency tips

- **Use the WebSocket** for conversational audio, and **call `connect()`** ahead of the first
  turn. A request then pays neither the handshake nor the per-request gateway work.
- **Use `sendStream()`** for LLM output. The first sentence goes out the moment it ends,
  without waiting for the reply. For long first sentences, try
  `segmenter: { eagerFirstClause: true }`.
- **Reuse one client** (and one WebSocket); both keep their connections. For HTTP,
  `await client.warmup()` opens the connection before the first synthesis.
- **Ask for the format you play**, such as `pcm_s16le` at your output rate or `pcm_mulaw` at
  8 kHz for telephony, so nothing needs converting.
- Measure with
  [`examples/bench-ttfa.ts`](https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/bench-ttfa.ts),
  which reports time to first audio for SSE and the WebSocket.

## Runtimes and browsers

| Runtime                       | HTTP           | WebSocket                                                                                     |
| ----------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Node 20+                      | global `fetch` | the [`ws`](https://www.npmjs.com/package/ws) package when installed, with the key in a header |
| Node 22+ without `ws`         | global `fetch` | Node's global WebSocket, with the key in a header                                             |
| Bun, Deno, Cloudflare Workers | global `fetch` | global `WebSocket`, with the key in the URL                                                   |
| Browsers                      | global `fetch` | global `WebSocket`, with the key in the URL                                                   |

`ws` is an optional peer dependency, loaded only on Node and only when you open a WebSocket.
Browser bundles never include it.

Where the key goes in the URL, the SDK redacts it from anything it logs. The global WebSocket
does not say why a handshake was refused, so when one fails the SDK asks with one plain `GET`
to the same URL, the key placed the same way, and raises the error the answer stands for: a
wrong key is an `AuthenticationError` and is not retried, as with `ws`. If the API accepts the
key and URL over HTTP, or the `GET` gets no answer either, the failure stays an
`APIConnectionError` and is retried.

**Browsers.** In a browser, the SDK refuses to start unless you pass
`dangerouslyAllowBrowser: true`, because the API key would be visible to anyone using the
page. Prefer calling the API from your server. In browsers the SDK sends no `User-Agent` or
SDK headers, which the API's CORS policy would refuse.

## Examples

Run them with `npx tsx`, or with plain `node` on Node 22.18 or newer, which strips TypeScript
types itself. Set `BAKBAK_API_KEY`; `BAKBAK_BASE_URL` is optional.

| Example                                                                                                        |                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`quickstart.ts`](https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/quickstart.ts)                 | List voices, synthesize, save a WAV.                                                  |
| [`stream-to-file.ts`](https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/stream-to-file.ts)         | SSE streaming to a file, with time to first audio.                                    |
| [`websocket-contexts.ts`](https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/websocket-contexts.ts) | Two contexts on one WebSocket.                                                        |
| [`llm-tokens.ts`](https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/llm-tokens.ts)                 | Speak an LLM's reply as it is written (fake tokens, or any OpenAI-compatible stream). |
| [`telephony-mulaw.ts`](https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/telephony-mulaw.ts)       | 8 kHz μ-law for telephony.                                                            |
| [`bench-ttfa.ts`](https://github.com/raya-voice-ai/bakbak-js/blob/main/examples/bench-ttfa.ts)                 | Time to first audio, p50/p95, SSE vs WebSocket.                                       |

## Learn more

- [JavaScript SDK guide](https://docs.bakbak.si/sdks/javascript).
- [WebSocket API reference](https://docs.bakbak.si/text-to-speech/websocket).
- [TTS errors](https://docs.bakbak.si/text-to-speech/errors).
- [`conformance/BEHAVIOR.md`](https://github.com/raya-voice-ai/bakbak-js/blob/main/conformance/BEHAVIOR.md):
  the behaviour every official Bakbak client follows (Python, JavaScript, the MCP server and
  the LiveKit plugin).
- [Python SDK](https://github.com/raya-voice-ai/bakbak-python).
- [CHANGELOG](https://github.com/raya-voice-ai/bakbak-js/blob/main/CHANGELOG.md),
  [CONTRIBUTING](https://github.com/raya-voice-ai/bakbak-js/blob/main/CONTRIBUTING.md),
  [SECURITY](https://github.com/raya-voice-ai/bakbak-js/blob/main/SECURITY.md).

## License

[Apache-2.0](https://github.com/raya-voice-ai/bakbak-js/blob/main/LICENSE). Copyright 2026 Raya Voice AI.
