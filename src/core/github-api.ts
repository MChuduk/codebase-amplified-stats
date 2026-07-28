import type { RepoRef, TreeEntry } from './types';

const API_BASE = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly code: 'rate-limit' | 'not-found' | 'auth' | 'network' | 'server',
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

async function request<T>(path: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

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

  // A 403/429 with no remaining budget is rate limiting; a 403 with budget left is a
  // genuine permission problem, and the two need different messages.
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const resetAt = Number(response.headers.get('x-ratelimit-reset') ?? 0);
      throw new GitHubApiError('GitHub API rate limit exceeded', 'rate-limit', response.status, resetAt);
    }
    throw new GitHubApiError('Access denied by GitHub', 'auth', response.status);
  }

  if (response.status === 401) {
    throw new GitHubApiError('GitHub token is invalid or expired', 'auth', 401);
  }

  if (response.status === 404) {
    throw new GitHubApiError('Repository not found or is private', 'not-found', 404);
  }

  throw new GitHubApiError(`GitHub API returned ${response.status}`, 'server', response.status);
}

export interface RepoInfo {
  defaultBranch: string;
  private: boolean;
  /** Repository size in KB, as reported by GitHub. */
  sizeKb: number;
  fork: boolean;
}

export async function fetchRepoInfo(repo: RepoRef, token: string | null): Promise<RepoInfo> {
  const data = await request<{
    default_branch: string;
    private: boolean;
    size: number;
    fork: boolean;
  }>(`/repos/${repo.owner}/${repo.repo}`, token);

  return {
    defaultBranch: data.default_branch,
    private: data.private,
    sizeKb: data.size,
    fork: data.fork,
  };
}

/** Resolves a branch name to the commit SHA it points at — our cache key. */
export async function fetchCommitSha(
  repo: RepoRef,
  branch: string,
  token: string | null,
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
  token: string | null,
): Promise<TreeResult> {
  const data = await request<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${repo.owner}/${repo.repo}/git/trees/${commitSha}?recursive=1`,
    token,
  );
  return { entries: data.tree, truncated: data.truncated };
}

/**
 * Raw file URL on GitHub's CDN. Requests here do *not* count against the REST API rate
 * limit, which is what makes downloading thousands of files viable. Public repos only.
 */
export function rawUrl(repo: RepoRef, commitSha: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${commitSha}/${encodedPath}`;
}
