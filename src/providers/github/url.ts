import type { RepoRef } from '../../common';

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
 * Sub-pages (`/tree/...`, `/issues`, ...) resolve to the repository too, so the panel
 * stays mounted while browsing around inside one.
 */
export function parseRepoUrl(url: URL): RepoRef | null {
  if (url.hostname !== 'github.com') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, repo] = segments as [string, string];
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;

  // `.git` suffixes and query strings never appear in real repo page URLs, but clean
  // them anyway so a hand-typed URL still works.
  const cleanRepo = repo.replace(/\.git$/, '');
  if (!cleanRepo) return null;

  return { provider: 'github', owner, repo: cleanRepo };
}

/** True when the URL is the repository's landing page, where the sidebar lives. */
export function isRepoHomePage(url: URL): boolean {
  const segments = url.pathname.split('/').filter(Boolean);
  return parseRepoUrl(url) !== null && segments.length === 2;
}
