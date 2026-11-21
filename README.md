# Bakbak MCP server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
[Bakbak](https://bakbak.getraya.app), the text-to-speech API by Raya. It lets Claude, Cursor,
VS Code, Windsurf and any other MCP client speak text in Hindi, other Indian languages and
English:

> "Read this paragraph aloud in Hindi with a calm female voice and save it as an MP3."

It runs two ways:

- **Local** (`npx bakbak-mcp`, stdio): audio is saved as files on your computer.
- **Hosted** (`https://mcp.bakbak.si/mcp`, streamable HTTP): nothing to install; audio comes
  back as a private download link. Sign in with OAuth (claude.ai connectors) or send your API
  key as a header.

Both offer the same two tools: [`text_to_speech`](#text_to_speech) and
[`list_voices`](#list_voices).

**Contents:** [Get an API key](#get-an-api-key) · [Set up your client](#set-up-your-client) ·
[Tools](#tools) · [Example prompts](#example-prompts) · [Configuration](#configuration) ·
[Errors](#errors) · [Retries and timeouts](#retries-and-timeouts) ·
[Latency tips](#latency-tips) · [Privacy](#privacy) · [Self-hosting](#self-hosting) ·
[Development](#development)

## Get an API key

Create a key in the [Bakbak dashboard](https://bakbak.getraya.app). Synthesis uses your Bakbak
credits for every character; listing voices is free.

## Set up your client

Local mode needs [Node.js](https://nodejs.org) 22 or newer (Claude Desktop's one-click
bundle includes what it needs). Replace `YOUR_BAKBAK_API_KEY` with your key.

### Claude Desktop

**One click:** download `bakbak-mcp-<version>.mcpb` from the
[latest release](https://github.com/raya-voice-ai/bakbak-mcp/releases/latest) and open it.
Claude Desktop asks for your API key and where to save audio (default `Documents/Bakbak`).

**Or by hand:** Settings → Developer → Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bakbak": {
      "command": "npx",
      "args": ["-y", "bakbak-mcp"],
      "env": { "BAKBAK_API_KEY": "YOUR_BAKBAK_API_KEY" }
    }
  }
}
```

### Claude Code

Local (audio files go to `~/Documents/Bakbak` unless you set `BAKBAK_MCP_OUTPUT_DIR`):

```sh
claude mcp add bakbak -e BAKBAK_API_KEY=YOUR_BAKBAK_API_KEY -- npx -y bakbak-mcp
```

Hosted, with your key as a header:

```sh
claude mcp add --transport http bakbak https://mcp.bakbak.si/mcp \
  --header "Authorization: Bearer YOUR_BAKBAK_API_KEY"
```

Or hosted without a header: run `claude mcp add --transport http bakbak
https://mcp.bakbak.si/mcp`, then `/mcp` in Claude Code to sign in with OAuth.

### claude.ai

1. Open **Settings → Connectors** and choose **Add custom connector**.
   (On Team and Enterprise plans an owner adds it for the organization.)
2. Name it `Bakbak` and enter the URL `https://mcp.bakbak.si/mcp`.
3. Click **Connect**. A Bakbak page opens: paste your API key and click **Connect**.

Audio comes back as a private link that works for one hour.

### Cursor

[Add Bakbak (local) to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=bakbak&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImJha2Jhay1tY3AiXSwiZW52Ijp7IkJBS0JBS19BUElfS0VZIjoiWU9VUl9CQUtCQUtfQVBJX0tFWSJ9fQ==)
· [Add Bakbak (hosted) to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=bakbak&config=eyJ1cmwiOiJodHRwczovL21jcC5iYWtiYWsuc2kvbWNwIiwiaGVhZGVycyI6eyJBdXRob3JpemF0aW9uIjoiQmVhcmVyIFlPVVJfQkFLQkFLX0FQSV9LRVkifX0=)

Then replace `YOUR_BAKBAK_API_KEY` in Cursor's MCP settings. Or add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bakbak": {
      "command": "npx",
      "args": ["-y", "bakbak-mcp"],
      "env": { "BAKBAK_API_KEY": "YOUR_BAKBAK_API_KEY" }
    }
  }
}
```

For the hosted server use `{ "url": "https://mcp.bakbak.si/mcp", "headers": { "Authorization":
"Bearer YOUR_BAKBAK_API_KEY" } }` as the server entry.

### VS Code

Add `.vscode/mcp.json` to your workspace. VS Code prompts for the key once and stores it
securely:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "bakbak-api-key",
      "description": "Bakbak API key",
      "password": true
    }
  ],
  "servers": {
    "bakbak": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "bakbak-mcp"],
      "env": { "BAKBAK_API_KEY": "${input:bakbak-api-key}" }
    }
  }
}
```

For the hosted server, use this server entry instead (or omit `headers` to sign in with
OAuth):

```json
"bakbak": {
  "type": "http",
  "url": "https://mcp.bakbak.si/mcp",
  "headers": { "Authorization": "Bearer ${input:bakbak-api-key}" }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "bakbak": {
      "command": "npx",
      "args": ["-y", "bakbak-mcp"],
      "env": { "BAKBAK_API_KEY": "YOUR_BAKBAK_API_KEY" }
    }
  }
}
```

Hosted: `{ "serverUrl": "https://mcp.bakbak.si/mcp", "headers": { "Authorization": "Bearer
YOUR_BAKBAK_API_KEY" } }`.

### Any other client

- Local: run `npx -y bakbak-mcp` over stdio with `BAKBAK_API_KEY` in its environment.
- Hosted: connect to `https://mcp.bakbak.si/mcp` (streamable HTTP, protocol revisions
  2026-07-28 and 2025-era) with `Authorization: Bearer <key>`, `X-API-Key: <key>`, or OAuth 2.1
  (discovery via `/.well-known/oauth-protected-resource/mcp`, dynamic client registration or
  client ID metadata documents, PKCE S256). OAuth redirect URIs must be `https`, or `http` on a
  loopback address.

## Tools

Parameter names are the Bakbak API's own (`voice_id`, `output_format`, …), so prompts, code and
`curl` read the same. Unknown parameters are refused; there is never a parameter for an API key.

### `text_to_speech`

Converts text to speech and saves it (local) or returns a link (hosted). Uses credits.

| Parameter       | Type    | Default                                                          | Description                                                                                                                                                                                             |
| --------------- | ------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`          | string  | required                                                         | The text, up to 50,000 characters. Hindi must be in Devanagari script.                                                                                                                                  |
| `language`      | string  | required                                                         | `hi`, `mr`, `te`, `kn`, `bn`, `as`, `gu`, `ne`, `ml`, `ta`, `pa`, `en`, `en-in` or `en-us` (and any language the API adds). English m1 voices use `en`; standard English voices use `en-in` or `en-us`. |
| `voice_id`      | string  | first voice for the language                                     | A voice id from `list_voices`.                                                                                                                                                                          |
| `model`         | string  | the voice's model                                                | `standard` or `m1`. Must be the voice's own model.                                                                                                                                                      |
| `speed`         | number  | `1.0`                                                            | Speaking rate, 0.5 to 1.5.                                                                                                                                                                              |
| `output_format` | object  | `{"container":"wav","encoding":"pcm_s16le","sample_rate":24000}` | `container` `wav`, `mp3` or `raw`; `encoding` `pcm_s16le`, `pcm_f32le`, `pcm_mulaw` or `pcm_alaw` (required for wav and raw, omitted for mp3); `sample_rate` 8000, 16000, 22050 or 24000.               |
| `output_path`   | string  | a new file                                                       | Local mode only. An absolute path, or one relative to the output directory (and inside it). Its directory must exist and its extension must match the format.                                           |
| `overwrite`     | boolean | `false`                                                          | Local mode only. Replace `output_path` if it exists; otherwise an existing file is never touched.                                                                                                       |
| `include_audio` | boolean | `false`                                                          | Also return the audio inline as an MCP audio block, for audio up to 1 MB (about 20 s of the default WAV). Larger audio is still saved, and the call explains the limit.                                 |

It returns `structuredContent` (and the same JSON as text, after a one-line summary):

| Field                           | Description                                                          |
| ------------------------------- | -------------------------------------------------------------------- |
| `file_path`                     | Local: absolute path of the new file.                                |
| `audio_url`, `expires_at`       | Hosted: private download link and when it stops working (one hour).  |
| `format`                        | `container`, `encoding`, `sample_rate` and `mime_type` of the audio. |
| `duration_seconds`              | Length of the audio, measured from the bytes.                        |
| `characters`                    | Characters synthesized (Unicode code points).                        |
| `voice_id`, `model`, `language` | What was used.                                                       |
| `request_ids`                   | Bakbak request ids, for support.                                     |

Generated files are named `<language>_<voice>_<UTC time>_<random>.<ext>`, for example
`hi_Kavya_20261121T143205Z_k3x9q2.wav`, with the extension of the real format: `.wav`, `.mp3`,
or for raw audio `.pcm` (16-bit), `.f32`, `.ulaw` or `.alaw`.

**Long text.** One API request takes up to 5,000 characters. Longer text is split at sentence
boundaries with the Bakbak SDK's segmenter and the pieces become one file: WAV and raw audio
stream every piece over one WebSocket and join the samples under a single WAV header; MP3 makes
one request per piece and joins the frames. Clients that send a progress token get a progress
notification per piece.

### `list_voices`

Lists voices. Free. Read-only.

| Parameter  | Type    | Default | Description                                                   |
| ---------- | ------- | ------- | ------------------------------------------------------------- |
| `language` | string  | all     | Only voices for this language, e.g. `hi`.                     |
| `model`    | string  | all     | Only voices of this model: `standard` or `m1`.                |
| `query`    | string  | none    | Only voices whose name contains this text (case-insensitive). |
| `limit`    | integer | `50`    | Most voices to return (1–500).                                |

Returns `{ "voices": [{ "id", "name", "language", "model" }], "count", "total" }`, where
`total` counts every match before the limit.

## Example prompts

- "List the Hindi voices."
- "Say 'आपका ऑर्डर कल तक पहुँच जाएगा।' in Hindi with an m1 voice."
- "Turn this blog post into an MP3 narration, a little slower than normal." (long text is fine)
- "Make an 8 kHz μ-law version of this IVR greeting in Tamil for our phone system:
  `output_format` raw, `pcm_mulaw`, 8000."
- "Welcome राहुल शर्मा to the meetup in English and save it to `~/Desktop/welcome.wav`."

The server tells the model to pick a voice with `list_voices`, to pass the voice's own model,
to write Hindi in Devanagari, and that synthesis costs credits.

## Configuration

Configuration is by environment variable only.

### Local mode

| Variable                | Default                                                         | Meaning                                                                                                       |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `BAKBAK_API_KEY`        | none                                                            | Your API key. Without it the server still starts and lists its tools; every call explains how to set the key. |
| `BAKBAK_BASE_URL`       | `https://hub.getraya.app`                                       | API base URL, for example a staging deployment.                                                               |
| `BAKBAK_MCP_OUTPUT_DIR` | `~/Documents/Bakbak` (or `~/Bakbak` if there is no `Documents`) | Where new audio files go. Created when needed; `~` is expanded.                                               |
| `LOG_LEVEL`             | `info`                                                          | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr; stdout carries only the protocol.          |

### Hosted mode (`bakbak-mcp --http`)

| Variable           | Default                     | Meaning                                                                                                                                                              |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_PUBLIC_URL`   | required                    | Public origin, e.g. `https://mcp.bakbak.si`. Every advertised URL is built from it, never from the `Host` header.                                                    |
| `MCP_TOKEN_SECRET` | required                    | Secret for sealing OAuth tokens: at least 32 characters (`openssl rand -base64 48`). Rotate with `new_kid:new_secret,old_kid:old_secret`: the first seals, all open. |
| `BAKBAK_BASE_URL`  | `https://hub.getraya.app`   | API base URL.                                                                                                                                                        |
| `AUDIO_DIR`        | `<tmp>/bakbak-mcp-audio`    | Where audio is kept until it expires.                                                                                                                                |
| `AUDIO_TTL`        | `1h`                        | How long audio links work: seconds, or `90s`, `30m`, `1h`.                                                                                                           |
| `AUDIO_MAX_BYTES`  | `2G`                        | Cap on stored audio; the oldest files go first. Bytes, or `512M`, `2G`.                                                                                              |
| `PORT`             | `8080`                      | Listening port.                                                                                                                                                      |
| `HOST`             | `0.0.0.0`                   | Listening address.                                                                                                                                                   |
| `TRUSTED_PROXIES`  | loopback and private ranges | CIDRs of reverse proxies whose `CF-Connecting-IP` / `X-Forwarded-For` are believed (for per-address rate limits). Empty trusts none.                                 |
| `LOG_LEVEL`        | `info`                      | As above.                                                                                                                                                            |

## Errors

Every failure is a tool result with `isError: true`, never a protocol error, so the model can
read it and act. The first text block is a sentence plus one next step; the second is JSON:

```json
{
  "error": {
    "message": "Your balance is too low for this request.",
    "next_step": "The account is out of credits. Add credits at https://bakbak.getraya.app, then try again.",
    "status": 402,
    "error_code": "insufficient_credits",
    "request_id": "req_…",
    "retryable": false
  }
}
```

`message`, `error_code` and `request_id` come from the API unchanged. Invalid arguments
(including an unknown parameter) are reported the same way. A missing key names
`BAKBAK_API_KEY` and the dashboard. In hosted mode, a request without valid credentials gets
HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, which starts the client's
OAuth flow.

## Retries and timeouts

The server uses the [Bakbak JS SDK](https://github.com/raya-voice-ai/bakbak-js), which retries
connection failures, timeouts and retryable statuses (429, 5xx) up to twice with backoff, and
honours `Retry-After`. It never retries once audio has started: that audio is billed, and a
retry would bill it again. The read timeout is 60 s between bytes. Errors say whether retrying
can help (`retryable`).

In hosted mode, responses are streamed with a keep-alive comment every 15 s, so proxies do not
cut long calls. Some clients stop waiting for a tool after a few minutes (claude.ai after about
four); for very long texts, use local mode or split the text across calls.

## Latency tips

- Local mode opens the API connection and caches the voice list at startup, so the first call
  pays no handshake.
- Pass `voice_id` and `model` together to skip the voice lookup entirely.
- Shorter text answers sooner: the server makes one request per 5,000 characters.
- Lower sample rates and `mp3` make smaller files, which matters for `include_audio` and
  downloads.

## Privacy

- **Local mode** sends text only to the Bakbak API you configured. Audio stays on your computer.
  Nothing else is contacted: no telemetry, no update checks.
- **Hosted mode** (`mcp.bakbak.si`) keeps no database:
  - Your API key is checked with Bakbak and then exists only inside encrypted tokens (AES-256-GCM)
    held by your MCP client. Access tokens last one hour, refresh tokens 30 days. Deleting the
    key in the dashboard ends every connection that uses it.
  - Generated audio is stored on the server's disk for one hour under an unguessable link, then
    deleted. Anyone with the link can download it until then.
  - Text is sent to the Bakbak API and is not stored or logged by this server. Logs record
    request ids, sizes, timings, the caller's IP address and a one-way fingerprint of the key.

## Self-hosting

`bakbak-mcp --http` runs the hosted server. The [`deploy/`](deploy/README.md) directory has a
Dockerfile-based compose file, a Caddy example and the operational notes (reverse proxies,
Cloudflare, scaling, secret rotation).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Raya Voice AI.
