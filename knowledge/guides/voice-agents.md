---
id: voice-agents
title: Real-time voice agents with the Bakbak WebSocket
description: How to wire Bakbak into your own speech-to-text → LLM → speech loop: one WebSocket, a context per turn, LLM tokens sent sentence by sentence, barge-in with cancel, and the latency budget.
---

# Real-time voice agents with the Bakbak WebSocket

Use this page when you run your own agent loop (your STT, your LLM, your audio
transport). On LiveKit, use the plugin instead (`livekit`); on Pipecat, see
`pipecat`; for phone media streams, also read `telephony`.

## The shape of a good integration

1. **One `AsyncBakbak` / `Bakbak` client per process**, one WebSocket per call or
   agent session, opened when the session starts (before the first reply).
2. **One context per assistant turn.** Requests on a context play in order;
   different contexts run at the same time, so a new turn never waits behind an
   old one.
3. **Feed the LLM's token stream to `send_stream`.** It splits the text into
   sentences with the Bakbak segmenter and sends each sentence the moment it is
   complete, so the first audio plays while the LLM is still writing.
4. **Play audio as it arrives**, in the format you asked for.
5. **On barge-in, cancel the context** and clear whatever audio your transport
   has buffered. The context (and the WebSocket) stay usable.

## Python (asyncio)

```python
import asyncio

from bakbak import AsyncBakbak
from bakbak.text import Segmenter

client = AsyncBakbak()  # one per process; reads BAKBAK_API_KEY


class Speaker:
    """One per call: owns the WebSocket and the current turn's context."""

    def __init__(self, play) -> None:
        self.play = play  # async callable taking bytes (16-bit PCM, 24 kHz)
        self.ws = client.tts.websocket(
            voice_id="009ae8b5-4a03-492d-af1c-3055989ac734",  # from list_voices
            language="hi",
            model="m1",
            output_format={"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000},
        )
        self.ctx = None
        self.turn: asyncio.Task | None = None

    async def start(self) -> None:
        await self.ws.connect()  # prewarm: the first reply pays no handshake

    async def say(self, llm_tokens) -> None:
        """Speak an LLM stream (OpenAI/Anthropic/Gemini events or strings)."""
        await self.interrupt()
        self.ctx = ctx = self.ws.context()
        self.turn = asyncio.create_task(self._run(ctx, llm_tokens))

    async def _run(self, ctx, llm_tokens) -> None:
        sender = asyncio.create_task(
            ctx.send_stream(llm_tokens, segmenter=Segmenter(eager_first_clause=True))
        )
        try:
            async for audio in ctx.audio():
                await self.play(audio)
        finally:
            await sender

    async def interrupt(self) -> None:
        """Barge-in: silence now, stop paying for the rest of the reply."""
        if self.ctx is not None:
            await self.ctx.cancel()  # unfinished requests end as Cancelled
        if self.turn is not None:
            await asyncio.gather(self.turn, return_exceptions=True)
        self.ctx = self.turn = None

    async def close(self) -> None:
        await self.interrupt()
        await self.ws.close()
```

- `ctx.audio()` raises the first failure of the turn; use `ctx.events()` instead
  to see each request's `Chunk`, `Done`, `Failed` and `Cancelled` and keep going
  after a failed sentence.
- `send_stream` returns when the tokens end (or when `cancel()` stops it) and
  then calls `end_input()`, which lets `ctx.audio()` finish.
- With the sync `Bakbak` client the API is the same without `await`; read
  `ctx.audio()` on one thread while another sends.

## JavaScript / TypeScript

```ts
import { Bakbak, type WebSocketContext } from 'bakbak';

const client = new Bakbak(); // reads BAKBAK_API_KEY; on Node also `npm install ws`

export class Speaker {
  #ws = client.tts.websocket({
    voice_id: '009ae8b5-4a03-492d-af1c-3055989ac734', // from list_voices
    language: 'hi',
    model: 'm1',
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
  });
  #ctx: WebSocketContext | undefined;
  #play: (pcm: Uint8Array) => void;

  constructor(play: (pcm: Uint8Array) => void) {
    this.#play = play;
  }

  start() {
    return this.#ws.connect(); // prewarm
  }

  /** llm: an OpenAI/Anthropic/Gemini/Vercel AI SDK stream, or any (async) iterable of strings. */
  async say(llm: AsyncIterable<unknown>) {
    await this.interrupt();
    const ctx = (this.#ctx = this.#ws.context());
    const sending = ctx.sendStream(llm, { segmenter: { eagerFirstClause: true } });
    for await (const audio of ctx.audio()) this.#play(audio);
    await sending;
  }

  async interrupt() {
    await this.#ctx?.cancel(); // drops unplayed audio and stops sendStream
    this.#ctx = undefined;
  }

  close() {
    return this.#ws.close();
  }
}
```

## Barge-in

When the user starts speaking over the agent:

1. `await ctx.cancel()`. The running request stops, queued sentences are dropped,
   any audio received but not yet read is discarded, and `send_stream` stops
   reading the LLM. A request cancelled before its first audio is not billed.
2. Clear your own playback buffer too: the audio device queue, the WebRTC track
   buffer, or the telephony provider's buffer (Twilio `clear`, Plivo
   `clearAudio`; see `telephony`). Audio already handed to them is outside
   Bakbak's control.
3. Start the next turn on a new context (or the same one: it stays usable).

## Latency budget

- **Handshake:** zero per turn when the WebSocket is opened at session start.
- **First sentence:** `send_stream` sends it the moment it ends, however short
  (`first_min_chars` 1). If replies open with a long sentence, `eager_first_clause`
  sends the first clause (24+ characters ending in `,` `;` `:` `—`) on its own.
- **Between sentences:** none. The server queues a context's sentences and starts
  each one as the previous finishes.
- **Time to first audio** measured from a nearby machine: about 21 ms over the
  WebSocket and 33 ms over SSE (m1, warm connection). Measure from your own
  servers with the `bench_ttfa` examples.
- Ask for the format your output plays (`pcm_s16le` at the track rate, or
  G.711 at 8 kHz for phone calls) so nothing resamples.
- Ask the LLM for short sentences in the first line of the reply.

## Reliability

- The SDK reconnects after idle closes (5 minutes with nothing in progress),
  server restarts (close 1001) and draining refusals, and resends every request
  that had no audio yet. A request whose audio had started fails with
  `StreamInterruptedError` (never replayed).
- An error ends its own request only; later sentences of the context still run.
- Per connection: at most 16 contexts generating at once and 64 unfinished
  requests. `send` waits rather than exceed them. For more, open more WebSockets.
- Account concurrency: each generating context counts against your plan's
  limit. A turn uses one slot while it speaks; queued sentences use none.

## Text for agents

Put these in the LLM's system prompt:

- Answer in short spoken sentences; no markdown, lists, emoji or URLs.
- Write Hindi in Devanagari; write Indian names in Devanagari even inside
  English sentences.
- Spell out what should be read differently from how it is written.

See also: `best-practices`, `python-sdk` (WebSocket section),
`javascript-sdk` (WebSocket section), `websocket-api`, `examples/python/llm_streaming.py`,
`examples/javascript/llm-tokens.ts`.
