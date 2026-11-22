---
id: troubleshooting
title: Troubleshooting Bakbak integrations
description: Symptoms, causes and fixes for errors (401, 402, 404, 413, 422, 429, 5xx), bad-sounding or unplayable audio, latency, WebSockets, browsers, packages and the LiveKit plugin.
---

# Troubleshooting Bakbak integrations

Every API error carries `error_code`, `message` (which names the bad field),
`retryable` and `request_id`. Read `message` first. The table of codes is in
`errors`.

## Errors

| Symptom | Cause | Fix |
|---|---|---|
| SDK error on construction naming `BAKBAK_API_KEY` | No key passed and the variable is unset in this process | Set `BAKBAK_API_KEY` where the code runs (container, worker, serverless env), or pass `api_key` / `apiKey`. |
| SDK refuses the key on construction (whitespace or control characters) | A copy-paste slip: a newline or space in the key | Trim the key where it is stored. |
| 401 `No API key found in request` | No `X-API-Key` header | Send the key in `X-API-Key` (not `Authorization`). |
| 401 `Unauthorized` | Wrong, deleted or other-environment key | Check the key in the dashboard. `BAKBAK_BASE_URL` pointing at the wrong deployment has the same effect. |
| 403 `invalid_account` | The key has no active billing account | A new account can take up to a minute; otherwise contact support. |
| 402 `insufficient_credits` | Balance below the request's cost (`required_inr`, `available_inr` in the body) | Top up in the dashboard. Not retryable. |
| 404 `voice_not_found` | The voice id does not exist **for the model sent**; usually an `m1` voice with `model` left at the default `standard`, or the reverse | Send the voice's own `model` (from `list_voices`). |
| 400 `model_not_found` | `model` is not `standard` or `m1` | Use a model the message lists. |
| 422 `invalid_request` | A field is missing or invalid, or an unknown field was sent | Read `message`: it names every field. Common slips: `voice` instead of `voice_id`; `format`, `encoding` or `sample_rate` at the top level instead of inside `output_format`; `encoding` missing for `raw`/`wav`; `encoding` sent with `mp3`; `wav` or `mp3` on a stream (streams are `raw` only); `speed` outside 0.5 to 1.5; empty `text`. |
| 413 `request_too_large` | Text over 5,000 characters, or body over 256 KiB | Split the text (`long-form`). |
| 429 `concurrency_limit_exceeded` | More requests generating at once than the plan allows (`concurrency_limit` in the body) | Let the SDK retry after `Retry-After`; bound your parallelism; ask support to raise the limit. A LiveKit agent on `transport="http"` can use two at once. |
| 503 `capacity_exhausted` / `model_unavailable`, 504 `model_timeout`, 502 `model_error`, 500 `internal_error` | Server-side, temporary | Retryable: the SDKs retry twice with backoff. If it persists, contact support with `request_id`. |
| `StreamInterruptedError` (`stream_interrupted`) | The stream broke after audio began | Not retried automatically (the audio was charged and would repeat). Re-request the sentence if your app needs it. |
| 3xx raised as an error | Something between you and the API redirects (proxy, wrong base URL) | Fix `BAKBAK_BASE_URL`; the SDKs never follow redirects, so the key is never sent elsewhere. |

## Audio problems

| Symptom | Cause | Fix |
|---|---|---|
| Loud static or noise | Decoding with the wrong encoding, usually a stream sent **without** `output_format` (it is 32-bit float) read as 16-bit | Always send `output_format` and decode what you asked for. |
| Chipmunk or slow, deep voice | Player sample rate differs from `sample_rate` requested | Use the same rate on both sides (24000 by default). |
| Clicks or crackle between chunks | A 2- or 4-byte sample split across network chunks, or each chunk played as a separate sound | Carry leftover bytes into the next chunk; schedule chunks back to back on one stream or player. |
| A `.wav` file that won't open | Raw PCM saved with a `.wav` name | Ask for `{"container":"wav",…}` on the whole-file endpoint, or wrap raw audio with `to_wav` / `toWav`. |
| An `mp3` request returns a file starting with `RIFF` (WAV) | Currently, `standard` voices answer `mp3` requests with WAV audio, labelled as MP3 | Use WAV (or raw) with `standard` voices, or an `m1` voice for MP3. Check the first bytes before joining MP3 pieces. |
| Hindi sounds wrong | Romanised Hindi (`namaste`) | Write Hindi in Devanagari (`नमस्ते`). |
| Indian names mispronounced in English text | Names in Latin script | Write Indian names in Devanagari inside the English sentence. |
| Markdown, emoji or URLs read aloud | LLM output passed straight to TTS | Prompt the LLM for plain spoken sentences. |
| `speed` has no effect | An `m1` voice | `speed` changes `standard` voices only. |
| English with an `m1` voice refused or wrong | `language: "en-in"`/`"en-us"` with an `m1` voice | `m1` English voices use `en`; `standard` ones use `en-in` or `en-us`. |
| Phone audio garbled | Wrong G.711 variant or rate | Twilio/Plivo: `pcm_mulaw` at 8000. PCMA trunks: `pcm_alaw`. Linear PCM platforms: `pcm_s16le` at their rate (`telephony`). |

## Latency

| Symptom | Fix |
|---|---|
| First audio slow on the first turn only | Open the WebSocket at session start (`connect()` / `prewarm()`); reuse one client. |
| Every request slow | Use the WebSocket instead of one HTTP request per sentence; deploy near the API; measure with the `bench_ttfa` examples. |
| Long wait before the first sentence of an LLM reply | Use `send_stream`/`sendStream` (sends each sentence as it completes); enable `eager_first_clause`; ask the LLM for a short first sentence. |
| Gaps between sentences | Sentences sent as separate sequential HTTP requests. Put them on one WebSocket context: the server queues them with no gap. |
| Agent keeps talking after the user interrupts | Call `ctx.cancel()` **and** clear the player or telephony buffer (Twilio `clear`, Plivo `clearAudio`). |

## WebSocket

| Symptom | Cause | Fix |
|---|---|---|
| Connection closes after about 5 minutes | Idle timeout (close 1000) with nothing in progress | Normal. The SDKs reconnect on the next send; raw clients should too. |
| Close 1001 | The server is restarting | The SDKs resend unfinished requests on a new connection. Raw clients: reconnect and resend those with no audio yet. |
| Close 1008 | Sent too much without reading | Always keep reading the socket. |
| Close 1009 / 413 `error` | A message over 512 KiB / 256 KiB | Send smaller text per request. |
| `send` waits | 64 unfinished requests or 16 busy contexts on this connection | Expected back-pressure; open more WebSockets for more parallelism. |
| Node.js: WebSocket fails to load | Node 20 without the `ws` package | `npm install ws` (Node 22+ also works without it). |
| Requests time out but the socket looks open | Nothing reading the socket, so pings go unanswered | Read continuously (the SDKs do). |

## Browsers and apps

| Symptom | Fix |
|---|---|
| JS SDK throws about `dangerouslyAllowBrowser` | Call Bakbak from your server and proxy audio to the page (`web`). The option exists only for prototypes: it exposes the key. |
| CORS error | Proxy through your server; browsers may send only `Content-Type`, `X-API-Key` and `Authorization`. |
| No sound until the user clicks | Browser autoplay rules: create or resume the `AudioContext` in a click handler. |

## Packages

| Symptom | Fix |
|---|---|
| `pip install bakbak` installs something else, or nothing | The PyPI package is **`bakbak-python`** (you `import bakbak`). |
| npm: which package? | `bakbak` (unscoped). The `@bakbak` scope is not Bakbak's. |
| Python SDK needs Python 3.10+; JS SDK Node 20+; MCP server Node 22+ | Upgrade the runtime. |

## LiveKit plugin

| Symptom | Fix |
|---|---|
| `ValueError` naming `api_key` / `BAKBAK_API_KEY` | Set `BAKBAK_API_KEY` in the agent worker's environment (`RAYA_API_KEY` still works, with a deprecation warning). |
| Import or interface errors with `livekit-agents` 2.0 betas | The plugin supports `livekit-agents` 1.8.7 and later 1.x. Pin `livekit-agents<2`. |
| Voice/model refused after switching language | `update_options` with a voice of the new language **and** its model: `tts.update_options(voice_id=…, language="mr", model="standard")`. |
| Errors in logs during interruptions | Expected cancels are not errors; check for `APIStatusError` with a `request_id` instead. |

Still stuck? Contact support with the `request_id` of the failing request.
