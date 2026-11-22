---
id: errors
title: Errors and error codes
description: Every error_code with its HTTP status, when it happens, whether to retry and what to do; error body examples; gateway errors.
url: https://docs.bakbak.si/text-to-speech/errors
---

# Errors

What a failed text-to-speech request returns, how to tell failures apart, and which ones to retry.

This page covers errors from `POST /v1/text-to-speech`,
`POST /v1/text-to-speech/stream` and the [WebSocket](https://docs.bakbak.si/text-to-speech/websocket).

> **Tip:** The official [Python](https://docs.bakbak.si/sdks/python) and [JavaScript](https://docs.bakbak.si/sdks/javascript)
> SDKs turn every error below into a typed exception and retry the retryable ones for you.

## Every error tells you four things

| Key | Type | Meaning |
|---|---|---|
| `error_code` | string | What went wrong, from the list below. **Branch on this.** |
| `message` | string | A specific sentence for a person: which field, which model, what to do. Safe to show and to log. |
| `retryable` | boolean | `true` if sending the same request again, unchanged, can succeed. |
| `request_id` | string | The request's id, also in the `X-Request-Id` header. Quote it to support. |

The body also keeps older keys (`detail`, and `error` on a 402 or 429) so
existing integrations keep working. New code should read `error_code` and
`message`.

## Error codes

| `error_code` | HTTP | When | Retry? | What to do |
|---|---|---|---|---|
| `invalid_request` | 422, 400 | A field is missing or wrong, the body is not JSON, or the text is empty. | No | Fix the request. `message` names every bad field; a 422 also lists them in `detail`. |
| `request_too_large` | 413 | The body is over 256 KiB, or the text is over 5,000 characters. | No | Send less text per request. |
| `model_not_found` | 400 | `model` is not a model we offer. | No | Use one of the models `message` lists. |
| `voice_not_found` | 404 | `voice_id` does not exist for the model. | No | Pick a voice from `GET /v1/voices` with the matching model. |
| `invalid_account` | 403 | The API key is not linked to an active billing account. | No | A new account can take up to a minute to appear; otherwise contact support. |
| `insufficient_credits` | 402 | The balance does not cover this request. | No | Top up. `required_inr` and `available_inr` give the amounts. |
| `concurrency_limit_exceeded` | 429 | Your account already has as many requests in progress as its plan allows. | Yes | Wait for `Retry-After` (1 s) or for one of your requests to finish. |
| `capacity_exhausted` | 503 | Every server for the model is busy. | Yes | Retry after `Retry-After`, with backoff. |
| `model_unavailable` | 503 | No server for the model is healthy right now. | Yes | Retry after a few seconds, with backoff. |
| `model_timeout` | 504 | The model did not produce audio in time. | Yes | Retry. |
| `model_error` | 502 | The model failed while generating audio. | Yes | Retry. |
| `stream_interrupted` | 200, then an `error` event | A stream that had already sent audio stopped before it finished. | Yes | Request the text again. The interrupted request is charged. |
| `service_unavailable` | 503 | The service is restarting or cannot check balances right now. | Yes | Retry shortly. |
| `internal_error` | 500 | A fault inside the service. | Yes | Retry; if it keeps failing, contact support with `request_id`. |

The list only grows: a code is never renamed, removed or given a new meaning.
Treat a code you don't recognise by its HTTP status.

## Retrying

- Retry only when `retryable` is `true`. Every 4xx except 429 needs the request changed first.
- Honour `Retry-After` when present. Otherwise back off exponentially from about 0.5 s and give up after a few attempts.
- **Never retry a stream after you have received audio.** It was charged, and the
  retry would play the start again. A request that fails before any audio is not charged.

## Examples

A request with bad fields (422) lists every problem at once:

```json
{
  "detail": [
    {"type": "missing", "loc": ["body", "voice_id"], "msg": "Field required"},
    {"type": "value_error", "loc": ["body", "output_format", "encoding"], "msg": "Value error, encoding must be one of: pcm_f32le, pcm_s16le, pcm_mulaw, pcm_alaw", "input": "mulaw", "ctx": {"error": {}}}
  ],
  "error_code": "invalid_request",
  "message": "Invalid request: voice_id: Field required; output_format.encoding: encoding must be one of: pcm_f32le, pcm_s16le, pcm_mulaw, pcm_alaw.",
  "retryable": false,
  "request_id": "req_0071415897e5d4ac1c0f8576c827a723"
}
```

Insufficient credits (402):

```json
{
  "error": "Insufficient credits",
  "message": "The billing account has insufficient balance.",
  "error_code": "insufficient_credits",
  "required_inr": 1.56,
  "available_inr": 0.0005,
  "retryable": false,
  "request_id": "req_432fb998ac8d85101424c94f1c79499f"
}
```

Too many concurrent requests (429, with `Retry-After: 1`):

```json
{
  "error": "Too many concurrent requests",
  "error_code": "concurrency_limit_exceeded",
  "message": "This account allows 2 concurrent requests and 2 are in progress. Retry when one of them finishes, or contact support to raise the limit.",
  "concurrency_limit": 2,
  "retryable": true,
  "request_id": "req_52276699f92dfd6939e0f242511ef602"
}
```

A stream that fails after audio has started can't change its status any more,
so the failure is the stream's last event:

```text
event: error
data: {"type":"error","status_code":502,"message":"The audio stream ended before it was complete.","error_code":"stream_interrupted","retryable":true,"request_id":"req_5a5714bd13aaac71ac49b31ceddc77e5"}
```

A stream that ends with neither a `done` nor an `error` event did not complete.

## Errors from the API gateway

A few requests are refused before they reach the speech service. Their body has
only `message` and the gateway's own `request_id`:

| HTTP | `message` | Cause |
|---|---|---|
| 401 | `No API key found in request` | No `X-API-Key` header. |
| 401 | `Unauthorized` | The API key is not valid. |
| 413 | `Request size limit exceeded` | The body is over 256 KB. |
| 404 | `no Route matched with those values` | Wrong path, or the wrong method on a speech path. |
