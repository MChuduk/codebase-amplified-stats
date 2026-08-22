import { ProviderError } from '../../common';
import type {
  ArchiveRequest,
  RateLimit,
  RepoInfo,
  RepoRef,
  TreeEntry,
  TreeResult,
} from '../../common';

const API_BASE = 'https://api.github.com';

/** Last seen rate-limit headers, so the UI can show the budget without an extra request. */
let seen: RateLimit | null = null;

export function lastRateLimit(): RateLimit | null {
  return seen;
}

function readRateLimit(headers: Headers): void {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (limit && remaining && reset) {
    seen = {
      limit: Number(limit),
      remaining: Number(remaining),
      resetAt: Number(reset),
    };
  }
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, token: string): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(token),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { headers });
  } catch (error) {
    throw new ProviderError(
      error instanceof Error ? error.message : 'Network request failed',
      'network',
    );
  }

  readRateLimit(response.headers);

  if (response.ok) return (await response.json()) as T;

  // GitHub overloads 403: out of budget, SSO not yet authorised, and plain refusal all
  // arrive the same way, and the user can act on each of them differently.
  if (response.status === 403 || response.status === 429) {
    const budgetExhausted = response.headers.get('x-ratelimit-remaining') === '0';
    if (budgetExhausted) {
      const resetAt = Number(response.headers.get('x-ratelimit-reset') ?? 0);
      throw new ProviderError(
        'GitHub API rate limit exceeded',
        'rate-limit',
        response.status,
        resetAt,
      );
    }

    const needsSsoAuthorization = response.headers.get('x-github-sso') !== null;
    if (needsSsoAuthorization) {
      throw new ProviderError(
        'This token has not been authorised for the organisation that owns this repository.',
        'sso',
        response.status,
      );
    }

    throw new ProviderError('Access denied by GitHub', 'auth', response.status);
  }

  if (response.status === 401) {
    throw new ProviderError('GitHub token is invalid or expired', 'auth', 401);
  }

  // 404 also means "your token cannot see it": GitHub hides a private repository's very
  // existence, and an org with OAuth App access restrictions looks identical from here.
  if (response.status === 404) {
    throw new ProviderError(
      'Repository not found, or this token cannot read it. If it belongs to an ' +
        'organisation, an owner may need to approve this extension’s OAuth app.',
      'not-found',
      404,
    );
  }

  throw new ProviderError(`GitHub API returned ${response.status}`, 'server', response.status);
}

export async function fetchRepoInfo(repo: RepoRef, token: string): Promise<RepoInfo> {
  const data = await request<{ default_branch: string; size: number }>(
    `/repos/${slug(repo)}`,
    token,
  );

  return { defaultBranch: data.default_branch, sizeKb: data.size };
}

/** Resolves a branch name to the commit SHA it points at — our cache key. */
export async function fetchCommitSha(
  repo: RepoRef,
  branch: string,
  token: string,
): Promise<string> {
  const data = await request<{ sha: string }>(
    `/repos/${slug(repo)}/commits/${encodeURIComponent(branch)}`,
    token,
  );
  return data.sha;
}

/** GitHub caps this at 100k entries / 7 MB, which is what `truncated` reports. */
export async function fetchTree(
  repo: RepoRef,
  commitSha: string,
  token: string,
): Promise<TreeResult> {
  const data = await request<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${slug(repo)}/git/trees/${commitSha}?recursive=1`,
    token,
  );
  return { entries: data.tree, truncated: data.truncated };
}

const slug = (repo: RepoRef) =>
  `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

/**
 * The REST endpoint rather than `codeload.github.com` directly: it 302s to a signed
 * codeload URL, and that redirect is the only documented route to a private repository's
 * archive. `fetch` follows it and strips `Authorization` on the cross-origin hop, which is
 * what we want — the signed URL carries its own credential.
 */
export function archiveRequest(repo: RepoRef, commitSha: string, token: string): ArchiveRequest {
  return {
    url: `${API_BASE}/repos/${slug(repo)}/tarball/${commitSha}`,
    headers: authHeaders(token),
  };
}
