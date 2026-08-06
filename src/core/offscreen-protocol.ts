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
  /** Simultaneous requests per worker. Ignored on the tarball path. */
  concurrency: number;
  /**
   * Pull the whole repository as one archive instead of one request per file. The host
   * reports this back on failure so the caller can retry the cheap way.
   */
  tarball: boolean;
}

export type OffscreenResponse =
  | {
      kind: 'completed';
      failures: FetchFailure[];
      /** Blob SHAs that turned out to be binary. */
      binaries: string[];
    }
  | {
      kind: 'failed';
      message: string;
      /** The archive path broke; the per-file path is untried and worth a go. */
      tarballFailed?: boolean;
    };

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
