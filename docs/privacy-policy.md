---
title: Privacy Policy — Codebase Amplified Stats
---

# Privacy Policy

**Extension:** Codebase Amplified Stats
**Last updated:** 23 August 2026

Codebase Amplified Stats counts lines of code per language for the GitHub repository you
are looking at and shows the result in GitHub's sidebar. This policy describes exactly what
the extension does with data, and it describes the whole of it.

## The short version

The extension has no backend. Nothing is sent to the developer or to any third party. Every
network request it makes goes to GitHub, on your behalf, with your own token. Everything it
stores stays in your browser profile.

## What the extension stores, and where

All of it lives in this browser profile only, in extension-local storage
(`chrome.storage.local`) and IndexedDB. None of it is synced across devices by the
extension, and none of it leaves your machine.

| Stored                              | Where                  | What it is                                                                                     |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| GitHub OAuth access token           | `chrome.storage.local` | Created when you sign in, so requests to GitHub can be authenticated                           |
| Your settings                       | `chrome.storage.local` | Filtering preferences and display options                                                      |
| Per-file line counts (`blobStats`)  | IndexedDB              | Numbers only — code / comment / blank line totals, keyed by the file's Git content hash        |
| Per-repository results (`repoRuns`) | IndexedDB              | Numbers only — the aggregated result for one repository at one commit, so revisits are instant |

**File contents are never stored.** Source code is decoded, counted, and discarded; only the
resulting line counts are written to the cache. Private source is not kept at rest.

## The GitHub token

Signing in uses GitHub's OAuth Device Flow. The token GitHub issues is:

- **stored** in this browser profile's extension storage;
- **sent** to `api.github.com` and `codeload.github.com` as an authentication header, and
  nowhere else;
- **never** transmitted to the developer, to any server operated by the developer, or to any
  third party — there is no such server.

The token requests the **`repo`** scope. GitHub's consent screen describes that scope as full
control of private repositories. That is GitHub's wording for the scope, not a description of
what this extension does: `repo` is the only classic OAuth scope that grants read access to
private repositories at all, and GitHub offers no read-only equivalent. The extension only
ever reads — it lists a repository's files and downloads an archive of them to count lines.
It never writes, creates, deletes, or modifies anything in your GitHub account.

## Network requests

The extension contacts exactly three hosts, all of them GitHub's:

- `https://api.github.com` — repository metadata, the commit SHA, the file listing, and the
  archive request;
- `https://github.com/login/*` — the OAuth Device Flow endpoints used during sign-in;
- `https://codeload.github.com` — where GitHub redirects the archive request; this is where
  the repository archive is actually downloaded from.

There are no analytics, no telemetry, no crash reporting, no advertising, and no remote code
loading. The extension makes no request to any other host under any circumstance.

## Data sharing and sale

The developer receives no data from the extension and therefore has none to share. No data is
sold, transferred to third parties, used for advertising or credit scoring, or used for any
purpose other than counting lines of code in the repository you are viewing.

## Removing your data

- **Sign out** from the extension's options page — this deletes the stored token.
- **Clear cache** from the extension's options page — this deletes the stored line counts.
- **Uninstall** the extension — Chrome removes its storage and IndexedDB data entirely.
- **Revoke access** on GitHub's side at
  <https://github.com/settings/applications>, which invalidates the token regardless of what
  is stored locally.

## Children

The extension is a developer tool and is not directed at children under 13.

## Changes to this policy

Any change is published on this page, with the "Last updated" date above revised. The history
of every change is public in the repository's git log.

## Contact

Questions or requests: open an issue at
<https://github.com/MChuduk/github-amplified-stats/issues>.
