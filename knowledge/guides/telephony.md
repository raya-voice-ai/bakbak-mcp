---
id: telephony
title: Phone calls: Twilio, Plivo, Exotel, Vonage and SIP
description: Speak into phone calls through media-stream WebSockets: which output_format each provider needs, the messages that play and clear audio, a Twilio bridge in Python and Node, Exotel chunking, Vonage framing, barge-in and capacity.
---

# Phone calls: Twilio, Plivo, Exotel, Vonage and SIP

Telephony providers stream a call's audio to your server over a WebSocket and
play the audio you send back. Bakbak can produce each provider's exact codec
and rate, so its chunks are forwarded without transcoding or resampling.

If the call is bridged into LiveKit (LiveKit SIP), use the LiveKit plugin
(`livekit`) instead; with Pipecat, its serializers do the conversion (`pipecat`).

## Formats and messages by provider

| Provider | Ask Bakbak for | Play audio | Stop playback (barge-in) |
|---|---|---|---|
| **Twilio** Media Streams (`<Connect><Stream>`) | `pcm_mulaw`, 8000 Hz (always) | text message `{"event":"media","streamSid":"MZ…","media":{"payload":"<base64>"}}` | `{"event":"clear","streamSid":"MZ…"}` |
| **Plivo** Audio Streaming (`<Stream bidirectional="true">`) | Match the Stream's `contentType`: `audio/x-mulaw;rate=8000` → `pcm_mulaw` 8000; `audio/x-l16;rate=8000` or `16000` → `pcm_s16le` at that rate | `{"event":"playAudio","media":{"contentType":"audio/x-mulaw","sampleRate":8000,"payload":"<base64>"}}` | `{"event":"clearAudio","streamId":"…"}` |
| **Exotel** Voicebot applet (AgentStream) | `pcm_s16le` at the applet's rate (`?sample-rate=` 8000 default, 16000 or 24000); confirm with `start.media_format` | `{"event":"media","stream_sid":"…","media":{"payload":"<base64>"}}`, in chunks that are multiples of 320 bytes, at least 3,200 bytes | `{"event":"clear","stream_sid":"…"}` |
| **Vonage** Voice API WebSockets | `pcm_s16le` at the NCCO `content-type` rate (`audio/l16;rate=16000` recommended, or 8000) | **binary** messages of raw PCM, 20 ms each (640 bytes at 16 kHz, 320 at 8 kHz) | text `{"action":"clear"}` |
| **SIP / Asterisk / FreeSWITCH** (your own media bridge) | The negotiated codec: PCMU → `pcm_mulaw` 8000; PCMA → `pcm_alaw` 8000; signed linear → `pcm_s16le` at 8000 or 16000 | per bridge | flush the bridge's buffer |

Always set Plivo's `contentType` explicitly; its default differs between its own
pages. Exotel's newer "extension" mode can also use μ-law: read the format the
`start` event announces and request the same.

Every provider plays what you send in order and buffers it (about a minute), so
you can forward chunks as fast as Bakbak produces them. Marks (Twilio and Exotel
`mark`, Plivo `checkpoint`, Vonage `notify`) tell you when a reply has finished
playing.

## Architecture

```
caller ⇄ provider ⇄ (media WebSocket) ⇄ your server ⇄ (Bakbak WebSocket) ⇄ Bakbak
                                            │
                                     STT → LLM → text
```

- One Bakbak WebSocket per call, opened when the call starts, is simplest. At
  scale, share one Bakbak WebSocket among calls with a context per call: one
  connection carries 16 contexts generating at once.
- One context per agent turn; send the LLM's tokens with `send_stream` so the
  first sentence plays while the rest is written (`voice-agents`).
- On barge-in (your STT hears the caller), do **both**: `ctx.cancel()` on the
  Bakbak context, and the provider's clear message. Audio already sent to the
  provider keeps playing until you clear it.

## Twilio bridge in Python (FastAPI)

TwiML for the call:

```xml
<Response>
  <Connect><Stream url="wss://your-server.example.com/twilio" /></Connect>
</Response>
```

```python
import asyncio
import base64
import json

from bakbak import AsyncBakbak
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI()
bakbak = AsyncBakbak()  # one per process; reads BAKBAK_API_KEY
VOICE = {"voice_id": "009ae8b5-4a03-492d-af1c-3055989ac734", "language": "hi", "model": "m1"}
ULAW_8K = {"container": "raw", "encoding": "pcm_mulaw", "sample_rate": 8000}


@app.websocket("/twilio")
async def twilio(call: WebSocket) -> None:
    await call.accept()
    tts = bakbak.tts.websocket(**VOICE, output_format=ULAW_8K)
    await tts.connect()  # before the caller hears anything
    stream_sid = None
    turn: asyncio.Task | None = None
    ctx = None

    async def speak(tokens) -> None:
        """Speak a string list or an LLM token stream into the call."""
        nonlocal ctx
        ctx = tts.context()
        sender = asyncio.create_task(ctx.send_stream(tokens))
        async for audio in ctx.audio():  # μ-law bytes, ready for Twilio
            await call.send_text(json.dumps({
                "event": "media",
                "streamSid": stream_sid,
                "media": {"payload": base64.b64encode(audio).decode()},
            }))
        await sender

    async def barge_in() -> None:
        if ctx is not None:
            await ctx.cancel()
        await call.send_text(json.dumps({"event": "clear", "streamSid": stream_sid}))

    try:
        while True:
            message = json.loads(await call.receive_text())
            if message["event"] == "start":
                stream_sid = message["start"]["streamSid"]
                turn = asyncio.create_task(speak(["नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?"]))
            elif message["event"] == "media":
                pass  # caller audio (base64 μ-law 8 kHz): feed your STT; call barge_in() on speech
            elif message["event"] == "stop":
                break
    except WebSocketDisconnect:
        pass
    finally:
        if turn is not None:
            turn.cancel()
        await tts.close()
```

## Twilio bridge in Node.js (ws)

```ts
import { WebSocketServer } from 'ws';
import { Bakbak, type WebSocketContext } from 'bakbak';

const bakbak = new Bakbak(); // reads BAKBAK_API_KEY; `npm install bakbak ws`
const wss = new WebSocketServer({ port: 8080, path: '/twilio' });

wss.on('connection', (call) => {
  const tts = bakbak.tts.websocket({
    voice_id: '009ae8b5-4a03-492d-af1c-3055989ac734',
    language: 'hi',
    model: 'm1',
    output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
  });
  void tts.connect();
  let streamSid = '';
  let ctx: WebSocketContext | undefined;

  async function speak(tokens: Iterable<string> | AsyncIterable<unknown>) {
    const turn = (ctx = tts.context());
    const sending = turn.sendStream(tokens);
    for await (const audio of turn.audio()) {
      const payload = Buffer.from(audio).toString('base64');
      call.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    }
    await sending;
  }

  async function bargeIn() {
    await ctx?.cancel();
    call.send(JSON.stringify({ event: 'clear', streamSid }));
  }

  call.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      speak(['नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?']).catch(console.error);
    } else if (msg.event === 'media') {
      // caller audio: feed your STT; call bargeIn() when the caller speaks
    }
  });
  call.on('close', () => void tts.close());
});
```

## Plivo

Answer XML, with the format stated explicitly:

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">wss://your-server.example.com/plivo</Stream>
</Response>
```

Request `pcm_mulaw` at 8000 and send each chunk as
`{"event":"playAudio","media":{"contentType":"audio/x-mulaw","sampleRate":8000,"payload":"<base64>"}}`
(`sampleRate` a number). For `audio/x-l16;rate=16000`, request `pcm_s16le` at
16000 and send `"contentType":"audio/x-l16","sampleRate":16000`. Keep each message
under 64 KB. The `start` event carries `streamId` for `clearAudio` and `checkpoint`.

## Exotel

Exotel wants 16-bit PCM in chunks that are multiples of 320 bytes, at least
3,200 bytes (a short final chunk makes it wait 20 ms). Re-chunk Bakbak's audio:

```python
class ExotelChunker:
    """Re-chunks 16-bit PCM for Exotel: multiples of 320 bytes, at least 3,200."""

    def __init__(self, minimum: int = 3200) -> None:
        self.buffer = bytearray()
        self.minimum = minimum

    def push(self, audio: bytes) -> list[bytes]:
        self.buffer += audio
        if len(self.buffer) < self.minimum:
            return []
        size = len(self.buffer) - len(self.buffer) % 320
        chunk, self.buffer = bytes(self.buffer[:size]), self.buffer[size:]
        return [chunk]

    def flush(self) -> list[bytes]:
        """At the end of a reply: pad with silence to a multiple of 320 bytes."""
        if not self.buffer:
            return []
        self.buffer += b"\x00" * (-len(self.buffer) % 320)
        chunk, self.buffer = bytes(self.buffer), bytearray()
        return [chunk]
```

Send each chunk as `{"event":"media","stream_sid":"…","media":{"payload":"<base64>"}}`
(snake_case `stream_sid`), and request `pcm_s16le` at the rate of the applet URL's
`sample-rate` (8000 unless you set 16000 or 24000).

## Vonage

The NCCO `connect` action opens the WebSocket and sets the format:

```json
[{"action": "connect", "endpoint": [{"type": "websocket", "uri": "wss://your-server.example.com/vonage",
  "content-type": "audio/l16;rate=16000"}]}]
```

Request `pcm_s16le` at 16000 and send the audio as **binary** WebSocket messages
of 640 bytes (20 ms); carry the remainder into the next chunk. Vonage buffers about
a minute; for long replies pace the frames at about one per 20 ms.
`{"action":"clear"}` (a text message) stops playback.

## Capacity and cost

- Each speaking turn uses one of your account's concurrent requests while it
  generates; sentences queued behind it use none. Size the plan for simultaneous
  speaking turns, and ask support to raise the limit before launch.
- Cache fixed prompts (greetings, menus, hold messages) as μ-law/A-law files
  instead of synthesizing them on every call.
- G.711 is a quarter of the size of the default 32-bit float stream, so asking for
  it also cuts bandwidth.

See also: `voice-agents`, `examples/python/telephony.py`,
`examples/javascript/telephony-mulaw.ts`, `output-formats`, `best-practices`.
