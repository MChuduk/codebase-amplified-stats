import type { WorkerJob, WorkerMessage } from './counter.worker';
import type { FileResult } from '../../src/core/aggregate';
import type { FetchFailure } from '../../src/core/fetch-count';
import type { CountableFile } from '../../src/core/types';
import type { OffscreenRequest, OffscreenResponse } from '../../src/core/offscreen-protocol';

/**
 * Host page for the counting workers.
 *
 * This exists because an MV3 service worker cannot call `new Worker()`, and would in any
 * case risk being torn down mid-run. The offscreen document stays alive for exactly as
 * long as the job does.
 */

const MAX_WORKERS = 4;

browser.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: OffscreenResponse) => void) => {
    const request = message as OffscreenRequest;
    if (request?.target !== 'offscreen') return false;

    void runJob(request).then(sendResponse, (error: unknown) =>
      sendResponse({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    return true;
  },
);

async function runJob(request: OffscreenRequest): Promise<OffscreenResponse> {
  const workerCount = Math.max(
    1,
    Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 2, request.files.length),
  );
  const shares = balance(request.files, workerCount);

  const results: FileResult[] = [];
  const failures: FetchFailure[] = [];
  const progressByWorker = new Array<number>(shares.length).fill(0);
  const total = request.files.length;

  let lastPost = 0;
  const reportProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPost < 150) return;
    lastPost = now;
    const done = progressByWorker.reduce((sum, value) => sum + value, 0);
    void browser.runtime.sendMessage({
      target: 'background',
      kind: 'progress',
      jobId: request.jobId,
      done,
      total,
    });
  };

  await Promise.all(
    shares.map(
      (files, index) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(new URL('./counter.worker.ts', import.meta.url), {
            type: 'module',
          });

          worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
            const message = event.data;
            switch (message.kind) {
              case 'progress':
                progressByWorker[index] = message.done;
                reportProgress();
                break;
              case 'done':
                results.push(...message.results);
                failures.push(...message.failures);
                worker.terminate();
                resolve();
                break;
              case 'error':
                worker.terminate();
                reject(new Error(message.message));
                break;
            }
          };

          worker.onerror = (event) => {
            worker.terminate();
            reject(new Error(event.message || 'Worker crashed'));
          };

          const job: WorkerJob = {
            kind: 'job',
            repo: request.repo,
            commitSha: request.commitSha,
            files,
            concurrency: request.concurrency,
          };
          worker.postMessage(job);
        }),
    ),
  );

  reportProgress(true);
  return { kind: 'completed', results, failures };
}

/**
 * Splits files across workers by total bytes rather than count, so one worker landing on
 * all the large files does not hold up the run. Greedy longest-first bin packing.
 */
function balance(files: CountableFile[], bins: number): CountableFile[][] {
  const shares: CountableFile[][] = Array.from({ length: bins }, () => []);
  const loads = new Array<number>(bins).fill(0);

  for (const file of [...files].sort((a, b) => b.size - a.size)) {
    let lightest = 0;
    for (let i = 1; i < bins; i++) {
      if (loads[i]! < loads[lightest]!) lightest = i;
    }
    shares[lightest]!.push(file);
    loads[lightest]! += file.size;
  }

  return shares;
}
