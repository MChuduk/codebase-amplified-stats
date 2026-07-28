import type { FileResult } from './aggregate';
import type { FetchFailure } from './fetch-count';
import type { CountableFile, RepoRef } from './types';

/** Messages between the background service worker and the offscreen worker host. */

export interface OffscreenRequest {
  target: 'offscreen';
  kind: 'count';
  jobId: string;
  repo: RepoRef;
  commitSha: string;
  files: CountableFile[];
  /** Simultaneous requests per worker. */
  concurrency: number;
}

export type OffscreenResponse =
  | { kind: 'completed'; results: FileResult[]; failures: FetchFailure[] }
  | { kind: 'failed'; message: string };

/** Progress pushed from the offscreen document back to the background worker. */
export interface OffscreenProgress {
  target: 'background';
  kind: 'progress';
  jobId: string;
  done: number;
  total: number;
}
