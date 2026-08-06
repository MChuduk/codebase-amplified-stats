import type { RepoRef, RepoStats } from './types';

/**
 * Message contract between the content script and the background service worker.
 *
 * Quick lookups use `sendMessage`. Counting uses a long-lived port instead: it streams
 * progress back, and an open port keeps the service worker from being torn down
 * mid-run — an ordinary `sendMessage` round trip does not.
 */

export interface PreviewRequest {
  kind: 'preview';
  repo: RepoRef;
}

export interface CacheStatsRequest {
  kind: 'cache-stats';
}

export interface ClearCacheRequest {
  kind: 'clear-cache';
}

export type Request = PreviewRequest | CacheStatsRequest | ClearCacheRequest;

/** What we can tell the user before committing to downloading anything. */
export interface RepoPreview {
  branch: string;
  commitSha: string;
  /** Files that survived filtering. */
  fileCount: number;
  /** Total bytes of those files. */
  totalBytes: number;
  /** How many are already cached and need no download. */
  cachedCount: number;
  /** Bytes actually left to download, after the cache. */
  bytesToDownload: number;
  truncated: boolean;
  /** Cached result for this exact commit, when one exists. */
  cached: RepoStats | null;
  /** Remaining GitHub API budget, for the rate-limit hint. */
  rateLimit: { remaining: number; limit: number; resetAt: number } | null;
}

export type ErrorCode = 'rate-limit' | 'not-found' | 'network' | 'auth';

export type Response<T> =
  | { ok: true; data: T }
  /** `resetAt` is epoch seconds, present for rate-limit errors. */
  | { ok: false; error: string; code?: ErrorCode; resetAt?: number };

/** Sends a typed request to the background worker. */
export async function sendRequest<T>(request: Request): Promise<Response<T>> {
  try {
    return (await browser.runtime.sendMessage(request)) as Response<T>;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'network',
    };
  }
}

/* ---------- Port protocol for the counting job ---------- */

export const ANALYZE_PORT = 'analyze';

export interface AnalyzeStart {
  kind: 'analyze';
  repo: RepoRef;
  /** Ignore any cached result for this commit and recount. */
  force?: boolean;
}

export type AnalyzePhase = 'resolving' | 'listing' | 'counting' | 'done';

export type AnalyzeEvent =
  | { kind: 'progress'; phase: AnalyzePhase; done: number; total: number }
  /** Totals so far, so the panel fills in while the run is still going. */
  | { kind: 'partial'; stats: RepoStats; done: number; total: number }
  | { kind: 'result'; stats: RepoStats; failures: number }
  | { kind: 'error'; message: string; code?: ErrorCode; resetAt?: number };
