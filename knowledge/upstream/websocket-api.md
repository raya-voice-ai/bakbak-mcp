---
id: websocket-api
title: WebSocket API reference
description: The /v1/text-to-speech/ws protocol: connecting, request messages and context_id, chunk/done/error/cancelled messages, cancel, limits, close codes, Python and Node examples.
url: https://docs.bakbak.si/text-to-speech/websocket
---

# Text to Speech (WebSocket)

Many streaming synthesis requests on one connection: the lowest-latency way to use Bakbak TTS.

`wss://hub.getraya.app/v1/text-to-speech/ws` carries many streaming synthesis
requests on one connection. Each request behaves exactly like
[`POST /v1/text-to-speech/stream`](https://docs.bakbak.si/api-reference/text-to-speech/stream-speech):
the same fields, validation, billing and limits. The audio comes back as JSON
messages carrying the same payloads as the stream's events.

**Why use it:** an HTTP request pays the connection set-up and the API
gateway's checks every time. A WebSocket pays them once, when it opens. On our
measurements that took about 10 ms off time to first audio per request, before
counting the network round trips a new HTTP connection costs from far away.

> **Tip:** The official [Python](https://docs.bakbak.si/sdks/python) and [JavaScript](https://docs.bakbak.si/sdks/javascript)
> SDKs and the [LiveKit plugin](https://docs.bakbak.si/integrations/livekit) use this endpoint for you,
> with reconnects, ordering and cancellation handled.

## Connect

- **URL:** `wss://hub.getraya.app/v1/text-to-speech/ws`
- **Authentication:** the `X-API-Key` header. Browsers cannot set headers on a
  WebSocket, so the key is also accepted as a query parameter:
  `?X-API-Key=<key>`. Prefer the header everywhere else.

A wrong key is refused before the upgrade with HTTP 401.

## Send requests

Send each request as one JSON **text** message: the body of the streaming
endpoint, plus an optional `context_id` (up to 128 characters of
`A-Z a-z 0-9 . _ -`).

```json
{"context_id": "turn-7", "model": "m1", "voice_id": "009ae8b5-4a03-492d-af1c-3055989ac734",
 "language": "hi", "text": "नमस्ते, मैं आपकी कैसे मदद कर सकता हूँ?",
 "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000}}
```

**Ordering.** Requests with the same `context_id` run one after another, in
the order you sent them, so a reply sent sentence by sentence plays in order.
Requests in different contexts run at the same time and their messages
interleave; tell them apart by `context_id`. Requests without a `context_id`
share one implicit context.

A request queued behind its context holds no capacity and is not billed until
it starts.

## Receive audio

Every message has a `type` and a `done` flag. A request produces zero or more
`chunk` messages, then exactly one `done` or `error`:

```json
{"type":"chunk","status_code":206,"done":false,"data":"<base64 audio>","step_time":0.0123,"context_id":"turn-7","request_id":"req_…"}
{"type":"done","status_code":200,"done":true,"context_id":"turn-7","request_id":"req_…"}
```

`data` is base64 audio in the request's `output_format` (32-bit float PCM at
24 kHz without one). `request_id` identifies the request to support.

## Cancel

```json
{"context_id": "turn-7", "cancel": true}
```

stops the context's running request and drops the ones queued behind it, for
example when the caller interrupts. You get exactly one
`{"type":"cancelled","done":true,"context_id":"turn-7"}`, and nothing sent before
the cancel arrives after it: discard the context's audio until you see it. A
request sent after the cancel on the same context runs normally.

A request cancelled after its first audio is billed like a delivered request;
one cancelled before any audio is not.

## Errors

```json
{"type":"error","status_code":422,"done":true,"message":"…","error_code":"invalid_request","retryable":false,"detail":[…],"context_id":"turn-7","request_id":"req_…"}
```

`status_code` is the HTTP status the same failure gets on the streaming
endpoint, with that endpoint's [error fields](https://docs.bakbak.si/text-to-speech/errors). An error
ends that request only: the connection stays open, other contexts carry on,
and later requests on the same context still run. A refusal keeps its place in
its context's order.

An `error` with neither `context_id` nor `request_id` is about a message that
was not a request, such as a binary frame.

## Limits

| Limit | Value | When exceeded |
|---|---|---|
| Contexts generating at once, per connection | 16 | the new request gets a 429 `error` |
| Requests accepted and not finished, per connection | 64 | the new request gets a 429 `error` |
| Message size | 256 KiB | 413 `error`; above 512 KiB the connection closes with 1009 |
| Nothing sent and nothing in progress | 5 minutes | closed with 1000 |

The server pings every 30 seconds. Browsers answer automatically; other
clients must keep reading the socket so their library answers too.

## Close codes

| Code | Meaning | What to do |
|---|---|---|
| 1000 | Idle timeout | Reconnect when you next need it. |
| 1001 | The server is restarting | Reconnect at once and resend every request that had not received its `done` or `error`. Everything the server had accepted was finished first. |
| 1008 | Too many messages sent without reading answers | Wait for answers before sending more. |
| 1009 | A message over 512 KiB | Send smaller messages. |

While a connection is closing for a restart, a new request is refused with a
503 `error` asking you to reconnect and send it again. However a connection
ends, a request without its `done` or `error` did not complete: resend it on a
new connection, unless you already received some of its audio.

## Example

```python Python (websockets)
import asyncio, base64, json, os
import websockets

async def main():
    async with websockets.connect(
        "wss://hub.getraya.app/v1/text-to-speech/ws",
        additional_headers={"X-API-Key": os.environ["BAKBAK_API_KEY"]},
    ) as ws:
        await ws.send(json.dumps({
            "context_id": "greeting", "model": "m1", "language": "hi",
            "voice_id": "009ae8b5-4a03-492d-af1c-3055989ac734",
            "text": "नमस्ते, मैं आपकी कैसे मदद कर सकता हूँ?",
            "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000},
        }))
        audio = bytearray()
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "chunk":
                audio += base64.b64decode(msg["data"])
            elif msg["done"]:
                if msg["type"] == "error":
                    raise RuntimeError(msg["message"])
                break
        print(len(audio), "bytes of 16-bit PCM")

asyncio.run(main())
```

```javascript Node.js (ws)
import WebSocket from "ws";

const ws = new WebSocket("wss://hub.getraya.app/v1/text-to-speech/ws", {
  headers: { "X-API-Key": process.env.BAKBAK_API_KEY },
});
const chunks = [];
ws.on("open", () => ws.send(JSON.stringify({
  context_id: "greeting", model: "m1", language: "hi",
  voice_id: "009ae8b5-4a03-492d-af1c-3055989ac734",
  text: "नमस्ते, मैं आपकी कैसे मदद कर सकता हूँ?",
  output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
})));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === "chunk") chunks.push(Buffer.from(msg.data, "base64"));
  else if (msg.done) {
    if (msg.type === "error") throw new Error(msg.message);
    console.log(Buffer.concat(chunks).length, "bytes of 16-bit PCM");
    ws.close();
  }
});
```
