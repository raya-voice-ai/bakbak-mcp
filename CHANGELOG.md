# Changelog

All notable changes to this project are documented here. Releases are made by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org).

## [1.0.0-rc.3](https://github.com/raya-voice-ai/bakbak-mcp/compare/v1.0.0-rc.2...v1.0.0-rc.3) (2026-11-22)


### Features

* bundle Bakbak's developer documentation for coding assistants: search_docs and read_docs tools, bakbak://docs/ resources, and the integrate_bakbak, review_bakbak_integration and choose_voice prompts ([2e07cfc](https://github.com/raya-voice-ai/bakbak-mcp/commit/2e07cfce46f838715f7e2a8c02c5fa9b33c07081))

## [1.0.0-rc.2](https://github.com/raya-voice-ai/bakbak-mcp/compare/v1.0.0-rc.1...v1.0.0-rc.2) (2026-11-22)


### Features

* audio formats and long-text assembly behind a small backend interface ([f5a3dd4](https://github.com/raya-voice-ai/bakbak-mcp/commit/f5a3dd44b031109a901551375a4327f060ff5f3f))
* backend on the official bakbak JS SDK ([fbd9e9f](https://github.com/raya-voice-ai/bakbak-mcp/commit/fbd9e9fb67c6bc886e0e089d06a28716d54eba84))
* bakbak-mcp command for stdio and --http ([732d100](https://github.com/raya-voice-ai/bakbak-mcp/commit/732d100c43ea996e9731c26b3e01f69daa1bf262))
* Claude Desktop bundle (MCPB) ([51856a0](https://github.com/raya-voice-ai/bakbak-mcp/commit/51856a0e8bcfdca839124bcae940fac3707a0ee2))
* container image and deployment files ([5eeb4dc](https://github.com/raya-voice-ai/bakbak-mcp/commit/5eeb4dc1557a1c66572fbfff2a6e71277a620a9e))
* hosted mode with stateless streamable HTTP and OAuth ([c3b84cf](https://github.com/raya-voice-ai/bakbak-mcp/commit/c3b84cf74ceeef83799f8ac35d7ef2ad1a40b90a))
* MCP Registry entry (server.json) ([4e230ac](https://github.com/raya-voice-ai/bakbak-mcp/commit/4e230ac8ace65037ef64bcbff65e6b48fe31e0d5))
* programmatic API for embedding the server ([cfc3789](https://github.com/raya-voice-ai/bakbak-mcp/commit/cfc3789dac62544c61513bb0ccaade34d63f564e))
* say in the tool description where the audio goes ([0ff1862](https://github.com/raya-voice-ai/bakbak-mcp/commit/0ff18629d3f6d89849361abf71111b08f5705e63))
* text_to_speech and list_voices tools with local file output ([5a96070](https://github.com/raya-voice-ai/bakbak-mcp/commit/5a96070b9d2b37ce85f6985afad3010a1ee2c6fb))


### Bug Fixes

* allow the headers a browser client asks for in CORS preflights ([a4b0678](https://github.com/raya-voice-ai/bakbak-mcp/commit/a4b067806a71df250ec7c337737861a56cd29eff))
* keep audio ids out of request logs ([23e256a](https://github.com/raya-voice-ai/bakbak-mcp/commit/23e256a88f0bb9f4777df602330d7b086d1000f0))
* require an encoding for wav and raw, and mark local synthesis destructive ([d14d32c](https://github.com/raya-voice-ai/bakbak-mcp/commit/d14d32cd8a66f67ac12995dc77e5de540b2db5dd))
* tell the model that speed changes standard voices only ([376a04e](https://github.com/raya-voice-ai/bakbak-mcp/commit/376a04eb423f68cb8c9ab9be01ca5f7373e57335))
* treat a cancelled call as cancelled, not as an unexpected error ([2acfccd](https://github.com/raya-voice-ai/bakbak-mcp/commit/2acfccd41ebcf5aeb344161299b388cf1581b5a0))
* treat keys the SDK refuses to send as invalid, not as an outage ([403d8c0](https://github.com/raya-voice-ai/bakbak-mcp/commit/403d8c0bf664c0ab074df945ade2e3ed0db5c676))

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
