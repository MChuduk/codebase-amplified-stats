# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev                       # WXT dev server with hot reload (Chrome)
pnpm build                     # production build → .output/chrome-mv3
pnpm compile                   # tsc --noEmit (strict, noUncheckedIndexedAccess)
pnpm test                      # vitest run (no config file; defaults)
pnpm test src/core/filter.test.ts   # single file
pnpm test -- -t "nested"       # single test by name (note the `--`)
pnpm test:watch
pnpm gen:languages             # regenerate src/core/languages.generated.ts from Linguist
npx tsx scripts/browser-check.mts [repoUrl]   # e2e check; requires `pnpm build` first
```

Build with `WXT_GITHUB_CLIENT_ID=<id> pnpm build` to enable the OAuth Device Flow sign-in;
without it `isConfigured()` is false and the options page hides sign-in.

## Architecture

An MV3 Chrome extension (WXT + React 19 + Tailwind 4) that counts real lines of code per
language on a GitHub repo page. No backend: everything runs in the browser against GitHub's
public endpoints.

### Four execution contexts

| Context | Entry | Role |
|---|---|---|
| Content script | [entrypoints/github.content/index.tsx](entrypoints/github.content/index.tsx) | Mounts the React panel into GitHub's sidebar (shadow DOM) |
| Background SW | [entrypoints/background.ts](entrypoints/background.ts) | Orchestrator: resolve → filter → cache → count → aggregate |
| Offscreen doc | [entrypoints/offscreen/main.ts](entrypoints/offscreen/main.ts) | Worker host — an MV3 service worker cannot call `new Worker()` |
| Workers | [entrypoints/offscreen/counter.worker.ts](entrypoints/offscreen/counter.worker.ts) | Fetch + count; up to 8, sized by `hardwareConcurrency` |

`src/core/` holds the engine (counting, filtering, GitHub client, cache, tarball) —
importable from any context. `src/ui/` is React only.

### Two message protocols

- **Request/response** (`sendMessage`) for `preview`, `cache-stats`, `clear-cache` — see
  [src/core/messages.ts](src/core/messages.ts).
- **Long-lived port** (`ANALYZE_PORT`) for a counting run. This is not a style choice: an
  open port keeps the service worker alive for the duration of the job, which a
  `sendMessage` round trip does not, and it streams progress + partial totals.

Background ↔ offscreen messages ride the same `runtime` bus and are routed by a `target`
field ([src/core/offscreen-protocol.ts](src/core/offscreen-protocol.ts)); the background
listener ignores anything with `target` present, and vice versa. Offscreen → background
progress batches are acknowledged so they stay ordered.

### The counting pipeline

3 API calls per repo (`/repos`, `/commits/HEAD`, `/git/trees?recursive=1`), then
[filterTree](src/core/filter.ts) drops vendored/generated/binary/unknown/oversized paths,
[disambiguate](src/core/disambiguate.ts) resolves ambiguous extensions (`.h`, `.m`, `.ts`)
from repo-level signals, and the surviving files are downloaded and counted.

Downloads take one of two paths, chosen by [shouldUseTarball](src/core/tarball.ts)
(≥400 files to fetch, >50% of the repo still uncached, ≤500 MB):

- **Per-file** — `raw.githubusercontent.com`, 8 concurrent per worker. Workers fetch
  directly so text never crosses a thread boundary.
- **Tarball** — one `codeload.github.com` `tar.gz`, unpacked on the offscreen host by a
  hand-written tar reader, bytes handed to workers as transferables with a 32 MB in-flight
  cap. Purely an optimisation: any failure sets `tarballFailed` and the background retries
  the per-file path for whatever is still missing, keeping work already done.

Neither raw nor codeload requests spend REST rate limit — that's the whole reason a repo
costs only 3 API requests.

### Caching (three layers)

- **`blobStats` (IndexedDB)** keyed by *Git blob SHA*, so it is valid across commits,
  branches and forks. Binary blobs are recorded too, or they get re-downloaded forever.
  The lookup is a single cursor walk exploiting lowercase-hex ordering, not N `get`s.
- **`repoRuns` (IndexedDB)** whole results per `owner/repo@commit` — instant revisits.
- **`resolveCache` (in-memory, 10 min)** in the background, storing the *promise* so
  concurrent callers share one set of API requests. Without it, opening a page, clicking
  Count, and each panel re-mount each spent 3 of the 60-per-hour anonymous budget.
  `force` (Refresh) bypasses both `resolveCache` and `repoRuns`.

Results are persisted per batch as they arrive, so an interrupted run still banks its work.

## Working in this codebase

- **`src/core/languages.generated.ts` is generated** — never hand-edit; change
  [scripts/gen-languages.ts](scripts/gen-languages.ts) and rerun `pnpm gen:languages`.
  Extension conflicts are resolved there via `PREFERRED_LANGUAGES` / `EXTENSION_OVERRIDES`.
  Comment syntax is *not* from Linguist; it's hand-curated in
  [src/core/comment-syntax.ts](src/core/comment-syntax.ts). A language absent there is still
  counted, but reports `comment: null` rather than guessing.
- **Counting conventions follow `cloc`**: mixed code+comment lines count as code, Python
  docstrings count as comments. [counter.ts](src/core/counter.ts) is a character-level state
  machine tracking strings and comments across line boundaries — any change there needs
  cases in [counter.test.ts](src/core/counter.test.ts). `countFile` (streaming) and
  `countBytes` (tarball) must agree exactly, including the 8 KB NUL-byte binary check.
- **Skips are always attributed.** `SkipReason` counts flow through to the panel; when
  adding a filter rule, add its reason rather than dropping files silently. The same applies
  to files the tarball path does not carry — they become explicit failures.
- **GitHub's DOM is not an API.** [src/ui/anchor.ts](src/ui/anchor.ts) has four ranked
  anchor strategies matching Primer CSS-module classes by hash-free prefix; the content
  script re-mounts on Turbo `wxt:locationchange` and via a `MutationObserver` when GitHub
  re-renders the sidebar or a better-ranked anchor appears. If nothing matches it mounts
  nothing rather than break the page. Run `scripts/browser-check.mts` after any DOM change.
- **WXT auto-imports** `browser`, `defineBackground`, `defineContentScript`,
  `createShadowRootUi` etc. — they need no import statement. `.wxt/` is generated by
  `wxt prepare` (postinstall).
- **Tests** are colocated `*.test.ts`, run in the default node environment. There is no
  vitest config and no `browser` mock — anything touching `browser.*` is untested by design;
  cache tests pull in `fake-indexeddb/auto` as their first import.
- Public repositories only. Private ones would need GraphQL batching instead of raw URLs
  plus a broad `repo` scope; the auth token deliberately requests **no** scopes.
