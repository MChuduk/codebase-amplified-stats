import type {
  OffscreenProgress,
  OffscreenRequest,
  OffscreenResponse,
} from './offscreen-protocol';
import type { FileResult } from './aggregate';
import type { CountFailure } from './counter';
import type { CountableFile, RepoRef } from './types';

/** WXT flattens `entrypoints/offscreen/index.html` to `offscreen.html` in the output. */
const OFFSCREEN_PATH = 'offscreen.html';

/** Chrome allows one offscreen document per extension and throws on a second, so
 *  concurrent callers share a single in-flight creation promise. */
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
  /** Passed on to the offscreen document, which authenticates the archive request. */
  token: string;
  onProgress?: (done: number, total: number) => void;
  /** Counted files, in batches, as the job produces them. */
  onResults?: (results: FileResult[]) => void;
}

export interface CountJobResult {
  failures: CountFailure[];
  /** Blob SHAs that turned out to be binary. */
  binaries: string[];
}

export class CountJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountJobError';
  }
}

/**
 * Runs a counting job in the offscreen document, forwarding progress and results as they
 * arrive. The document is torn down when the job ends, however it ends.
 */
export async function runCountJob(options: CountJobOptions): Promise<CountJobResult> {
  const jobId = crypto.randomUUID();

  const onProgressMessage = (
    message: unknown,
    _sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => {
    const progress = message as OffscreenProgress;
    if (progress?.target !== 'background' || progress.jobId !== jobId) return false;

    options.onProgress?.(progress.done, progress.total);
    if (progress.results.length > 0) options.onResults?.(progress.results);

    // Acknowledged so the offscreen document knows the batch landed and can send the
    // next one; without this its sends would race and results could arrive out of order.
    sendResponse({ ok: true });
    return false;
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
      token: options.token,
    };

    const response = (await browser.runtime.sendMessage(request)) as OffscreenResponse;

    if (!response) throw new CountJobError('Offscreen document gave no response');
    if (response.kind === 'failed') throw new CountJobError(response.message);

    return { failures: response.failures, binaries: response.binaries };
  } finally {
    browser.runtime.onMessage.removeListener(onProgressMessage);
    await closeOffscreen();
  }
}
