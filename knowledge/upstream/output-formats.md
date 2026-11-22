---
id: output-formats
title: Output formats
description: output_format: containers, encodings (pcm_s16le, pcm_f32le, μ-law, A-law), sample rates, common choices, streaming and non-streaming examples.
url: https://docs.bakbak.si/text-to-speech/output-formats
---

# Output formats

Choose the encoding, container and sample rate of Bakbak TTS audio with output_format

Both TTS endpoints take an `output_format` object that sets exactly what audio you receive: the encoding, the container and the sample rate. Send it on every request.

```json
"output_format": {
  "container": "raw",
  "encoding": "pcm_mulaw",
  "sample_rate": 8000
}
```

If you leave it out, `/v1/text-to-speech` returns a WAV file and the streaming endpoint sends 32-bit float PCM, both at 24 kHz.

## Fields

| Field | `/v1/text-to-speech/stream` | `/v1/text-to-speech` | Default |
| --- | --- | --- | --- |
| `container` | `raw` | `raw`, `wav`, `mp3` | `raw` |
| `encoding` | `pcm_f32le`, `pcm_s16le`, `pcm_mulaw`, `pcm_alaw` | The same. Omit it for `mp3`. | Required, except for `mp3` |
| `sample_rate` | `8000`, `16000`, `22050`, `24000` | The same | `24000` |

The streaming endpoint always sends raw audio chunks, so `wav` and `mp3` are only available on `/v1/text-to-speech`.

## Encodings

All audio is mono.

| Encoding | Description | Bytes per sample |
| --- | --- | --- |
| `pcm_f32le` | 32-bit float, little-endian. What the streaming endpoint sends when you don't ask for anything else. | 4 |
| `pcm_s16le` | 16-bit signed integer, little-endian. What most audio stacks, including LiveKit and WebRTC pipelines, play directly. | 2 |
| `pcm_mulaw` | G.711 μ-law (PCMU). Telephony. | 1 |
| `pcm_alaw` | G.711 A-law (PCMA). Telephony. | 1 |

`pcm_s16le` is half the size of `pcm_f32le`, and the G.711 encodings are a quarter of the size, so choosing the encoding your player needs also reduces the bandwidth of each chunk.

## Common choices

| You are building | Send |
| --- | --- |
| A phone or SIP integration | `{"container": "raw", "encoding": "pcm_mulaw", "sample_rate": 8000}`, or `pcm_alaw`, whichever G.711 variant your telephony provider or SIP trunk uses |
| A real-time voice agent or WebRTC app | `{"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000}` (or the rate your pipeline runs at) |
| A file to play or store | `{"container": "wav", "encoding": "pcm_s16le"}` or `{"container": "mp3"}` on `/v1/text-to-speech` |

## Streaming example

Ask for 8 kHz μ-law on the stream:

```bash
curl -N -X POST https://hub.getraya.app/v1/text-to-speech/stream \
  -H "X-API-Key: <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
    "voice_id": "voice_001",
    "model": "standard",
    "language": "hi",
    "output_format": {
      "container": "raw",
      "encoding": "pcm_mulaw",
      "sample_rate": 8000
    }
  }'
```

The events have the same shape as always. The only difference is that the base64 `data` in each `chunk` event now holds μ-law bytes instead of 32-bit floats.

This Python example streams 16-bit PCM and saves it as a WAV file:

```python
import base64
import json
import wave

import requests

SAMPLE_RATE = 24000

response = requests.post(
    "https://hub.getraya.app/v1/text-to-speech/stream",
    headers={"X-API-Key": "<YOUR_API_KEY>"},
    json={
        "text": "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
        "voice_id": "voice_001",
        "model": "standard",
        "language": "hi",
        "output_format": {
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": SAMPLE_RATE,
        },
    },
    stream=True,
)
response.raise_for_status()

pcm = bytearray()
for line in response.iter_lines():
    if not line.startswith(b"data:"):
        continue
    event = json.loads(line[len(b"data:"):])
    if event.get("type") == "chunk":
        pcm += base64.b64decode(event["data"])

with wave.open("output.wav", "wb") as f:
    f.setnchannels(1)
    f.setsampwidth(2)  # 16-bit
    f.setframerate(SAMPLE_RATE)
    f.writeframes(bytes(pcm))
```

In a real-time app, play or forward each decoded chunk as it arrives instead of collecting them.

## Non-streaming examples

```bash WAV, 16-bit
curl -X POST https://hub.getraya.app/v1/text-to-speech \
  -H "X-API-Key: <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a test message.",
    "voice_id": "voice_001",
    "language": "hi",
    "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": 16000}
  }' \
  --output audio.wav
```

```bash Raw μ-law, 8 kHz
curl -X POST https://hub.getraya.app/v1/text-to-speech \
  -H "X-API-Key: <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a test message.",
    "voice_id": "voice_001",
    "language": "hi",
    "output_format": {"container": "raw", "encoding": "pcm_mulaw", "sample_rate": 8000}
  }' \
  --output audio.raw
```

```bash MP3
curl -X POST https://hub.getraya.app/v1/text-to-speech \
  -H "X-API-Key: <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a test message.",
    "voice_id": "voice_001",
    "language": "hi",
    "output_format": {"container": "mp3"}
  }' \
  --output audio.mp3
```

A `wav` container can hold any of the four encodings. For `pcm_s16le` the file has a standard 44-byte header. For `pcm_f32le`, `pcm_mulaw` and `pcm_alaw` it has the extended header that WAVE requires for those formats (58 bytes, with a `fact` chunk). Tools such as FFmpeg, SoX and libsndfile read both. Python's built-in `wave` module reads only the 16-bit form.

> **Note:** With the `standard` model, WAV responses are streamed as they are generated, so the size fields in the WAV header are set to `0xFFFFFFFF` rather than the real length. Read the body to the end instead of relying on those fields.

## Response headers

When you send `output_format`, the response includes headers that describe the audio you receive:

| Header | Value | Sent for |
| --- | --- | --- |
| `X-Audio-Format` | The encoding, for example `pcm_mulaw`, or `mp3` | Every `output_format` |
| `X-Audio-Sample-Rate` | The sample rate in Hz, for example `8000` | Every encoding except `mp3` |
| `X-Audio-Channels` | `1` | Every encoding except `mp3` |

An MP3 file states its own sample rate in its frames. Responses to requests without `output_format` don't include these headers.

On `/v1/text-to-speech`, `Content-Type` and the download filename follow the container you chose:

| Container | Encoding | `Content-Type` | Filename |
| --- | --- | --- | --- |
| `raw` | `pcm_s16le`, `pcm_f32le` | `audio/pcm` | `tts_output.raw` |
| `raw` | `pcm_mulaw` | `audio/basic` | `tts_output.raw` |
| `raw` | `pcm_alaw` | `application/octet-stream` | `tts_output.raw` |
| `wav` | Any | `audio/wav` | `tts_output.wav` |
| `mp3` | None | `audio/mpeg` | `tts_output.mp3` |

## Validation errors

An invalid `output_format` is rejected with `422 Unprocessable Entity` before any audio is generated, so it is not billed. The `loc` field points to the field at fault:

```json
{
  "detail": [
    {
      "type": "value_error",
      "loc": ["body", "output_format", "encoding"],
      "msg": "Value error, encoding must be one of: pcm_f32le, pcm_s16le, pcm_mulaw, pcm_alaw",
      "input": "mulaw",
      "ctx": {"error": {}}
    }
  ]
}
```

These requests are rejected:

| Request | Why |
| --- | --- |
| `container` is `wav` or `mp3` on the streaming endpoint | The stream sends raw chunks only. Use `/v1/text-to-speech` for WAV or MP3. |
| `encoding` is missing for `raw` or `wav` | The encoding is required unless the container is `mp3`. |
| `encoding` is sent with `mp3` | MP3 has no separate encoding. Leave the field out. |
| `encoding` is a short name such as `mulaw` | Use the full encoding names: `pcm_mulaw`, `pcm_alaw`, `pcm_s16le` or `pcm_f32le`. |
| `sample_rate` is `44100`, `48000` or another unsupported rate | The models produce `8000`, `16000`, `22050` and `24000` Hz. |
| `bit_rate` is sent | The model sets the MP3 bit rate. Leave the field out. |
| Any other field inside `output_format` | Unknown fields are rejected. |

All problems in a request are reported together, one entry each in `detail`.
