# Contributing

Thanks for helping improve the Bakbak MCP server. Changes are welcome as pull requests.

## Development setup

You need Node.js 22 or newer (24 recommended) and npm.

```sh
git clone https://github.com/raya-voice-ai/bakbak-mcp
cd bakbak-mcp
npm ci
npm run build
```

Useful scripts:

| Command                     | What it does                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `npm test`                  | Unit and integration tests (Vitest) against a local mock of the Bakbak API. No network. |
| `npm run test:live`         | Live tests against a real deployment; see below.                                        |
| `npm run lint`              | ESLint (strict, type-aware) and Prettier. `npm run format` fixes formatting.            |
| `npm run typecheck`         | TypeScript, including the tests.                                                        |
| `npm run build`             | Compiles `src/` to `dist/`.                                                             |
| `npm run bundle:mcpb`       | Builds and validates the Claude Desktop bundle, `bakbak-mcp-<version>.mcpb`.            |
| `npm run conformance:check` | Verifies `conformance/` against its manifest.                                           |

Run the server from a checkout:

```sh
BAKBAK_API_KEY=... node dist/cli.js                 # stdio
MCP_PUBLIC_URL=http://127.0.0.1:8080 MCP_TOKEN_SECRET=$(openssl rand -base64 48) \
  BAKBAK_API_KEY=... node dist/cli.js --http        # hosted, on port 8080
```

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) works with both.

## The SDK dependency

This server is built on the official [`bakbak`](https://github.com/raya-voice-ai/bakbak-js)
JS SDK. During development before the SDK's first release, `package.json` points at a sibling
checkout:

```json
"bakbak": "file:../bakbak-js"
```

Clone `bakbak-js` next to this repository and run `npm ci && npm run build` there first. CI
does the same automatically while the dependency is a `file:` link, and the publish workflow
refuses to release with one.

**Before the first release**, switch to the published SDK:

```sh
npm install --save bakbak@^1.0.0-rc.1
```

Commit `package.json` and `package-lock.json`, then remove `additional_contexts` from
`deploy/compose.yaml` (the Dockerfile needs no build context once the dependency comes from
npm).

## Tests

- `test/unit/`: pure modules (audio formats, files, OAuth pieces, sealing, rate limits, the
  audio store, configuration, release metadata and the conformance manifest).
- `test/integration/`: the tools through an in-memory MCP client against a mock Bakbak API
  (`test/helpers/mockApi.ts`: `node:http` plus a `ws` server); hosted mode end to end with a
  scripted client that does what claude.ai does (discovery, registration, the consent form,
  tokens, both protocol eras, refresh and the failure cases); the bundled server over stdio;
  SSE keep-alives; and a snapshot of the tool schemas plus a check that the README's tool
  reference matches them. Update the snapshot with `npx vitest run -u` when you change a
  schema on purpose, and update the README in the same commit.
- `test/live/`: real calls, serially. They read `BAKBAK_API_KEY` and `BAKBAK_BASE_URL` and
  are skipped when either is unset. They spend credits; keep them small.

The sentence segmenter is the SDK's, so its vectors are tested there; this repository only
checks that its copy of `conformance/` matches the manifest.

## Conformance

`conformance/` is a synced copy of the shared behaviour spec (`BEHAVIOR.md`) and fixtures used
by every official Bakbak client. **Never edit it here.** Changes are made in the canonical copy
and synced to all four repositories; CI checks `MANIFEST.sha256`, and a weekly job warns when
the other repositories' manifests differ. Commit a sync as `chore: sync conformance`.

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
`test:`, `ci:`, `chore:`. `feat` and `fix` appear in the changelog.

Releases are automated:

1. [release-please](https://github.com/googleapis/release-please) keeps a release pull request
   open on `main`, bumping `package.json`, `src/version.ts`, `manifest.json` and `server.json`
   together and updating `CHANGELOG.md`.
2. Merging it tags the release and publishes a GitHub release.
3. The publish workflow then publishes to npm with provenance via trusted publishing (OIDC,
   prereleases under the `next` tag), attaches the `.mcpb` bundle to the release, and publishes
   `server.json` to the MCP Registry with `mcp-publisher` (GitHub OIDC, namespace
   `io.github.raya-voice-ai`).

Versions are release candidates (`1.0.0-rc.N`) until 1.0.0. To graduate, set
`"prerelease": false` in `release-please-config.json` and add a commit with the footer
`Release-As: 1.0.0`.

One-time setup for maintainers: configure npm trusted publishing for this repository and the
`publish.yml` workflow on npmjs.com, and add the `BAKBAK_API_KEY` and `BAKBAK_BASE_URL`
repository secrets if live tests should run in CI.
