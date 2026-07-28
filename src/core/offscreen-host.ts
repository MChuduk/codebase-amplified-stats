import type {
  OffscreenProgress,
  OffscreenRequest,
  OffscreenResponse,
} from './offscreen-protocol';
import type { FileResult } from './aggregate';
import type { FetchFailure } from './fetch-count';
import type { CountableFile, RepoRef } from './types';

/** WXT flattens `entrypoints/offscreen/index.html` to `offscreen.html` in the output. */
const OFFSCREEN_PATH = 'offscreen.html';

/**
 * Ensures exactly one offscreen document exists.
 *
 * Chrome allows only one per extension and throws if you create a second, so concurrent
 * callers share a single in-flight creation promise.
 */
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const existing = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = browser.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS'],
        justification:
          'Counting lines of code across thousands of files needs Web Workers, which a service worker cannot create.',
      })
      .finally(() => {
        creating = null;
      });
  }

  await creating;
}

async function closeOffscreen(): Promise<void> {
  try {
    await browser.offscreen.closeDocument();
  } catch {
    // Already closed, or never opened — nothing to clean up.
  }
}

export interface CountJobOptions {
  repo: RepoRef;
  commitSha: string;
  files: CountableFile[];
  concurrency: number;
  onProgress?: (done: number, total: number) => void;
}

export interface CountJobResult {
  results: FileResult[];
  failures: FetchFailure[];
}

/**
 * Runs a counting job in the offscreen document, forwarding progress as it arrives.
 * The document is torn down when the job ends, however it ends.
 */
export async function runCountJob(options: CountJobOptions): Promise<CountJobResult> {
  const jobId = crypto.randomUUID();

  const onProgressMessage = (message: unknown) => {
    const progress = message as OffscreenProgress;
    if (progress?.target !== 'background' || progress.jobId !== jobId) return;
    options.onProgress?.(progress.done, progress.total);
  };

  browser.runtime.onMessage.addListener(onProgressMessage);

  try {
    await ensureOffscreen();

    const request: OffscreenRequest = {
      target: 'offscreen',
      kind: 'count',
      jobId,
      repo: options.repo,
      commitSha: options.commitSha,
      files: options.files,
      concurrency: options.concurrency,
    };

    const response = (await browser.runtime.sendMessage(request)) as OffscreenResponse;

    if (!response) throw new Error('Offscreen document gave no response');
    if (response.kind === 'failed') throw new Error(response.message);

    return { results: response.results, failures: response.failures };
  } finally {
    browser.runtime.onMessage.removeListener(onProgressMessage);
    await closeOffscreen();
  }
}
