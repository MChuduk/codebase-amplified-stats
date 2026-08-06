/// <reference lib="webworker" />
import { countBytes, countFiles } from '../../src/core/fetch-count';
import type { FileResult } from '../../src/core/aggregate';
import type { FetchFailure } from '../../src/core/fetch-count';
import type { CountableFile, RepoRef } from '../../src/core/types';

/**
 * Counts files, either fetching them itself or taking bytes it is handed.
 *
 * On the per-file path the worker fetches on its own so the text never crosses a thread
 * boundary — only the small result objects do. On the archive path the host has already
 * unpacked the bytes, so they arrive as a transferable instead.
 */

export interface FetchJob {
  kind: 'job';
  repo: RepoRef;
  commitSha: string;
  files: CountableFile[];
  concurrency: number;
}

/** One file already unpacked from the repository archive. */
export interface BlobJob {
  kind: 'blob';
  id: number;
  file: CountableFile;
  bytes: Uint8Array;
}

export type WorkerJob = FetchJob | BlobJob;

export type WorkerMessage =
  | { kind: 'progress'; done: number; results: FileResult[] }
  | { kind: 'done'; results: FileResult[]; failures: FetchFailure[]; binaries: string[] }
  /** `result` is null for a binary file; `error` is set only when counting threw. */
  | { kind: 'blob-done'; id: number; result: FileResult | null; error?: string }
  | { kind: 'error'; message: string };

const post = (message: WorkerMessage) => self.postMessage(message);

self.onmessage = (event: MessageEvent<WorkerJob>) => {
  const job = event.data;

  if (job?.kind === 'job') void runFetchJob(job);
  else if (job?.kind === 'blob') runBlobJob(job);
};

function runBlobJob(job: BlobJob): void {
  try {
    post({ kind: 'blob-done', id: job.id, result: countBytes(job.file, job.bytes) });
  } catch (error) {
    post({
      kind: 'blob-done',
      id: job.id,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runFetchJob(job: FetchJob): Promise<void> {
  try {
    // Results ride along with progress, at most every 150 ms — a message per file would
    // cost more than the counting does on small files.
    let lastReport = 0;
    let batch: FileResult[] = [];

    const { failures, binaries } = await countFiles(job.files, {
      repo: job.repo,
      commitSha: job.commitSha,
      concurrency: job.concurrency,
      onResult: (result) => batch.push(result),
      onProgress: (done) => {
        if (Date.now() - lastReport < 150) return;
        lastReport = Date.now();
        const results = batch;
        batch = [];
        post({ kind: 'progress', done, results });
      },
    });

    // Whatever the timer never got to goes out with the final message, so no result
    // depends on a flush having happened to fire.
    post({ kind: 'done', results: batch, failures, binaries });
  } catch (error) {
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}
