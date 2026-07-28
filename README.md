# GitHub Amplified Stats

A Chrome extension that shows **real lines of code per language** on a GitHub repository page.

GitHub's own language bar measures **bytes**, not lines, and counts every file Linguist
recognises. A minified vendor bundle, a generated protobuf or a lock file can dominate the
bar while telling you nothing about the code someone actually wrote. This extension counts
lines, separates code from comments, and throws the machine-written files out first.

<!-- Screenshot: sidebar panel under the Languages block -->

## How it works

No backend, no paid service, nothing leaves your browser except requests to GitHub.

```
GET /repos/{owner}/{repo}                     → default branch
GET /repos/{owner}/{repo}/commits/{branch}    → commit SHA (the cache key)
GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
        ↓  one request, the entire file listing
   FILTER  vendored / generated / binary / unrecognised / oversized
        ↓  typically removes 60–95% of files
   CACHE   already counted this blob SHA? then skip it
        ↓
   FETCH   raw.githubusercontent.com, in parallel across Web Workers
        ↓  counted as it streams; file contents are never held in memory
   AGGREGATE per language → rendered into the sidebar
```

Two things make this practical:

**`raw.githubusercontent.com` does not consume the REST API quota.** A repository costs
exactly **three API requests**; the thousands of file downloads are free of the limit. That
is why counting a large repository does not exhaust a 60-request anonymous budget.

**The cache is keyed by Git blob SHA — a hash of file contents.** A file that has not
changed is never downloaded twice, across commits, branches, and even forks. Pushing one
commit re-counts only what that commit touched.

## Accuracy

The counter is a character-level state machine that tracks strings and comments, so
`"// not a comment"` counts as code and a `/* … */` spanning ten lines does not. It handles
nested block comments (Rust, Swift, Haskell), raw strings (Go backticks, Rust `r#"…"#`),
Python docstrings, and CRLF.

Verified per-file against `tokei` and `cloc` on real repositories:

| Language | vs cloc |
|---|---|
| TypeScript, JavaScript, YAML, TOML, Ruby, Lua, CSS, HTML | **0.00%** |
| Go | +0.4% |
| Python | +1.5% |
| Rust | between cloc and tokei |

Conventions follow `cloc`:

- A line holding both code and a comment counts as **code**.
- Python docstrings count as **comments** (tokei counts them as code).
- Blank lines count as **blank** wherever they appear.

Both reference tools mis-handle `/*` inside Go string literals — `"/src/*filepath"` opens a
block comment for them and swallows the rest of the file. This extension gets that right,
which is why some Go files differ from both.

Languages with no comment syntax in the table are still counted for total, blank and code;
their comment column shows `—` rather than a guess.

## What gets excluded

Exclusion rules come from [GitHub Linguist](https://github.com/github-linguist/linguist)
itself, plus path rules for generated output:

- **Vendored** — `node_modules/`, `vendor/`, `dist/`, `third_party/`, `.github/`, and 160+ more
- **Generated** — lock files, `*.pb.go`, `*_pb2.py`, `*.min.js`, `__snapshots__/`, `*.designer.cs`
- **Binary** — by extension, plus a NUL-byte check while downloading
- **Oversized** — above 1 MB by default; these are almost always generated dumps

The panel always reports how many files were excluded and why. A number you cannot explain
is worse than no number.

Tests, documentation and data files are counted but kept in separate buckets, so you can
toggle them in the panel without re-downloading anything.

## Install

```bash
pnpm install
pnpm build          # output in .output/chrome-mv3
```

Load `.output/chrome-mv3` at `chrome://extensions` with developer mode on.

For development with hot reload:

```bash
pnpm dev
```

### Optional: raising the rate limit

Anonymous use gets 60 API requests an hour — about 20 repositories. Signing in raises that
to 5,000. To enable sign-in, create an OAuth App at
<https://github.com/settings/developers>, tick **Enable Device Flow**, and build with:

```bash
WXT_GITHUB_CLIENT_ID=your_client_id pnpm build
```

Device Flow is the only OAuth grant that needs no client secret, which is what makes it
safe to use from an extension with no backend. No scopes are requested — the token only
reads public data.

## Development

```bash
pnpm test              # unit tests for the counter, filter and aggregation
pnpm compile           # type check
pnpm gen:languages     # regenerate language data from Linguist
npx tsx scripts/browser-check.mts   # end-to-end check in a real Chromium
```

`scripts/browser-check.mts` loads the built extension into Chromium, opens a repository,
clicks through a full count and reports where the panel landed in the sidebar. Run it after
any change to the DOM integration — GitHub's markup is not a public API and shifts without
notice.

### Layout

```
entrypoints/
  github.content/    content script — mounts the panel into the sidebar
  background.ts      orchestrator: resolve → filter → cache → count
  offscreen/         worker host (an MV3 service worker cannot spawn Workers)
  options/           settings, sign-in, cache management
src/core/            counting engine, GitHub client, filter, cache — no DOM
src/ui/              React components
scripts/             language-data generator, browser check
```

## Known limits

- **Public repositories only.** Private repos would need `raw.githubusercontent.com` to be
  replaced with GraphQL batching and a broad `repo` OAuth scope.
- **Very large repositories.** Above 100k files GitHub truncates the tree listing; the panel
  says so and reports a lower bound.
- **YAML block scalars.** A `#` inside a `|` block is counted as a comment. Roughly −2% on
  YAML-heavy repositories.
- **GitHub's markup.** The panel anchors to the Languages block through several fallback
  strategies and re-mounts itself if GitHub re-renders the sidebar. If none match, it mounts
  nothing rather than break the page.

## Licence

Language names, colours, vendored-path rules and file-type detection come from
[GitHub Linguist](https://github.com/github-linguist/linguist), used under the MIT licence.
See [NOTICE](NOTICE).
