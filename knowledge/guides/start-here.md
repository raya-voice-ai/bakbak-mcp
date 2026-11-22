---
id: start-here
title: Start here: choose how to integrate Bakbak
description: What Bakbak is, the facts every integration needs, and which SDK, plugin or API to use for each platform.
---

# Start here: choose how to integrate Bakbak

Bakbak is Raya's text-to-speech API: natural speech in Hindi, nine other Indian
languages, and Indian and US English, as whole files, as a stream, or over a
WebSocket built for voice agents.

This page is the map. Pick your row in [Which integration fits your platform](#which-integration-fits-your-platform),
then read the page it names with `read_docs`.

## Facts every integration needs

| | |
|---|---|
| API base URL | `https://hub.getraya.app` (WebSocket: `wss://hub.getraya.app`) |
| Authentication | Header `X-API-Key: <key>`. Keys come from the dashboard at https://bakbak.getraya.app. |
| Environment variables | `BAKBAK_API_KEY` (the key) and `BAKBAK_BASE_URL` (optional override). Every official client reads them. |
| Whole file | `POST /v1/text-to-speech` → the audio bytes (WAV, MP3 or raw) |
| One stream | `POST /v1/text-to-speech/stream` → Server-Sent Events with base64 raw audio |
| Many streams on one connection | `GET /v1/text-to-speech/ws` (WebSocket) → JSON messages; lowest latency |
| Voices | `GET /v1/voices` → `{"voices":[{id,name,language,model}],"count":N}`; free |
| Text per request | 1 to 5,000 characters. Longer text: split it (see `long-form`). |
| Billing | Per character, charged once audio leaves the service. A request that fails before any audio is not charged. |
| Concurrency | Each account has a plan limit on requests generating at once; over it, a request gets 429 `concurrency_limit_exceeded`. |

Request body (the same for all three synthesis operations):

| Field | Required | Notes |
|---|---|---|
| `text` | yes | Hindi must be in Devanagari script, never romanised. |
| `voice_id` | yes | From `GET /v1/voices` (the `list_voices` tool). |
| `language` | yes | `hi mr te kn bn as gu ne ml ta pa en en-in en-us` |
| `model` | no | `standard` (server default) or `m1`. Must be the voice's own model. |
| `speed` | no | 0.5 to 1.5. Changes `standard` voices only; `m1` voices accept it and keep their own pace. |
| `output_format` | no | `{"container", "encoding", "sample_rate"}`; see `output-formats`. Streams accept only `container: "raw"`. |

Languages with voices today (`GET /v1/voices` is the source of truth):

| Model | Languages |
|---|---|
| `m1` | Hindi `hi`, English `en`, Kannada `kn` |
| `standard` | Hindi `hi`, Indian English `en-in`, US English `en-us`, Assamese `as`, Bengali `bn`, Gujarati `gu`, Kannada `kn`, Malayalam `ml`, Marathi `mr`, Nepali `ne`, Tamil `ta`, Telugu `te` |

`m1` English voices use `en`; `standard` English voices use `en-in` or `en-us`.
Punjabi (`pa`) is accepted but has no voice yet.

## Official clients

| Package | Install | Use it for | Docs page |
|---|---|---|---|
| Python SDK | `pip install --pre bakbak-python` (import `bakbak`) | Python 3.10+ apps, sync or asyncio | `python-sdk` |
| JavaScript SDK | `npm install bakbak` (plus `ws` on Node for the WebSocket) | Node 20+, Bun, Deno, Cloudflare Workers, browsers | `javascript-sdk` |
| LiveKit plugin | `pip install livekit-plugins-bakbak` | LiveKit Agents 1.x voice agents (Python) | `livekit`, `livekit-plugin` |
| MCP server | `npx -y bakbak-mcp`, or `https://mcp.bakbak.si/mcp` | Claude, Cursor, VS Code and other MCP clients | `mcp-server` |

All four follow one behaviour contract (`client-behavior`): the same retries,
error classes and sentence segmentation. Request fields keep the API's
snake_case names in every language (`voice_id`, `output_format`), so SDK code,
`curl` and this server's tool arguments read the same.

## Which integration fits your platform

| You are building | Use | Read |
|---|---|---|
| A LiveKit Agents voice agent (Python) | `livekit-plugins-bakbak`: `tts=bakbak.TTS(...)` | `livekit` |
| A Pipecat bot | The Python SDK's WebSocket inside a small custom `TTSService` | `pipecat` |
| Phone calls: Twilio, Plivo, Exotel, Vonage, SIP/Asterisk/FreeSWITCH | An SDK WebSocket asking for the call's codec (μ-law/A-law/PCM at 8 kHz), forwarded as-is | `telephony` |
| Your own real-time agent loop (your STT + LLM) | An SDK WebSocket: one context per turn, `send_stream` for LLM tokens, `cancel` for barge-in | `voice-agents` |
| A website or web app that plays speech | Your server calls Bakbak; the browser plays MP3 or streamed PCM. Never ship the key to the browser. | `web` |
| A mobile app (iOS, Android, Flutter, React Native) | Same as web: the app asks your backend, which calls Bakbak | `web` |
| Narration, audiobooks, notifications, IVR prompts, batch jobs | Whole files (`generate`), MP3 or WAV; split text over 5,000 characters | `long-form` |
| Any Python backend | `bakbak-python` | `python-sdk` |
| Node.js, Next.js, Express, Bun, Deno, Workers | `bakbak` on npm | `javascript-sdk`, `web` |
| Go, Java, Kotlin, C#, Ruby, PHP, Rust, Dart, Elixir, … | The HTTP, SSE or WebSocket API directly | `raw-api` |
| Speech from an AI assistant (no code) | This MCP server's `text_to_speech` tool | `mcp-server` |

LiveKit Agents for Node.js (agents-js) has no Bakbak plugin yet. Use the Python
plugin, or wrap the JavaScript SDK's WebSocket in a custom agents-js TTS class
following `voice-agents`.

## Choosing a transport

| Transport | Latency | Use when |
|---|---|---|
| Whole file (`POST /v1/text-to-speech`) | Waits for all the audio | You need a file (WAV, MP3), or the text is short and latency doesn't matter. Only option for MP3 and WAV. |
| SSE stream (`POST /v1/text-to-speech/stream`) | First audio after one request | One utterance at a time where WebSockets are awkward: serverless functions, simple proxies. |
| WebSocket (`/v1/text-to-speech/ws`) | Lowest: the connection and gateway cost is paid once, about 10 ms less per request, more from far away | Voice agents, telephony, LLM output, anything conversational or with many requests. |

## How to use this server while coding

- Get real voice ids with the `list_voices` tool. Never invent ids; ids such as
  `voice_001` in some older examples are placeholders.
- Let the user hear candidate voices with `text_to_speech` before you hard-code one.
- Read `best-practices` before you finish, and `troubleshooting` when a call fails.
- Use `search_docs` for anything specific: a method, an option, an `error_code`.

## Documentation

- Docs site: https://docs.bakbak.si. Text to speech: `/text-to-speech/overview`,
  `/text-to-speech/output-formats`, `/text-to-speech/websocket`, `/text-to-speech/errors`;
  SDKs: `/sdks/python`, `/sdks/javascript`; integrations: `/integrations/livekit`,
  `/integrations/mcp`; API reference: `/api-reference/introduction`. Add `.md` to any
  page URL for Markdown; https://docs.bakbak.si/llms.txt lists every page. It replaces
  the old address, docs.litwizlabs.com.
- Source and examples: https://github.com/raya-voice-ai (bakbak-python, bakbak-js,
  livekit-plugins-bakbak, bakbak-mcp)
