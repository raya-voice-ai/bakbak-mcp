---
id: best-practices
title: Best practices for production Bakbak integrations
description: Text, voices, transports, latency, formats, retries, concurrency, billing, security and observability, across the SDKs, the LiveKit plugin and the raw API.
---

# Best practices for production Bakbak integrations

These apply to every integration. The official SDKs and the LiveKit plugin
already do the starred (★) items for you; if you call the API directly, you must
do them yourself (`raw-api` and `client-behavior` say how).

## Text

- **Hindi in Devanagari, always.** `नमस्ते`, never `namaste`. Romanised Hindi is
  not supported and sounds wrong.
- **Indian names inside English text in Devanagari.** "Please welcome राहुल from
  मुंबई" is pronounced far better than "Rahul from Mumbai". When an LLM writes the
  text, tell it to do this in its system prompt.
- **Write for the ear.** Prompt LLMs to answer in plain sentences: no markdown,
  bullet lists, tables, emoji or URLs, which are read out literally or skipped.
- **At most 5,000 characters per request.** Split longer text at sentence
  boundaries with the SDK segmenter (`split_sentences` / `splitSentences`), never
  with `text.split('. ')`: the segmenter knows the danda (`।`), decimals, domains,
  initials and titles such as `Dr.` and `डॉ.`.
- **Code-mixed text is fine** (Hindi with English words), as people speak it.

## Voices and models

- **A voice belongs to one model.** Send the voice's own `model` with its
  `voice_id`; a mismatch is a 404 `voice_not_found`.
- **English codes differ by model:** `m1` voices use `en`; `standard` voices use
  `en-in` or `en-us`.
- **`speed` changes `standard` voices only.** `m1` voices accept it and keep
  their own pace, so don't build a speed control for `m1` voices.
- **Pick voices from the live catalog** (`GET /v1/voices`, `list_voices`).
  Store the chosen `voice_id` in configuration, not code, and cache the catalog
  (it changes rarely; refresh hourly or daily) instead of fetching it per request.
- **Let people listen before choosing.** Generate the same sentence with two or
  three candidate voices and compare.

## Transport and latency

- **WebSocket for anything conversational** (agents, telephony, LLM output).
  It pays the connection and gateway cost once; each request then starts faster
  than an HTTP request would.
- **Open it early.** `await ws.connect()` (JS), `async with client.tts.websocket(...)`
  or `await ws.connect()` (Python), `prewarm()` (LiveKit, done by `AgentSession`).
  The first reply then pays no handshake.
- **One WebSocket per process or per agent session, kept for its lifetime.** It
  survives idle closes and server restarts by reconnecting (★). Open more only
  when you need more than 16 contexts generating at once or 64 unfinished
  requests on one connection.
- **One context per turn or utterance** (or one per caller). Requests on a
  context play in order; separate contexts run in parallel.
- **Send sentence by sentence while the LLM is still writing**: `ctx.send_stream(tokens)`
  (Python) / `ctx.sendStream(tokens)` (JS) takes OpenAI, Anthropic, Gemini and
  Vercel AI SDK stream events or plain strings. For replies that open with a long
  sentence, enable `eager_first_clause` / `eagerFirstClause`.
- **Reuse one client.** It keeps HTTP connections alive. `client.prewarm()`
  (Python) or `await client.warmup()` (JS) opens one before the first request.
- **Measure time to first audio**, not total time. `examples/python/bench_ttfa.py`
  and `examples/javascript/bench-ttfa.ts` measure SSE against the WebSocket from
  your own servers.

## Audio formats

Ask for exactly the format you play or forward, so nothing converts or
resamples:

| Destination | `output_format` |
|---|---|
| Twilio and Plivo media streams; SIP trunks negotiating PCMU (North America, Japan) | `{"container":"raw","encoding":"pcm_mulaw","sample_rate":8000}` |
| SIP trunks negotiating PCMA (Europe, India and most other countries) | `{"container":"raw","encoding":"pcm_alaw","sample_rate":8000}` |
| Telephony that wants 16-bit linear PCM (Exotel, Vonage, Asterisk slin) | `{"container":"raw","encoding":"pcm_s16le","sample_rate":8000}` or `16000` |
| LiveKit, WebRTC, real-time pipelines | `{"container":"raw","encoding":"pcm_s16le","sample_rate":24000}` (or your pipeline's rate) |
| Browser `<audio>`, downloads, storage | `{"container":"mp3"}` on `POST /v1/text-to-speech` |
| Editing, archives, further processing | `{"container":"wav","encoding":"pcm_s16le","sample_rate":24000}` |

- **Always send `output_format`.** Without it a stream is 32-bit float PCM and the
  response does not say so in its headers; with it, `X-Audio-Format` and
  `X-Audio-Sample-Rate` describe the audio.
- `pcm_s16le` is half the size of the default `pcm_f32le`; G.711 is a quarter.
- Streams (SSE and WebSocket) carry only raw audio. Wrap it with `to_wav` / `toWav`
  when you need a file. MP3 cannot be wrapped in WAV.
- All audio is mono.

## Errors and retries

- **Never retry after audio has been delivered** (★). That audio was charged and a
  retry would play the start twice. The SDKs raise `StreamInterruptedError`
  instead; decide in your app whether to re-request the sentence.
- **Retry before audio only when `retryable` is true** (★): connection errors,
  timeouts, 408, 429, 500, 502, 503, 504. Honour `Retry-After` (capped at 60 s),
  otherwise back off exponentially from about 0.5 s. Two retries is the default.
- **Branch on `error_code`, not on message text.** Show `message` to people; it
  names the bad field. Codes only grow and never change meaning: treat an unknown
  code by its HTTP status. The full table is in `errors`.
- **Log `request_id`** with every failure (and ideally every request); support
  needs it.
- **Requests the API gateway refuses** (wrong key, unknown path, body over
  256 KB) have only `message` and `request_id`, no `error_code`; the SDK error
  class tells them apart (`AuthenticationError` for 401).
- **Set deadlines.** The SDK read timeout (60 s) is an inactivity timer between
  bytes. For a total deadline use `Timeout(total=...)` (Python) or
  `signal: AbortSignal.timeout(ms)` (JS).

## Concurrency and capacity

- Your account allows a number of requests generating at once (the 429 body's
  `concurrency_limit` says how many). Requests queued behind a WebSocket context
  hold no capacity and are not billed until they start.
- **Bound batch parallelism** to that limit with a semaphore or worker pool,
  rather than relying on 429 retries.
- A LiveKit agent on `transport="http"` can use two concurrent requests per
  utterance (look-ahead); the default WebSocket transport uses one.
- Size telephony and agent fleets by simultaneous *speaking* turns, not calls,
  and ask support to raise the limit before launch.

## Billing and cost

- Charged per character once audio leaves the service. A request that fails
  before audio is not charged; a cancel before audio is not charged; a cancel
  after the first audio is.
- **Cache audio for fixed phrases** (IVR menus, greetings, notifications) keyed by
  `text`, `voice_id`, `model`, `language`, `speed` and `output_format`, instead of
  synthesizing them on every call.
- On barge-in, **cancel the context** (`ctx.cancel()`), which stops the running
  request and drops the queued ones, so you don't pay for speech nobody hears.
- A 402 `insufficient_credits` body has `required_inr` and `available_inr`;
  alert on it, and top up in the dashboard.

## Security

- **Keep the API key on servers only.** Never ship it in a browser bundle, a
  mobile app or a public repository. Browsers and apps call your backend. The JS
  SDK refuses to run in a browser unless you pass `dangerouslyAllowBrowser: true`,
  for this reason.
- Read it from `BAKBAK_API_KEY` or a secret manager. Use separate keys per
  environment, and delete a leaked key in the dashboard at once.
- The SDKs never log the key or the text, never put the key in errors, and never
  follow redirects (★). If you write your own client, do the same: following a
  redirect would send `X-API-Key` to another host.
- Synthesized text may contain personal data; don't log it by default.

## Observability

- Record per request: `request_id`, `error_code`, time to first audio, audio
  duration, characters.
- SDK debug logs: Python `logging.getLogger("bakbak").setLevel(logging.DEBUG)`;
  JS `new Bakbak({ logger: console })`. LiveKit: the plugin labels LiveKit's TTS
  metrics with `provider="Bakbak"`.

## Testing

- Point `BAKBAK_BASE_URL` at a mock server in tests. The `conformance/` folder of
  every official repo has recorded HTTP and WebSocket scenarios to replay.
- Test the unhappy paths: 401, 402, 422 (bad `voice_id`/`output_format`), 429
  with `Retry-After`, a stream cut after audio, a WebSocket close 1001.
