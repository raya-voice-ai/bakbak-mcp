---
id: raw-api
title: Calling the API directly (Go, Java, C#, Ruby, PHP, Rust, Dart, …)
description: Everything needed to integrate without an SDK: endpoints, request and response formats, SSE and WebSocket protocols, curl commands, a Go client, and the behaviour rules a robust client must follow.
---

# Calling the API directly

There are official SDKs for Python and JavaScript only. From any other language,
call the API over HTTP, SSE or WebSocket. This page is the complete reference;
`client-behavior` has the full contract the official clients implement, and
`websocket-api`, `errors` and `output-formats` go deeper on each part.

## Endpoints

| Operation | Request | Response |
|---|---|---|
| Whole file | `POST https://hub.getraya.app/v1/text-to-speech` with a JSON body | `200` and the audio bytes |
| One stream | `POST https://hub.getraya.app/v1/text-to-speech/stream` with a JSON body | `200` and Server-Sent Events |
| Many streams | `GET wss://hub.getraya.app/v1/text-to-speech/ws`, then JSON text messages | JSON text messages |
| Voices | `GET https://hub.getraya.app/v1/voices` | `{"voices":[{"id","name","language","model"}],"count":N}` |

Send `X-API-Key: <key>` on every request (`Content-Type: application/json` on
POSTs). A WebSocket from a browser, which cannot set headers, may put the key
in the URL as `?X-API-Key=<key>`; everywhere else use the header.

## Request body

```json
{
  "text": "नमस्ते, आपका ऑर्डर कल पहुँच जाएगा।",
  "voice_id": "009ae8b5-4a03-492d-af1c-3055989ac734",
  "language": "hi",
  "model": "m1",
  "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000}
}
```

| Field | Notes |
|---|---|
| `text` | Required. 1 to 5,000 characters. Hindi in Devanagari. |
| `voice_id` | Required. From `/v1/voices`. |
| `language` | Required. `hi mr te kn bn as gu ne ml ta pa en en-in en-us`. |
| `model` | `standard` (default) or `m1`; must be the voice's model. |
| `speed` | 0.5 to 1.5, default 1.0; `standard` voices only. |
| `output_format` | `container` `raw`/`wav`/`mp3` (streams: `raw` only); `encoding` `pcm_s16le`/`pcm_f32le`/`pcm_mulaw`/`pcm_alaw` (required for raw and wav, omitted for mp3); `sample_rate` 8000/16000/22050/24000 (default 24000). Mono. |

Unknown fields are refused with 422. Without `output_format`, a whole file is
24 kHz WAV and a stream is 24 kHz 32-bit float PCM.

## Responses

**Whole file:** the body is the audio. With `output_format` the response has
`X-Audio-Format` (the encoding, or `mp3`), `X-Audio-Sample-Rate` and
`X-Audio-Channels`. Every response has `X-Request-Id`.

**SSE stream:**

```
event: chunk
data: {"type":"chunk","status_code":206,"done":false,"data":"<base64 audio>","step_time":0.0123}

event: done
data: {"type":"done","status_code":200,"done":true}
```

A stream that fails after audio started ends with an `error` event instead of
`done`:

```
event: error
data: {"type":"error","status_code":502,"message":"…","error_code":"stream_interrupted","retryable":true,"request_id":"req_…"}
```

A failure before the first chunk is an ordinary HTTP error response.

**Errors** (any non-200): a JSON body with `error_code`, `message`, `retryable`,
`request_id` (and `detail`; `required_inr`/`available_inr` on 402;
`concurrency_limit` on 429). The API gateway's own refusals (401 bad key, 404
unknown path, 413 body over 256 KB) have only `message` and `request_id`. The
code table is in `errors`.

## curl

```sh
# Voices (free)
curl -s https://hub.getraya.app/v1/voices -H "X-API-Key: $BAKBAK_API_KEY"

# A WAV file
curl -sS --fail-with-body https://hub.getraya.app/v1/text-to-speech \
  -H "X-API-Key: $BAKBAK_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"नमस्ते!","voice_id":"009ae8b5-4a03-492d-af1c-3055989ac734","language":"hi","model":"m1",
       "output_format":{"container":"wav","encoding":"pcm_s16le","sample_rate":24000}}' \
  -o hello.wav

# A stream of 8 kHz μ-law (-N: print events as they arrive)
curl -N https://hub.getraya.app/v1/text-to-speech/stream \
  -H "X-API-Key: $BAKBAK_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"नमस्ते!","voice_id":"009ae8b5-4a03-492d-af1c-3055989ac734","language":"hi","model":"m1",
       "output_format":{"container":"raw","encoding":"pcm_mulaw","sample_rate":8000}}'

# The WebSocket, interactively (https://github.com/vi/websocat)
websocat -H "X-API-Key: $BAKBAK_API_KEY" wss://hub.getraya.app/v1/text-to-speech/ws
```

## WebSocket protocol

1. Connect to `wss://hub.getraya.app/v1/text-to-speech/ws` with `X-API-Key`.
   A bad key is refused with HTTP 401 before the upgrade.
2. Send each request as one JSON text message: the request body plus an
   optional `context_id` (1 to 128 characters of `A-Z a-z 0-9 . _ -`).
3. Read messages. Each has `type`, `done`, and `context_id`/`request_id` when
   known: zero or more `chunk` (base64 `data`), then exactly one `done` or
   `error` per request.
4. Requests with the same `context_id` run one after another in the order sent;
   different contexts run at the same time and their messages interleave.
5. Cancel with `{"context_id":"…","cancel":true}`: the running request stops,
   queued ones are dropped, and exactly one `{"type":"cancelled","done":true}`
   arrives after everything the context sent before it. Discard the context's
   audio until then.

Limits per connection: 16 contexts generating at once, 64 unfinished requests,
256 KiB per message. The server pings every 30 s (keep reading so your library
answers), closes after 5 idle minutes (1000), and closes with 1001 when it
restarts, after finishing what it accepted.

WebSocket libraries: Go `github.com/coder/websocket` or `gorilla/websocket`;
Java `java.net.http.WebSocket` (built in, `.header("X-API-Key", key)`); C#
`System.Net.WebSockets.ClientWebSocket` (`Options.SetRequestHeader`); Rust
`tokio-tungstenite`; Ruby `async-websocket`; PHP `ratchet/pawl`; Dart
`dart:io` `WebSocket.connect(url, headers: …)`; Elixir `WebSockex` or `Mint.WebSocket`.

## Rules a robust client follows

The official clients do all of this; a hand-written one should too.

**Retries**
- Retry only before any audio: connection errors, timeouts, and errors whose
  `retryable` is true (if absent: 408, 429, 500, 502, 503, 504).
- **Never retry once audio has been delivered**, not after the first chunk of a
  stream nor the first byte of a file body: it was charged, and the listener
  would hear the start twice. Report the failure with its `request_id`.
- Wait `Retry-After` when present (seconds or an HTTP date, capped at 60 s),
  otherwise about 0.5 s, 1 s, 2 s with jitter. At most 2 retries.

**SSE parsing**
- Accept LF and CRLF; join multi-line `data:`; dispatch on a blank line; ignore
  comments (`:`), `id:` and `retry:`.
- The JSON `type` decides, not the `event:` name. Ignore unknown types.
- Decode each chunk's base64 once. One chunk can be large: allow lines up to
  16 MiB.
- A stream must end with `done` or `error`. If the body ends without either,
  the audio is incomplete: never treat it as success.
- 16-bit and 32-bit samples can straddle chunks; carry the leftover bytes over.

**WebSocket**
- Always be reading, from one reader that routes messages by `context_id`.
- On close 1001, reconnect at once and resend, in order, every request that had
  neither audio nor a final message.
- A 503 `error` whose `message` contains "Reconnect and send the request again"
  means the connection is draining: send new requests on a new connection, and
  resend the refused one there. Don't treat `error_code` `service_unavailable`
  alone as draining.
- Close 1008 or 1009 means your client broke a rule (sent without reading, or a
  message over 512 KiB): fail the unfinished requests.
- Any other drop: requests that had audio failed; resend the others on a new
  connection.

**Security**
- Never follow redirects (they would carry `X-API-Key` to another host).
- Never log the key or the text; never put the key in a URL outside browsers.

## A Go client (standard library)

Whole files with retries, and SSE streaming:

```go
package bakbak

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const BaseURL = "https://hub.getraya.app"

type OutputFormat struct {
	Container  string `json:"container"`
	Encoding   string `json:"encoding,omitempty"`
	SampleRate int    `json:"sample_rate,omitempty"`
}

type Request struct {
	Text         string        `json:"text"`
	VoiceID      string        `json:"voice_id"`
	Language     string        `json:"language"`
	Model        string        `json:"model,omitempty"`
	Speed        float64       `json:"speed,omitempty"`
	OutputFormat *OutputFormat `json:"output_format,omitempty"`
}

type APIError struct {
	Status     int    `json:"-"`
	ErrorCode  string `json:"error_code"`
	Message    string `json:"message"`
	Retryable  *bool  `json:"retryable"`
	RequestID  string `json:"request_id"`
	retryAfter time.Duration
}

func (e *APIError) Error() string {
	return fmt.Sprintf("bakbak: %d %s: %s (request %s)", e.Status, e.ErrorCode, e.Message, e.RequestID)
}

func (e *APIError) CanRetry() bool {
	if e.Retryable != nil {
		return *e.Retryable
	}
	switch e.Status {
	case 408, 429, 500, 502, 503, 504:
		return true
	}
	return false
}

var httpClient = &http.Client{
	// Never follow redirects: they would carry X-API-Key to another host.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// post sends one attempt and returns the response only for status 200.
func post(ctx context.Context, path string, body Request, accept string) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, BaseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", os.Getenv("BAKBAK_API_KEY"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", accept)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusOK {
		return resp, nil
	}
	defer resp.Body.Close()
	apiErr := &APIError{Status: resp.StatusCode, Message: resp.Status}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = json.Unmarshal(data, apiErr)
	if id := resp.Header.Get("X-Request-Id"); id != "" {
		apiErr.RequestID = id
	}
	if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
		apiErr.retryAfter = min(time.Duration(s)*time.Second, time.Minute)
	}
	return nil, apiErr
}

// withRetries retries an attempt that failed before any audio: network errors
// and retryable API errors, at most twice.
func withRetries(ctx context.Context, attempt func() (*http.Response, error)) (*http.Response, error) {
	for retry := 0; ; retry++ {
		resp, err := attempt()
		if err == nil || retry == 2 || ctx.Err() != nil {
			return resp, err
		}
		var apiErr *APIError
		wait := time.Duration(float64(500*time.Millisecond) * float64(int(1)<<retry) * (1 - 0.25*rand.Float64()))
		if errors.As(err, &apiErr) {
			if !apiErr.CanRetry() {
				return nil, err
			}
			if apiErr.retryAfter > 0 {
				wait = apiErr.retryAfter
			}
		}
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Generate returns a whole file. Once the body has started, a failure is not retried.
func Generate(ctx context.Context, r Request) ([]byte, error) {
	resp, err := withRetries(ctx, func() (*http.Response, error) {
		return post(ctx, "/v1/text-to-speech", r, "*/*")
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

type event struct {
	Type       string `json:"type"`
	Data       string `json:"data"`
	StatusCode int    `json:"status_code"`
	ErrorCode  string `json:"error_code"`
	Message    string `json:"message"`
	RequestID  string `json:"request_id"`
}

// Stream calls onAudio with each chunk of raw audio as it arrives.
func Stream(ctx context.Context, r Request, onAudio func([]byte) error) error {
	resp, err := withRetries(ctx, func() (*http.Response, error) {
		return post(ctx, "/v1/text-to-speech/stream", r, "text/event-stream")
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	requestID := resp.Header.Get("X-Request-Id")

	scanner := bufio.NewScanner(resp.Body) // strips "\r\n" and "\n"
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			continue
		}
		if line != "" || data.Len() == 0 {
			continue // comments, event:, id:, retry:
		}
		var ev event
		err := json.Unmarshal([]byte(data.String()), &ev)
		data.Reset()
		if err != nil {
			return fmt.Errorf("bakbak: bad event (request %s): %w", requestID, err)
		}
		switch ev.Type {
		case "chunk":
			audio, err := base64.StdEncoding.DecodeString(ev.Data)
			if err != nil {
				return fmt.Errorf("bakbak: bad audio (request %s): %w", requestID, err)
			}
			if err := onAudio(audio); err != nil {
				return err
			}
		case "done":
			return nil
		case "error": // after audio: never retry
			return &APIError{Status: ev.StatusCode, ErrorCode: ev.ErrorCode, Message: ev.Message, RequestID: requestID}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("bakbak: stream broken (request %s): %w", requestID, err)
	}
	return fmt.Errorf("bakbak: stream ended before it was complete (request %s)", requestID)
}
```

The same structure carries over to other languages: one HTTP client with
redirects off, a retry loop that stops at the first byte of audio, and an SSE
reader that insists on `done`.

See also: `client-behavior` (the full contract), `websocket-api`, `errors`,
`output-formats`, `best-practices`.
