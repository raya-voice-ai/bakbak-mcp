---
id: livekit
title: Bakbak in LiveKit Agents
description: Add Bakbak speech to a LiveKit Agents voice agent (Python) with livekit-plugins-bakbak: install, voices and languages, multilingual agents, telephony through LiveKit SIP, fallbacks, metrics, deployment and pitfalls.
---

# Bakbak in LiveKit Agents

`livekit-plugins-bakbak` is the official LiveKit Agents TTS plugin. It keeps one
WebSocket per `TTS` instance, sends each sentence of the LLM's reply the moment
it is complete, cancels on interruptions, and never replays audio. The full
option reference is the `livekit-plugin` page; a complete agent is
`examples/livekit/agent.py`.

Supported: `livekit-agents` 1.8.7 and later 1.x (the 2.0 pre-releases are not
supported yet), Python 3.10 to 3.14.

## Add it to an agent

1. Install, keeping LiveKit Agents on 1.x:

   ```sh
   pip install livekit-plugins-bakbak "livekit-agents~=1.8"
   ```

2. Set `BAKBAK_API_KEY` in the agent worker's environment (`.env` locally; a
   secret of the agent on LiveKit Cloud or your deployment platform).

3. Choose a voice with the `list_voices` tool (or `await tts.list_voices(...)`)
   and note its `id`, `language` and `model`.

4. Pass the TTS to the session:

   ```python
   from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli
   from livekit.plugins import bakbak, deepgram, openai

   server = AgentServer()


   @server.rtc_session()
   async def entrypoint(ctx: JobContext) -> None:
       session = AgentSession(
           stt=deepgram.STT(model="nova-3", language="multi"),
           llm=openai.LLM(model="gpt-4o-mini"),
           tts=bakbak.TTS(
               voice_id="009ae8b5-4a03-492d-af1c-3055989ac734",  # Anika M1, from list_voices
               language="hi",
               model="m1",  # the voice's own model
           ),
       )
       await session.start(
           agent=Agent(instructions="हिंदी में छोटे, बोलचाल वाले जवाब दें। Markdown या इमोजी का उपयोग न करें।"),
           room=ctx.room,
       )


   if __name__ == "__main__":
       cli.run_app(server)
   ```

   Replacing another TTS plugin is the same one-line change: `tts=bakbak.TTS(...)`.

5. Run it: `python agent.py console` to talk in the terminal, or `python agent.py dev`
   for a room.

## Options that matter most

| Option | Default | Notes |
|---|---|---|
| `voice_id` | Anika M1 (Hindi, `m1`) | Any voice id; pass its `model` too. |
| `language` | `"hi"` | API codes, BCP-47 tags (`hi-IN`) or names (`"marathi"`). `en-IN`/`en-US` map to the `standard` English voices; `en` to the `m1` ones. |
| `model` | `"m1"` | Must match the voice. |
| `speed` | not sent | 0.5 to 1.5; `standard` voices only. |
| `sample_rate` | `24000` | 16-bit mono PCM at this rate. |
| `transport` | `"websocket"` | `"http"` (one SSE request per sentence) only where WebSockets are blocked. |
| `tokenizer` | `bakbak.SentenceTokenizer()` | `SentenceTokenizer(eager_first_clause=True)` starts speech sooner when replies open with a long sentence. |
| `text_pacing` | `False` | `True` batches sentences while plenty of audio is queued. |

## Multilingual agents

A voice speaks the languages of its model. To switch language mid-session,
switch to a voice of that language and its model; it applies from the next
utterance:

```python
voice = (await tts.list_voices(model="standard", language="mr"))[0]
tts.update_options(voice_id=voice.id, language="mr", model="standard")
```

Tell the LLM which language and script to answer in (Hindi in Devanagari, Indian
names in Devanagari even inside English sentences).

## Telephony through LiveKit SIP

Phone calls into a LiveKit room need nothing Bakbak-specific: LiveKit resamples
TTS audio to the room output's rate (24 kHz by default) and LiveKit SIP converts
it to the call's codec (PCMU, PCMA or G.722). Keep `sample_rate=24000` unless you
also lower the room output's rate. For media streams *outside* LiveKit (Twilio,
Plivo, Exotel, Vonage), see `telephony`.

## Fallback to another TTS

Errors are LiveKit's own classes, so LiveKit's `FallbackAdapter` works:

```python
from livekit.agents import tts
from livekit.plugins import bakbak

speech = tts.FallbackAdapter(
    [
        bakbak.TTS(language="hi"),
        bakbak.TTS(language="hi", transport="http"),  # or another provider's TTS
    ]
)
session = AgentSession(stt=..., llm=..., tts=speech)
```

LiveKit retries a retryable error (per `conn_options`) only before any audio of
the utterance was delivered; after audio, the error is reported, never replayed.

## Metrics

The plugin reports LiveKit TTS metrics labelled `provider="Bakbak"`:

```python
from livekit.agents import MetricsCollectedEvent, metrics


@session.on("metrics_collected")
def _on_metrics(ev: MetricsCollectedEvent) -> None:
    metrics.log_metrics(ev.metrics)
```

Watch `ttfb` (time to first audio). Close to the API, the WebSocket transport
measured about 22 ms p50 from `push_text()` to the first frame.

## Pitfalls

- **`livekit-agents` 2.0 betas** are a rewrite of the plugin interface: pin `~=1.8`.
- **Voice and model must match.** An `m1` voice with `model="standard"` is refused
  (404 `voice_not_found`).
- **`speed` does nothing on `m1` voices.**
- **A missing key** raises `ValueError` naming `api_key` and `BAKBAK_API_KEY` when
  the `TTS` is created.
- **Migrating from `livekit-plugins-raya`:** `from livekit.plugins import bakbak`,
  `bakbak.TTS(...)`; `RAYA_API_KEY` still works with a warning. The default voice
  changed (pass your old `voice_id` to keep it), and `encoding`/`codec` options are
  gone (audio is always 16-bit PCM). See the migration table in `livekit-plugin`.
- **Node.js agents (agents-js):** there is no Bakbak plugin for agents-js yet.
  Run the agent in Python, or wrap the JavaScript SDK's WebSocket in a custom TTS
  (pattern in `voice-agents`).

See also: `livekit-plugin` (full reference), `examples/livekit/agent.py`,
`examples/livekit/synthesize_to_wav.py`, `voice-agents`, `best-practices`.
