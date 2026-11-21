# Changelog

All notable changes to this project are documented here. Releases are made by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org).

## 1.0.0-rc.1

First release candidate of the official Bakbak MCP server.

### Features

- `text_to_speech` and `list_voices` tools, with the Bakbak API's parameter names, open
  enumerations, structured output and `isError` results that carry the API's message,
  `error_code` and `request_id` plus a next step.
- Text up to 50,000 characters: longer than one request, it is split at sentence boundaries
  with the SDK's segmenter and joined into one file (one WebSocket context for WAV and raw,
  one request per piece for MP3).
- Local mode over stdio (`npx bakbak-mcp`): audio files in `~/Documents/Bakbak`, safe
  `output_path` handling, optional inline audio up to 1 MB.
- Hosted mode (`bakbak-mcp --http`): stateless streamable HTTP for 2026-07-28 and 2025-era
  clients, API keys as headers, and a built-in OAuth 2.1 authorization server (dynamic client
  registration, client ID metadata documents, PKCE S256, refresh) for claude.ai custom
  connectors; audio links valid for one hour.
- Claude Desktop bundle (MCPB), MCP Registry entry, container image and deployment files.
