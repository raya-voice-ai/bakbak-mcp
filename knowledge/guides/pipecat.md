---
id: pipecat
title: Bakbak in Pipecat
description: A custom Pipecat TTSService built on the Bakbak Python SDK's WebSocket (Pipecat 1.x, run_tts with context_id): sample rates, interruptions, metrics, telephony serializers and pitfalls.
---

# Bakbak in Pipecat

Pipecat has no built-in Bakbak service yet. A small `TTSService` subclass on top
of the Bakbak Python SDK does the job: the SDK's WebSocket handles connections,
reconnects and retries, and Pipecat handles sentence aggregation, interruptions
and audio output.

Written against Pipecat 1.16 (November 2026). Since Pipecat 0.0.102,
`run_tts` takes a `context_id`; older Pipecat versions used `run_tts(self, text)`.
Check `pipecat.services.tts_service.TTSService` in your installed version.

## Install

```sh
pip install "pipecat-ai" --pre bakbak-python   # Pipecat needs Python 3.11+
```

Set `BAKBAK_API_KEY` in the bot's environment.

## The service

```python
from collections.abc import AsyncGenerator

import bakbak
from bakbak import AsyncBakbak
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    StartFrame,
    TTSAudioRawFrame,
)
from pipecat.services.tts_service import TTSService

BAKBAK_RATES = (8000, 16000, 22050, 24000)


class BakbakTTSService(TTSService):
    """Bakbak text to speech over one WebSocket per pipeline."""

    def __init__(
        self,
        *,
        voice_id: str,
        language: str = "hi",
        model: str = "m1",
        api_key: str | None = None,  # default: BAKBAK_API_KEY
        **kwargs,
    ) -> None:
        # The base class emits TTSStartedFrame/TTSStoppedFrame and starts the TTFB metric.
        super().__init__(push_start_frame=True, push_stop_frames=True, **kwargs)
        self._client = AsyncBakbak(api_key=api_key)
        self._voice = {"voice_id": voice_id, "language": language, "model": model}
        self._ws = None
        self._rate = 24000

    def can_generate_metrics(self) -> bool:
        return True

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        # Ask for the pipeline's output rate when Bakbak offers it, so nothing resamples.
        self._rate = self.sample_rate if self.sample_rate in BAKBAK_RATES else 24000
        self._ws = self._client.tts.websocket(
            **self._voice,
            output_format={"container": "raw", "encoding": "pcm_s16le", "sample_rate": self._rate},
        )
        await self._ws.connect()  # prewarm: the first reply pays no handshake

    async def stop(self, frame: EndFrame) -> None:
        await super().stop(frame)
        await self._shutdown()

    async def cancel(self, frame: CancelFrame) -> None:
        await super().cancel(frame)
        await self._shutdown()

    async def _shutdown(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        await self._client.close()

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        """Called once per sentence (Pipecat aggregates sentences by default)."""
        await self.start_tts_usage_metrics(text)
        ctx = self._ws.context()
        finished = False
        try:
            request = await ctx.send(text=text)
            ctx.end_input()
            async for audio in request:  # 16-bit PCM, whole samples
                await self.stop_ttfb_metrics()
                yield TTSAudioRawFrame(audio, self._rate, 1, context_id=context_id)
            finished = True
        except bakbak.BakbakError as e:
            finished = True
            yield ErrorFrame(error=f"Bakbak TTS failed: {e}")
        finally:
            if not finished:
                # The user interrupted: Pipecat cancelled this task or closed the
                # generator. Stop generating; a request cancelled before its first
                # audio is not billed.
                await ctx.cancel()
```

Use it like any Pipecat TTS:

```python
tts = BakbakTTSService(
    voice_id="009ae8b5-4a03-492d-af1c-3055989ac734",  # from list_voices, with its model
    language="hi",
    model="m1",
)
pipeline = Pipeline([transport.input(), stt, user_aggregator, llm, tts, transport.output(), assistant_aggregator])
```

## How it behaves

- **Sentences.** Pipecat aggregates LLM text into sentences by default
  (`text_aggregation_mode` SENTENCE) and calls `run_tts` once per sentence. Each
  sentence is one Bakbak request on the open WebSocket, so it starts in tens of
  milliseconds.
- **Interruptions.** Pipecat cancels the task running `run_tts` (or closes the
  generator); the `finally` block cancels the Bakbak context, which stops the
  request on the server.
- **Errors.** The SDK retries before any audio (twice, with backoff) and never
  after audio began; a failure reaches Pipecat as an `ErrorFrame`.
- **Reconnects.** Idle closes (5 minutes), server restarts and dropped connections
  are handled by the SDK; the next sentence reconnects.

## Sample rates and telephony

- `self.sample_rate` is the pipeline's output rate (`audio_out_sample_rate`,
  24000 by default, or the service's own `sample_rate=`). Bakbak produces 8000,
  16000, 22050 or 24000 Hz; for any other rate the service asks for 24000 and
  Pipecat 1.16+ resamples.
- Pipecat audio frames are 16-bit PCM, so always request `pcm_s16le` here.
  For phone calls, Pipecat's serializers (Twilio, Plivo, Exotel, Vonage, Telnyx)
  convert 16-bit PCM to the provider's codec: set the pipeline's output rate to
  8000 (or 16000 for Vonage) and Bakbak produces exactly that.

## Pitfalls

- **`run_tts` signature.** Pipecat 0.0.102 and later require `context_id`. On older
  versions, drop the argument and the `context_id=` of the frame.
- **Voice and model must match** (404 `voice_not_found` otherwise); `speed` affects
  `standard` voices only.
- **Hindi in Devanagari.** Put "answer in Devanagari; no markdown or emoji" in the
  LLM's system prompt.
- **One WebSocket carries 16 contexts generating at once.** One service instance
  per pipeline (per call) is well within that.

See also: `voice-agents`, `python-sdk`, `telephony`, `best-practices`.
