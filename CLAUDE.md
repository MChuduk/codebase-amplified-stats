# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
WXT_GITHUB_CLIENT_ID=<id> pnpm dev     # WXT dev server with hot reload (Chrome)
WXT_GITHUB_CLIENT_ID=<id> pnpm build   # production build → .output/chrome-mv3
pnpm compile                   # tsc --noEmit (strict, noUncheckedIndexedAccess)
pnpm gen:languages             # regenerate src/core/languages.generated.ts from Linguist
```

`WXT_GITHUB_CLIENT_ID` is **required**: without it `isConfigured()` is false, sign-in is
impossible, and nothing works. A `build:before` hook in [wxt.config.ts](wxt.config.ts)
throws on a production build without it and warns in dev.

**There are no tests and no e2e script** — deliberate but temporary; verification is manual.
`pnpm compile` is the only automated check, so prefer changes whose breakage the type
checker catches. Be especially careful in [counter.ts](src/core/counter.ts) and
[tarball.ts](src/core/tarball.ts): a regression there yields plausible-looking wrong numbers.

## Architecture

An MV3 Chrome extension (WXT + React 19 + Tailwind 4) that counts real lines of code per
language on a GitHub repo page — public or private. No backend: everything runs in the
browser against GitHub's REST API. **Every request is authenticated**; there is no anonymous
mode. The OAuth Device Flow token requests the `repo` scope, which is the only classic scope
that opens private repositories (GitHub has no read-only variant).

### Four execution contexts

| Context | Entry | Role |
|---|---|---|
| Content script | [entrypoints/github.content/index.tsx](entrypoints/github.content/index.tsx) | Mounts the React panel into GitHub's sidebar (shadow DOM) |
| Background SW | [entrypoints/background.ts](entrypoints/background.ts) | Orchestrator: resolve → filter → cache → count → aggregate |
| Offscreen doc | [entrypoints/offscreen/main.ts](entrypoints/offscreen/main.ts) | Downloads + unpacks the archive, and hosts the Workers — an MV3 service worker cannot call `new Worker()` |
| Workers | [entrypoints/offscreen/counter.worker.ts](entrypoints/offscreen/counter.worker.ts) | Count bytes handed to them; no I/O. Up to 8, sized by `hardwareConcurrency` |

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

4 API calls per repo — `/repos`, `/commits/HEAD`, `/git/trees?recursive=1`, then
`/repos/{o}/{r}/tarball/{sha}`. [filterTree](src/core/filter.ts) drops
vendored/generated/binary/unknown/oversized paths, [disambiguate](src/core/disambiguate.ts)
resolves ambiguous extensions (`.h`, `.m`, `.ts`) from repo-level signals, and the surviving
files are counted from the archive.

**The archive is the only download path.** One gzipped tar, unpacked on the offscreen host
by a hand-written tar reader; the bytes of wanted files go to workers as transferables with
a 32 MB in-flight cap, and unwanted entries are skipped without ever being assembled. There
is no per-file fallback — if the tar reader breaks, the run fails.

[tarballUrl](src/core/tarball.ts) points at the **REST** endpoint, not `codeload` directly.
That endpoint 302s to a signed codeload URL, `fetch` follows it and strips `Authorization`
on the cross-origin hop (correct — the signed URL carries its own credential), and it is the
only documented way to reach a private repository's contents.

The archive is skipped entirely when `blobStats` already covers every file in the commit.

### Caching (three layers)

- **`blobStats` (IndexedDB)** keyed by *Git blob SHA*, so it is valid across commits,
  branches and forks. Binary blobs are recorded too, or they get re-counted forever. The
  lookup is a single cursor walk exploiting lowercase-hex ordering, not N `get`s. Since the
  archive is all-or-nothing this no longer saves bandwidth — it saves counting, and it can
  skip the archive altogether when a commit is fully covered.
- **`repoRuns` (IndexedDB)** whole results per `owner/repo@commit` — instant revisits. Note
  the consequence: a **new commit means the whole archive is downloaded again**.
- **`resolveCache` (in-memory, 10 min)** in the background, storing the *promise* so
  concurrent callers share one set of API requests. Without it, opening a page, clicking
  Count, and each panel re-mount each spent 3 requests re-learning the same commit SHA.
  `force` (Refresh) bypasses `resolveCache` and `repoRuns`, but deliberately **not**
  `blobStats` — a blob SHA hashes contents, so a cached count for one is correct by
  construction.

Neither cache ever stores file contents, only `LineStats` — private source is not kept at
rest. Results are persisted per batch as they arrive, so an interrupted run banks its work.

## Working in this codebase

- **`src/core/languages.generated.ts` is generated** — never hand-edit; change
  [scripts/gen-languages.ts](scripts/gen-languages.ts) and rerun `pnpm gen:languages`.
  Extension conflicts are resolved there via `PREFERRED_LANGUAGES` / `EXTENSION_OVERRIDES`.
  Comment syntax is *not* from Linguist; it's hand-curated in
  [src/core/comment-syntax.ts](src/core/comment-syntax.ts). A language absent there is still
  counted, but reports `comment: null` rather than guessing.
- **Counting conventions follow `cloc`**: mixed code+comment lines count as code, Python
  docstrings count as comments. [counter.ts](src/core/counter.ts) is a character-level state
  machine tracking strings and comments across line boundaries, plus `countBytes` (the 8 KB
  NUL-byte binary check and the decode). With no tests left, changes here must be checked by
  counting a known repository and comparing against previously recorded numbers.
- **Skips are always attributed.** `SkipReason` counts flow through to the panel; when
  adding a filter rule, add its reason rather than dropping files silently. The same applies
  to files the archive does not carry (submodules, say) — they become explicit failures.
- **GitHub's DOM is not an API.** [src/ui/anchor.ts](src/ui/anchor.ts) has four ranked
  anchor strategies matching Primer CSS-module classes by hash-free prefix; the content
  script re-mounts on Turbo `wxt:locationchange` and via a `MutationObserver` when GitHub
  re-renders the sidebar or a better-ranked anchor appears. If nothing matches it mounts
  nothing rather than break the page. Load the built extension and check by hand after any
  DOM change.
- **WXT auto-imports** `browser`, `defineBackground`, `defineContentScript`,
  `createShadowRootUi` etc. — they need no import statement. `.wxt/` is generated by
  `wxt prepare` (postinstall), so the client-ID guard must not run there.
- **The token is read in exactly one place** — `getToken()` in the background — and travels
  to the offscreen document on `OffscreenRequest.token`. A Web Worker has no extension
  storage, so it cannot read it itself. Keep it out of `RepoPreview` / `AnalyzeEvent`: the
  panel runs inside a github.com page and has no use for it.
- **Access failures are three different things** and the panel says which: `no-token` (none
  stored, or a 401 just discarded it), `sso` (403 with `x-github-sso` — the token needs
  authorising for that org), and `not-found` (404 — which GitHub also returns when an org's
  OAuth App access restrictions hide a repository from an otherwise valid token).
- A future second provider (GitLab, Bitbucket) is planned; when touching `src/core/`, keep
  it free of GitHub specifics — those belong in the API client, auth, URL parsing and anchor
  modules.

## Project rules

Coding rules live in [docs/rules/](docs/rules/), one file per rule. They apply to every
change in this repository, so read the relevant one before writing code.

- @docs/rules/comments.md — self-documenting code first; comments are rare and explain
  *why*, never *what*.
