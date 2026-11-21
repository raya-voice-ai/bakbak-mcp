# Deploying the hosted server

`bakbak-mcp --http` is the hosted MCP server at `https://mcp.bakbak.si/mcp`. It is one
stateless Node process: OAuth codes and tokens are sealed with `MCP_TOKEN_SECRET`, so nothing
but generated audio (kept for an hour) lives on disk.

Files here:

| File                                     | Purpose                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`../Dockerfile`](../Dockerfile)         | Node 24 slim image, non-root, a single bundled `server.mjs`, health check on `/healthz`.               |
| [`compose.yaml`](compose.yaml)           | The `bakbak-mcp` container on the external Docker network `bakbak-kong_public`, behind the edge Caddy. |
| [`.env.example`](.env.example)           | Template for `deploy/.env` (secrets; never committed).                                                 |
| [`Caddyfile.example`](Caddyfile.example) | A standalone Caddy site for other hosts, where Caddy terminates TLS itself.                            |

## Build and run

```sh
cd deploy
cp .env.example .env
openssl rand -base64 48        # paste as MCP_TOKEN_SECRET in .env
docker compose up -d --build
docker compose logs -f bakbak-mcp
```

While `package.json` depends on a local SDK checkout (`"bakbak": "file:../bakbak-js"`), the
build needs `../bakbak-js` next to this repository; compose passes it as the `bakbak-js` build
context. Without compose:

```sh
docker build --build-context bakbak-js=../bakbak-js -t bakbak-mcp .
```

Once the dependency is the published `bakbak` package, drop `additional_contexts` from
`compose.yaml` and the `--build-context` flag.

The container listens on 8080 (exposed only to the Docker network), keeps audio in the `audio`
volume at `/data/audio`, runs with a read-only root file system, no capabilities, and as the
`node` user.

## Environment

| Variable                  | Value here                             | Notes                                                                                       |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `MCP_PUBLIC_URL`          | `https://mcp.bakbak.si`                | Every advertised URL (OAuth metadata, audio links) is built from it, never from `Host`.     |
| `MCP_TOKEN_SECRET`        | from `.env`                            | At least 32 characters. See rotation below.                                                 |
| `BAKBAK_BASE_URL`         | `https://hub.getraya.app`              | The API the tools call.                                                                     |
| `AUDIO_DIR`               | `/data/audio`                          | A volume.                                                                                   |
| `AUDIO_TTL`               | `1h`                                   | Audio links stop working after this.                                                        |
| `AUDIO_MAX_BYTES`         | `2G`                                   | Oldest audio is deleted first beyond this.                                                  |
| `AUDIO_MAX_BYTES_PER_KEY` | unset (a quarter of `AUDIO_MAX_BYTES`) | Per-key share of stored audio.                                                              |
| `MAX_OUTPUT_BYTES`        | unset (`512M`)                         | Largest estimated audio of one call.                                                        |
| `TTS_CONCURRENCY_PER_KEY` | unset (`2`)                            | Calls running at once per key.                                                              |
| `INFLIGHT_AUDIO_BYTES`    | unset (`1G`)                           | Estimated audio being produced at once.                                                     |
| `PORT`                    | `8080`                                 |                                                                                             |
| `TRUSTED_PROXIES`         | unset                                  | Default: loopback and private ranges, which include the Docker network Caddy connects from. |
| `LOG_LEVEL`               | `info`                                 |                                                                                             |

## Edge proxy (Caddy in Docker)

The edge Caddy imports `/etc/caddy/sites.d/*.caddy`. A site for this server:

```caddyfile
mcp.bakbak.si {
	import security_headers
	log {
		output stdout
		format filter {
			request>headers>Authorization delete
			request>headers>X-Api-Key delete
			request>headers>Cookie delete
			request>headers>Cf-Connecting-Ip delete
			wrap json
		}
	}
	# Believe CF-Connecting-IP only from Cloudflare's addresses
	# (https://www.cloudflare.com/ips/, checked 2026-11-21), so a client that
	# reaches this host directly cannot pick its own rate-limit bucket.
	@not_cloudflare not remote_ip 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
	request_header @not_cloudflare -CF-Connecting-IP
	request_body {
		max_size 1MB
	}
	reverse_proxy bakbak-mcp:8080 {
		flush_interval -1
	}
}
```

Requirements for any proxy in front of the server:

- **No buffering.** MCP responses are Server-Sent Events; `flush_interval -1` passes them
  through as they are written.
- **Forward `Authorization`, `X-API-Key` and `Cookie` unchanged**, but keep them out of access
  logs (the filter above).
- **Route every path to the container:** `/mcp`, `/.well-known/*`, `/register`, `/authorize`,
  `/token`, `/audio/*` and `/healthz`.
- **No response timeout shorter than the longest tool call.** Caddy has none by default.
- The server sends its own `Content-Security-Policy` on `/authorize`, whose `form-action`
  allows the redirect back to the client. A proxy-wide CSP with a stricter `form-action` would
  stop the consent form from completing.

## Cloudflare

`mcp.bakbak.si` is proxied by Cloudflare, which terminates TLS and forwards to the edge Caddy.

- **Bot protection must not touch the server's machine-to-machine paths.** claude.ai calls
  `/mcp`, `/.well-known/*`, `/register` and `/token` from its servers, and clients download
  `/audio/*` without a browser. Exclude these paths (and `/authorize`, which loads inside the
  client's sign-in window) from Bot Fight Mode, Super Bot Fight Mode, managed challenges,
  JavaScript challenges and "I'm Under Attack" mode, for example with a WAF skip rule on
  `http.host eq "mcp.bakbak.si"`. A challenge page on any of them breaks connecting.
- **Idle timeout.** Cloudflare closes a proxied request that sends nothing for about 100 s. The
  server streams every MCP response and writes an SSE keep-alive comment every 15 s, so long
  `text_to_speech` calls stay open. Tool calls are still bounded by clients (claude.ai waits
  about four minutes). Long-lived `GET` SSE streams are not used (the server answers `GET /mcp`
  with 405).
- **Caching.** Responses carry `Cache-Control: no-store` (audio: `private, no-store`). Do not
  add Cache Rules that override origin cache headers on this host.
- **Client addresses.** Per-address rate limits (`/register`, `POST /authorize`) use
  `CF-Connecting-IP`, then `X-Forwarded-For`, only when the direct peer is in
  `TRUSTED_PROXIES`. If the origin is reachable without going through Cloudflare, anyone can
  send a forged `CF-Connecting-IP` through the edge proxy: allow only
  [Cloudflare's addresses](https://www.cloudflare.com/ips/) to reach the origin, or strip the
  header from other peers at the edge (as `Caddyfile.example` does).
- SSL/TLS mode **Full (strict)**.

## Operations

- **Health:** `GET /healthz` returns `{"status":"ok","version":"…"}`; the image's health check
  uses it.
- **Logs:** JSON lines on stderr. Each request logs method, path (audio ids replaced by
  `<id>`), status, duration and client address; tool calls log character counts, piece counts,
  byte sizes, request ids and a one-way key fingerprint. Never text, keys or tokens.
- **Rate limits** (per instance; an IPv6 "address" here is its /64): `POST /register` 20 per
  minute per address, `POST /authorize` 10 per minute per address, `GET /authorize` with an
  unregistered (metadata document) client 30 per minute per address, API-key checks of
  not-yet-known keys at `/mcp` 20 per minute per address (bursts of 10; a wrong key is then
  refused for a minute without asking Bakbak), and 60 tool calls per minute per API key (bursts
  of 30).
- **Resource limits:** each call's audio is streamed to disk, so memory stays small whatever the
  text length. `text_to_speech` is refused up front when its estimated audio exceeds
  `MAX_OUTPUT_BYTES` (512 MB), when the key already has `TTS_CONCURRENCY_PER_KEY` (2) calls
  running, or when the calls in progress would exceed `INFLIGHT_AUDIO_BYTES` (1 GB). Stored
  audio is capped at `AUDIO_MAX_BYTES` overall and `AUDIO_MAX_BYTES_PER_KEY` per key. The
  compose file also caps the container at 1 GB of memory and 256 processes.
- **Rotating `MCP_TOKEN_SECRET`:** set `MCP_TOKEN_SECRET=k2:<new>,k1:<old>` and restart. New
  tokens are sealed with `k2`; tokens sealed with `k1` keep working. After 30 days (the
  refresh-token lifetime), remove `k1:<old>`. Removing a secret immediately signs every client
  out of connections sealed with it (they reconnect through OAuth). A bare secret's key id is
  derived from the secret, so `<new>,<old>` without ids also works.
- **Scaling out:** OAuth is stateless, so any instance verifies tokens from any other. Two
  things are per instance: rate limits, and the in-memory record of redeemed authorization
  codes (PKCE still binds a code to its client). Audio is on local disk: either share
  `AUDIO_DIR` between instances (the size cap is then enforced per instance) or route
  `/audio/*` to the instance that created it.
- **Refresh tokens are not single-use.** Each refresh returns a new refresh token, but with
  no server state the old one stays valid until it expires (30 days). Ending access is done
  by deleting the API key or rotating `MCP_TOKEN_SECRET`.
- **Revoking a user:** deleting their API key in the Bakbak dashboard ends every connection
  that uses it; refresh fails with `invalid_grant` and tool calls report the rejected key.
