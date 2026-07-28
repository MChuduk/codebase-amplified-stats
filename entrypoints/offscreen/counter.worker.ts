/// <reference lib="webworker" />
import { countFiles } from '../../src/core/fetch-count';
import type { FileResult } from '../../src/core/aggregate';
import type { FetchFailure } from '../../src/core/fetch-count';
import type { CountableFile, RepoRef } from '../../src/core/types';

/**
 * Downloads and counts a share of the repository's files.
 *
 * The worker fetches on its own rather than receiving file contents from the host — the
 * text never crosses a thread boundary, only the small result objects do.
 */

export interface WorkerJob {
  kind: 'job';
  repo: RepoRef;
  commitSha: string;
  files: CountableFile[];
  concurrency: number;
}

export type WorkerMessage =
  | { kind: 'progress'; done: number }
  | { kind: 'done'; results: FileResult[]; failures: FetchFailure[] }
  | { kind: 'error'; message: string };

const post = (message: WorkerMessage) => self.postMessage(message);

self.onmessage = (event: MessageEvent<WorkerJob>) => {
  const job = event.data;
  if (job?.kind !== 'job') return;

  void run(job);
};

async function run(job: WorkerJob): Promise<void> {
  try {
    // Progress is reported at most every 150 ms; a message per file would cost more
    // than the counting does on small files.
    let lastReport = 0;

    const { results, failures } = await countFiles(job.files, {
      repo: job.repo,
      commitSha: job.commitSha,
      concurrency: job.concurrency,
      onProgress: (done) => {
        const now = Date.now();
        if (done === job.files.length || now - lastReport > 150) {
          lastReport = now;
          post({ kind: 'progress', done });
        }
      },
    });

    post({ kind: 'done', results, failures });
  } catch (error) {
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}
