---
id: web
title: Web apps, browsers, serverless and mobile apps
description: Keep the key on your server and proxy speech to the browser or app: MP3 for <audio>, streamed PCM with the Web Audio API for low latency, Next.js, Express, FastAPI, Cloudflare Workers, iOS/Android/Flutter/React Native.
---

# Web apps, browsers, serverless and mobile apps

## The rule: the API key stays on your server

Anything shipped to a browser or a mobile app can be read by its users. Your
frontend asks **your** backend for speech; your backend authenticates the user,
limits what they may synthesize, and calls Bakbak with the key. Bakbak has no
short-lived browser tokens.

The JavaScript SDK refuses to start in a browser unless you pass
`dangerouslyAllowBrowser: true`. Use that only for local prototypes with a
throwaway key.

Pick a pattern:

| Need | Pattern | Format |
|---|---|---|
| Play a sentence or a paragraph, latency of a second is fine | Server returns a whole MP3; the page plays it with `<audio>` | `{"container":"mp3"}` |
| Speech starts as soon as possible (assistants, read-aloud of long text) | Server streams raw PCM over HTTP; the page plays it with the Web Audio API | `{"container":"raw","encoding":"pcm_s16le","sample_rate":24000}` |
| A conversational web agent | Browser ↔ your server over WebRTC or a WebSocket; your server ↔ Bakbak WebSocket (see `voice-agents`, or LiveKit: `livekit`) | `pcm_s16le` at the track rate |

## Pattern 1: whole MP3 for `<audio>`

### Next.js (App Router) route handler

```ts
// app/api/tts/route.ts
import { Bakbak, APIError } from 'bakbak';

const bakbak = new Bakbak(); // BAKBAK_API_KEY from the server environment
const VOICE_ID = process.env.BAKBAK_VOICE_ID!; // chosen with list_voices

export async function POST(req: Request) {
  const { text } = (await req.json()) as { text: string };
  // Authenticate the user and cap the text length here: synthesis costs credits.
  if (!text || text.length > 2000) return Response.json({ error: 'bad text' }, { status: 400 });
  try {
    const audio = await bakbak.tts.generate({
      text,
      voice_id: VOICE_ID,
      language: 'hi',
      model: 'm1',
      output_format: { container: 'mp3' },
    });
    return new Response(Buffer.from(audio.data), {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof APIError) {
      console.error('bakbak', err.status, err.errorCode, err.requestId);
      return Response.json({ error: 'speech failed' }, { status: err.retryable ? 503 : 502 });
    }
    throw err;
  }
}
```

```ts
// in the page
async function say(text: string) {
  const res = await fetch('/api/tts', { method: 'POST', body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`speech failed: ${res.status}`);
  await new Audio(URL.createObjectURL(await res.blob())).play();
}
```

### Python (FastAPI)

```python
import bakbak
from bakbak import AsyncBakbak
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI()
client = AsyncBakbak()  # one per process; reads BAKBAK_API_KEY
VOICE_ID = "009ae8b5-4a03-492d-af1c-3055989ac734"  # from list_voices


class SpeakIn(BaseModel):
    text: str


@app.post("/api/tts")
async def tts(body: SpeakIn) -> Response:
    try:
        audio = await client.tts.generate(
            text=body.text, voice_id=VOICE_ID, language="hi", model="m1",
            output_format={"container": "mp3"},
        )
    except bakbak.APIError as e:
        raise HTTPException(503 if e.retryable else 502, "speech failed") from None
    return Response(audio.data, media_type="audio/mpeg")
```

Cache MP3s of fixed texts (keyed by text, voice, model, language, speed and
format) in object storage or a CDN instead of synthesizing them again.

## Pattern 2: streamed PCM, played as it arrives

The server proxies the SSE stream as a plain chunked HTTP body of 16-bit PCM.
Waiting for the stream's first audio before answering turns errors into normal
HTTP errors.

### Next.js route handler

```ts
// app/api/tts-stream/route.ts
import { Bakbak, APIError } from 'bakbak';

const bakbak = new Bakbak();
const VOICE_ID = process.env.BAKBAK_VOICE_ID!;

export async function POST(req: Request) {
  const { text } = (await req.json()) as { text: string };
  const stream = bakbak.tts.stream({
    text,
    voice_id: VOICE_ID,
    language: 'hi',
    model: 'm1',
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
  });
  try {
    await stream.requestId; // resolves when audio starts, rejects on any error before it
  } catch (err) {
    if (err instanceof APIError) return Response.json({ error: 'speech failed' }, { status: 502 });
    throw err;
  }
  return new Response(stream.toReadableStream(), {
    headers: { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000', 'Cache-Control': 'no-store' },
  });
}
```

Cancelling the browser request cancels the readable stream, which aborts the
Bakbak request. With Express, pipe it:
`Readable.fromWeb(stream.toReadableStream()).pipe(res)` (from `node:stream`).

### FastAPI

```python
from fastapi.responses import StreamingResponse


@app.post("/api/tts-stream")
async def tts_stream(body: SpeakIn) -> StreamingResponse:
    try:
        # Sends the request now and returns once the first audio has arrived,
        # so errors before audio are raised here, not mid-response.
        raw = await client.tts.with_raw_response.stream(
            text=body.text, voice_id=VOICE_ID, language="hi", model="m1",
            output_format={"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000},
        )
    except bakbak.APIError:
        raise HTTPException(502, "speech failed") from None
    return StreamingResponse(raw.parse().iter_audio(), media_type="audio/pcm")
```

### Browser player for streamed 16-bit PCM

```js
// Call start() from a click handler: browsers only allow audio after a user gesture.
export async function speak(text) {
  const rate = 24000;
  const ctx = new AudioContext({ sampleRate: rate });
  await ctx.resume();
  const res = await fetch('/api/tts-stream', { method: 'POST', body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`speech failed: ${res.status}`);

  const reader = res.body.getReader();
  let carry = new Uint8Array(0); // network chunks can split a 2-byte sample
  let playhead = ctx.currentTime + 0.05;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const bytes = new Uint8Array(carry.length + value.length);
    bytes.set(carry);
    bytes.set(value, carry.length);
    const usable = bytes.length - (bytes.length % 2);
    carry = bytes.slice(usable);
    if (usable === 0) continue;

    const view = new DataView(bytes.buffer, 0, usable);
    const samples = new Float32Array(usable / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    playhead = Math.max(playhead, ctx.currentTime);
    source.start(playhead);
    playhead += buffer.duration;
  }
}
```

To stop playback (the user pressed stop or started speaking), abort the `fetch`
with an `AbortController` and `ctx.close()`.

## Serverless and edge runtimes

- The JavaScript SDK runs on Node 20+, Bun, Deno, Cloudflare Workers and Vercel's
  runtimes with the platform's `fetch` and `WebSocket`. On Node, install `ws` for
  the WebSocket (Node 22+ can use its global WebSocket).
- Short-lived functions suit whole files and SSE streams. A WebSocket only pays
  off when it lives for many requests; don't open one per function invocation.
- Mind the platform's response time limit for long texts; split them (`long-form`).

## Mobile apps (iOS, Android, Flutter, React Native)

Same rule: the app calls your backend, never Bakbak with a key.

- Simple playback: your backend returns MP3 (pattern 1); play it with `AVPlayer`,
  ExoPlayer/Media3, `just_audio` (Flutter) or `expo-av`/`react-native-track-player`.
- Low latency: your backend streams 16-bit PCM (pattern 2); play it with
  `AVAudioEngine` + `AVAudioPlayerNode` (iOS) or `AudioTrack` in streaming mode
  (Android), carrying odd bytes over between network chunks.
- Conversational apps: use WebRTC (for example LiveKit's client SDKs with a
  LiveKit agent using the Bakbak plugin) rather than streaming TTS yourself.

## CORS

The API allows only the `Content-Type`, `X-API-Key` and `Authorization` request
headers from browsers. The SDK sends no other headers when it detects a browser.
Proxying through your server avoids CORS entirely.

See also: `javascript-sdk`, `python-sdk`, `output-formats`, `best-practices`.
