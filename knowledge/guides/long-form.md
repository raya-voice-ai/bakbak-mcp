---
id: long-form
title: Long text, files and batch jobs
description: Narration, audiobooks, notifications and IVR prompts: splitting text over 5,000 characters, joining audio into one file, parallelism within your concurrency limit, retries and caching.
---

# Long text, files and batch jobs

## One request holds at most 5,000 characters

Longer text must be split. Split at sentence boundaries with the SDK segmenter,
then pack sentences into pieces up to your chosen size:

- up to 5,000 characters: fewest requests;
- 1,000 to 2,000 characters: first audio sooner, and a failure costs less to redo.

```python
from bakbak.text import split_sentences


def pieces(text: str, max_chars: int = 5000) -> list[str]:
    """Sentences joined with spaces into pieces of at most max_chars code points."""
    out: list[str] = []
    current = ""
    for sentence in split_sentences(text, max_chars=max_chars):
        if current and len(current) + 1 + len(sentence) <= max_chars:
            current += " " + sentence
        else:
            if current:
                out.append(current)
            current = sentence
    if current:
        out.append(current)
    return out
```

```ts
import { splitSentences } from 'bakbak';

export function pieces(text: string, maxChars = 5000): string[] {
  const out: string[] = [];
  let current = '';
  const length = (s: string) => [...s].length; // code points, as the API counts
  for (const sentence of splitSentences(text, { maxChars })) {
    if (current && length(current) + 1 + length(sentence) <= maxChars) current += ' ' + sentence;
    else {
      if (current) out.push(current);
      current = sentence;
    }
  }
  if (current) out.push(current);
  return out;
}
```

`split_sentences` wraps any single sentence longer than `max_chars` at a clause,
a space or a character boundary, so no piece exceeds the limit.

## Joining pieces into one file

**WAV (recommended for long audio):** stream every piece on one WebSocket context
as raw 16-bit PCM. The context plays them in order with no gap, and you add one
WAV header at the end.

```python
import asyncio

from bakbak import AsyncBakbak
from bakbak.audio import to_wav


async def narrate(text: str, voice_id: str, path: str) -> None:
    fmt = {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000}
    async with AsyncBakbak() as client:
        async with client.tts.websocket(
            voice_id=voice_id, language="hi", model="m1", output_format=fmt
        ) as ws:
            ctx = ws.context()
            for piece in pieces(text):
                await ctx.send(text=piece)
            ctx.end_input()
            pcm = b"".join([audio async for audio in ctx.audio()])
    with open(path, "wb") as f:
        f.write(to_wav(pcm, "pcm_s16le", 24000))


asyncio.run(narrate(open("chapter.txt").read(), "009ae8b5-4a03-492d-af1c-3055989ac734", "chapter.wav"))
```

For very long audio, write chunks to disk as they arrive instead of joining them
in memory, then write the header (sizes = total bytes).

**MP3:** streams carry only raw audio, so make one `POST /v1/text-to-speech`
request per piece with `{"container":"mp3"}` and concatenate the bodies: MP3
frames join cleanly (drop a leading ID3 tag from every piece after the first).
Check that each body really is MP3 before joining: it starts with `ID3` or an
`0xFF` frame-sync byte, not `RIFF` (see `troubleshooting` for `standard` voices).

**Raw for telephony:** concatenate raw pieces of the same encoding and rate.

## Parallelism

- Your account allows a fixed number of requests generating at once (the 429
  body's `concurrency_limit`). Run at most that many pieces at once with a
  semaphore or a worker pool; the SDK still retries a 429 with `Retry-After`.
- On a WebSocket, give each piece its own context to run them in parallel, and
  keep their order yourself; or use one context to have the server keep the order
  for you (one request generating at a time).
- One WebSocket allows 16 contexts generating at once and 64 unfinished requests.

```python
import asyncio

sem = asyncio.Semaphore(2)  # your plan's concurrency limit


async def one(client, piece: str, voice_id: str) -> bytes:
    async with sem:
        audio = await client.tts.generate(
            text=piece, voice_id=voice_id, language="hi", model="m1",
            output_format={"container": "mp3"},
        )
        return audio.data


async def book(client, text: str, voice_id: str) -> bytes:
    parts = await asyncio.gather(*(one(client, p, voice_id) for p in pieces(text, 2000)))
    return b"".join(parts)
```

## Retries and failures

- The SDKs retry each request before its first byte (connection errors, 429,
  5xx) and never after audio began. A whole-file request that fails mid-body
  raises `StreamInterruptedError`; regenerate that piece (it was charged).
- Record each piece's `request_id`. Make jobs resumable: store finished pieces so
  a failed job does not pay again for the pieces it already has.
- A 402 `insufficient_credits` stops a batch: check `required_inr` and pause.

## Caching

Fixed texts (IVR menus, greetings, notification templates) should be generated
once and stored. Key the cache by `text`, `voice_id`, `model`, `language`, `speed`
and `output_format`. Synthesis is not deterministic, so a regenerated file will
differ slightly from the cached one.

## Speed and voices

- `speed` (0.5 to 1.5) changes `standard` voices only; `m1` voices keep their own
  pace.
- For a book or a course, keep one voice for the narrator and store the
  `voice_id` with the project.

See also: `python-sdk`, `javascript-sdk`, `output-formats`, `best-practices`.
