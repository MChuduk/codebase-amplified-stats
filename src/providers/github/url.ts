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

export function parseRepoUrl(url: URL): RepoRef | null {
  if (url.hostname !== 'github.com') return null;

  const [owner, repo, route, ...refPath] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repo || RESERVED_OWNERS.has(owner.toLowerCase())) return null;

  // `.git` suffixes and query strings never appear in real repo page URLs, but clean
  // them anyway so a hand-typed URL still works.
  const cleanRepo = repo.replace(/\.git$/, '');
  if (!cleanRepo) return null;

  const target: RepoRef = { provider: 'github', owner, repo: cleanRepo };
  if (!route) return target;
  if (route !== 'tree' || refPath.length === 0) return null;

  // A slash can belong to the ref or delimit a directory. The sidebar lookup checks
  // the selected ref before mounting, once GitHub has rendered the target page.
  try {
    return { ...target, ref: decodeURIComponent(refPath.join('/')) };
  } catch {
    return null;
  }
}
