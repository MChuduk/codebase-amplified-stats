import type { RepoRef, TreeEntry } from './types';

const API_BASE = 'https://api.github.com';

export type GitHubErrorCode =
  | 'rate-limit'
  | 'not-found'
  | 'auth'
  /** The token is valid but not authorised for an SSO-protected organisation. */
  | 'sso'
  | 'network'
  | 'server';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly code: GitHubErrorCode,
    readonly status?: number,
    /** Epoch seconds when the rate limit resets, for `rate-limit` errors. */
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  resetAt: number;
}

/** Last seen rate-limit headers, so the UI can show the budget without an extra request. */
let lastRateLimit: RateLimit | null = null;

export function getLastRateLimit(): RateLimit | null {
  return lastRateLimit;
}

function readRateLimit(headers: Headers): void {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (limit && remaining && reset) {
    lastRateLimit = {
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
    throw new GitHubApiError(
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
      throw new GitHubApiError('GitHub API rate limit exceeded', 'rate-limit', response.status, resetAt);
    }

    const needsSsoAuthorization = response.headers.get('x-github-sso') !== null;
    if (needsSsoAuthorization) {
      throw new GitHubApiError(
        'This token has not been authorised for the organisation that owns this repository.',
        'sso',
        response.status,
      );
    }

    throw new GitHubApiError('Access denied by GitHub', 'auth', response.status);
  }

  if (response.status === 401) {
    throw new GitHubApiError('GitHub token is invalid or expired', 'auth', 401);
  }

  // 404 also means "your token cannot see it": GitHub hides a private repository's very
  // existence, and an org with OAuth App access restrictions looks identical from here.
  if (response.status === 404) {
    throw new GitHubApiError(
      'Repository not found, or this token cannot read it. If it belongs to an ' +
        'organisation, an owner may need to approve this extension’s OAuth app.',
      'not-found',
      404,
    );
  }

  throw new GitHubApiError(`GitHub API returned ${response.status}`, 'server', response.status);
}

export interface RepoInfo {
  defaultBranch: string;
  /** Repository size in KB, as reported by GitHub. */
  sizeKb: number;
}

export async function fetchRepoInfo(repo: RepoRef, token: string): Promise<RepoInfo> {
  const data = await request<{ default_branch: string; size: number }>(
    `/repos/${repo.owner}/${repo.repo}`,
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
    `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(branch)}`,
    token,
  );
  return data.sha;
}

export interface TreeResult {
  entries: TreeEntry[];
  /**
   * GitHub caps the response at 100k entries / 7 MB. When this is true the listing is
   * incomplete and any total we compute is a lower bound.
   */
  truncated: boolean;
}

/** Fetches the entire file listing for a commit in one request. */
export async function fetchTree(
  repo: RepoRef,
  commitSha: string,
  token: string,
): Promise<TreeResult> {
  const data = await request<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${repo.owner}/${repo.repo}/git/trees/${commitSha}?recursive=1`,
    token,
  );
  return { entries: data.tree, truncated: data.truncated };
}

