import type { RepoRef } from '../common';
import type { RepoStats } from '../logic/interfaces';

/**
 * Message contract between the content script and the background service worker.
 *
 * Cache maintenance uses `sendMessage`. Counting uses a long-lived port instead: it streams
 * progress back, and an open port keeps the service worker from being torn down
 * mid-run — an ordinary `sendMessage` round trip does not.
 */

export interface CacheStatsRequest {
  kind: 'cache-stats';
}

export interface ClearCacheRequest {
  kind: 'clear-cache';
}

export type Request = CacheStatsRequest | ClearCacheRequest;

export type ErrorCode =
  | 'rate-limit'
  | 'not-found'
  | 'network'
  | 'auth'
  /** No token stored, or the stored one was rejected and has just been discarded. */
  | 'no-token'
  /** The token needs authorising for an SSO-protected organisation. */
  | 'sso';

export type Response<T> =
  | { ok: true; data: T }
  /** `resetAt` is epoch seconds, present for rate-limit errors. */
  | { ok: false; error: string; code?: ErrorCode; resetAt?: number };

export async function sendRequest<T>(request: Request): Promise<Response<T>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- `sendMessage` is typed `any`; without this the caller gets `any` back.
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

export type AnalyzePhase = 'resolving' | 'listing' | 'counting';

export type AnalyzeEvent =
  | { kind: 'progress'; phase: AnalyzePhase; done: number; total: number }
  /** Totals so far, so the panel fills in while the run is still going. */
  | { kind: 'partial'; stats: RepoStats; done: number; total: number }
  | { kind: 'result'; stats: RepoStats; failures: number }
  | { kind: 'error'; message: string; code?: ErrorCode; resetAt?: number };
