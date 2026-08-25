---
title: Chrome Web Store listing copy
---

# Chrome Web Store listing copy

Text prepared for the Developer Dashboard forms. Keep it in sync with the extension.

## Store listing

**Name:** Codebase Amplified Stats

**Category:** Developer Tools

**Short description** (128 chars max):

> Real lines of code per language on any GitHub repo — vendored, generated and binary files
> filtered out first.

**Detailed description:**

> GitHub's language bar measures bytes and counts every file Linguist recognises. A minified
> vendor bundle, a generated protobuf or a lock file can dominate it while telling you
> nothing about the code someone actually wrote.
>
> Codebase Amplified Stats counts lines instead, separates code from comments, and throws
> the machine-written files out first. The result appears in GitHub's sidebar, right under
> the Languages section, on any repository you can read — public or private.
>
> • Excludes vendored paths, generated output, binaries and oversized files, using GitHub
> Linguist's own rules, and always reports how many files were excluded and why.
> • Counts with a character-level state machine that understands strings, nested block
> comments, raw strings, Python docstrings and CRLF — verified per file against cloc and
> tokei.
> • Fast: one repository costs four API requests and a single archive download. Results are
> cached per commit, and line counts are cached per file-content hash, so unchanged files are
> never counted twice.
> • No backend, no telemetry, no third parties. Everything runs in your browser.
>
> Sign-in with GitHub is required, because every request the extension makes is
> authenticated — that is what lets it read your private repositories. GitHub will ask for
> the "repo" scope and describe it as full control of private repositories: that is GitHub's
> wording for the scope, not what this extension does. "repo" is the only classic OAuth scope
> that grants read access to private repositories at all, and GitHub offers no read-only
> equivalent. The extension only reads — it lists a repository's files and downloads an
> archive of them to count lines. Your token stays in this browser profile and is sent to
> GitHub and nowhere else.

**Screenshot:** `docs/screenshot-1280x800.png`

**Privacy policy URL:** https://mchuduk.github.io/github-amplified-stats/privacy-policy

**Homepage / support URL:** https://github.com/MChuduk/github-amplified-stats

## Privacy practices

**Single purpose:**

> Counts the lines of code per language in the GitHub repository open in the current tab and
> displays the result in that page's sidebar.

**Permission justifications:**

| Permission                      | Justification                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                       | Stores the user's GitHub OAuth token locally, so sign-in survives a browser restart.             |
| `offscreen`                     | An MV3 service worker cannot call `new Worker()`. An offscreen document unpacks the repository archive and hosts the Web Workers that count. |
| `https://api.github.com/*`      | Reads repository metadata, the commit SHA and the file listing, and requests the repository archive.                                         |
| `https://github.com/login/*`    | The two OAuth Device Flow endpoints used to sign the user in.                                                                                |
| `https://codeload.github.com/*` | Where GitHub's archive endpoint redirects; the archive is actually downloaded from this host.                                                |
| Content script on `github.com`  | Renders the statistics panel inside the repository page's sidebar. It reads no page data and sends nothing anywhere.                         |

**Remote code:** No. All executable code ships inside the package; nothing is fetched,
injected or evaluated at runtime.

**Data usage:** Authentication information (the GitHub OAuth token) and website content
(repository file contents, read to count lines) are handled locally. Neither is transmitted
to the developer or to any third party — the extension has no backend. File contents are
never stored; only the resulting line counts are cached, in this browser profile.

Certifications to accept: data is not sold to third parties, is not used or transferred for
purposes unrelated to the extension's single purpose, and is not used to determine
creditworthiness or for lending.
