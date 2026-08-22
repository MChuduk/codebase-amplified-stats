import type { RepoRef } from '../common';
import type { FileResult } from '../logic/aggregate';
import type { CountFailure } from '../logic/counter';
import type { CountableFile } from '../logic/interfaces';

/** Messages between the background service worker and the offscreen worker host. */

export interface OffscreenRequest {
  target: 'offscreen';
  kind: 'count';
  jobId: string;
  repo: RepoRef;
  commitSha: string;
  files: CountableFile[];
  /**
   * A Web Worker has no access to extension storage, so the token travels with the job.
   * The background is then the only place that ever reads it.
   */
  token: string;
}

export type OffscreenResponse =
  | {
      kind: 'completed';
      failures: CountFailure[];
      /** Blob SHAs that turned out to be binary. */
      binaries: string[];
    }
  | { kind: 'failed'; message: string };

/**
 * Progress pushed from the offscreen document back to the background worker.
 *
 * Counted files ride along in batches rather than waiting for the job to end, so the
 * panel fills in as the run goes and nothing is lost if it is cut short. The background
 * acknowledges each one, which keeps batches ordered and stops the host running ahead.
 */
export interface OffscreenProgress {
  target: 'background';
  kind: 'progress';
  jobId: string;
  done: number;
  total: number;
  /** Files counted since the previous message. */
  results: FileResult[];
}
