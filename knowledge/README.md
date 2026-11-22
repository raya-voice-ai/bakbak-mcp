# Developer documentation bundled with the server

`search_docs`, `read_docs` and the `bakbak://docs/` resources serve these pages. They are built
into `src/knowledge/pages.generated.ts`, so every distribution (npm, the Claude Desktop bundle,
the container) carries them with no files to ship and no network access.

| Folder or file | What it is | Edit it? |
| --- | --- | --- |
| `guides/*.md` | Integration guides written for this pack: `start-here`, `best-practices`, platform guides, `troubleshooting` | Yes. Front matter `id` (= file name), `title`, `description`. New guides go in `GUIDE_ORDER` in `scripts/build-knowledge.mjs`. |
| `upstream/*.md` | The Python SDK, JavaScript SDK and LiveKit plugin READMEs and examples, and three pages of the docs site (https://docs.bakbak.si: WebSocket, errors, output formats) | No: change them upstream, then sync. Links to the old site, docs.litwizlabs.com, are rewritten to docs.bakbak.si (table `MOVED` in `scripts/sync-knowledge.mjs`). |
| `../conformance/BEHAVIOR.md` | The client contract (page `client-behavior`) | Through the conformance sync |
| `../README.md` | This server's README (page `mcp-server`) | Yes |

## Updating

```sh
npm run knowledge:sync    # copy upstream pages from sibling checkouts at origin/main, then build
npm run knowledge:build   # after editing a guide, README.md or conformance/BEHAVIOR.md
npm run knowledge:check   # what CI runs: the generated module is up to date
```

`knowledge:sync` reads `../bakbak-python`, `../bakbak-js`, `../livekit-plugins-bakbak` and
`../bakbak-docs` (the Fern source of docs.bakbak.si; override with `BAKBAK_PYTHON_DIR`,
`BAKBAK_JS_DIR`, `LIVEKIT_PLUGIN_DIR`, `BAKBAK_DOCS_DIR`) at `origin/main` (`KNOWLEDGE_REF`), so
only committed text is bundled. Fetch those repositories first. `BAKBAK_DOCS_REF=worktree` reads
the docs checkout's files as they are, for pages not yet merged. The weekly drift workflow compares
the public pages with GitHub and warns when they are behind (the docs repository is private, so
its pages are checked only by a local sync).

The sync stops if a README links to a page of the old site that `MOVED` doesn't map: add the
page's new path there.

Sync after every SDK or plugin release, so the next release of this server documents it.

## Writing guides

- Write for a coding assistant that will act on the page, and for the developer reading over its
  shoulder: concrete steps, code that runs, the reason for each rule.
- Every code sample must be checked against the real package (type-check, compile or run it).
- Name other pages by id in backticks (`` `python-sdk` ``); a test checks that "See also" lines and
  "Read" columns name pages that exist.
- Leave tables unpadded: padding costs the model tokens. Prettier ignores this folder.
- No keys, internal hostnames, customer names or staging URLs: the pages are public.
