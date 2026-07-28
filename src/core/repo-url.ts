import type { RepoRef } from './types';

/**
 * Paths under github.com that look like `/{owner}/{repo}` but are not repositories.
 * The list only needs to cover first path segments, since that is what we match on.
 */
const RESERVED_OWNERS = new Set([
  'about',
  'account',
  'apps',
  'blog',
  'codespaces',
  'collections',
  'contact',
  'customer-stories',
  'dashboard',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'logout',
  'marketplace',
  'new',
  'notifications',
  'organizations',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'security',
  'sessions',
  'settings',
  'site',
  'sponsors',
  'stars',
  'topics',
  'trending',
  'users',
  'watching',
]);

/**
 * Extracts owner/repo from a github.com URL, or returns null when the URL is not a
 * repository page. Sub-pages (`/tree/...`, `/issues`, ...) still resolve to the repo —
 * the panel should stay mounted while browsing within a repository.
 */
export function parseRepoUrl(url: string | URL): RepoRef | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }

  if (parsed.hostname !== 'github.com') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, repo] = segments as [string, string];
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;

  // `.git` suffixes and query strings never appear in real repo page URLs, but clean
  // them anyway so a hand-typed URL still works.
  const cleanRepo = repo.replace(/\.git$/, '');
  if (!cleanRepo) return null;

  return { owner, repo: cleanRepo };
}

/** True when the URL is the repository's landing page, where the sidebar lives. */
export function isRepoHomePage(url: string | URL): boolean {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const segments = parsed.pathname.split('/').filter(Boolean);
  return parseRepoUrl(parsed) !== null && segments.length === 2;
}
