import type {
  OffscreenProgress,
  OffscreenRequest,
  OffscreenResponse,
} from '../../src/messaging/offscreen-protocol';
import type { BlobJob, WorkerMessage } from './counter.worker';
import type { FileResult } from '../../src/logic/aggregate';
import type { CountFailure } from '../../src/logic/counter';
import { readTarball } from '../../src/logic/tar';
import { providerFor } from '../../src/providers/registry';
import type { CountableFile } from '../../src/logic/interfaces';

/**
 * Host page for the counting workers.
 *
 * This exists because an MV3 service worker cannot call `new Worker()`, and would in any
 * case risk being torn down mid-run. The offscreen document stays alive for exactly as
 * long as the job does. It also downloads and unpacks the archive, handing workers only
 * the bytes of files worth counting.
 */

const MAX_WORKERS = 8;

/** Unpacked bytes handed to workers but not yet counted. Caps memory on a large archive. */
const MAX_INFLIGHT_BYTES = 32 * 1024 * 1024;

/** How often counted files are shipped back to the background worker. */
const FLUSH_INTERVAL_MS = 500;

browser.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: OffscreenResponse) => void) => {
    const request = message as OffscreenRequest;
    if (request?.target !== 'offscreen') return false;

    // `runJob` answers its own failures, but a reply must go out no matter what — the
    // caller is blocked on this message and has nothing else to time out against.
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
  const reporter = new Reporter(request.jobId, request.files.length);

  try {
    const outcome = await runTarballJob(request, reporter);
    await reporter.finish();
    return { kind: 'completed', ...outcome };
  } catch (error) {
    // Ship what was counted before giving up; the caller banks it either way.
    await reporter.finish();
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function spawnWorker(): Worker {
  return new Worker(new URL('./counter.worker.ts', import.meta.url), { type: 'module' });
}

function poolSize(files: number): number {
  return Math.max(1, Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 2, files));
}

/**
 * The tar is walked here rather than in a worker: unpacking is little more than arithmetic
 * over offsets, and gzip is inflated natively by the stream. Only the bytes of wanted
 * files are assembled, and those go straight to a worker as a transferable.
 */
async function runTarballJob(
  request: OffscreenRequest,
  reporter: Reporter,
): Promise<{ failures: CountFailure[]; binaries: string[] }> {
  const wanted = new Map(request.files.map((file) => [file.path, file]));
  const failures: CountFailure[] = [];
  const binaries: string[] = [];
  let done = 0;

  const archive = providerFor(request.repo.provider).archiveRequest(
    request.repo,
    request.commitSha,
    request.token,
  );
  const response = await fetch(archive.url, { headers: archive.headers });

  if (!response.ok) throw new Error(`archive request failed with HTTP ${response.status}`);
  if (!response.body) throw new Error('archive response had no body');

  const pool = new CounterPool(poolSize(request.files.length));

  try {
    await readTarball(response.body, async (entry, read) => {
      const file = wanted.get(entry.path);
      if (!file) return false;
      wanted.delete(entry.path);

      const bytes = await read();

      pool.submit(file, bytes, (result, error) => {
        if (error) failures.push({ path: file.path, reason: error });
        else if (result) reporter.add([result]);
        else binaries.push(file.sha);

        done += 1;
        reporter.setDone(done);
        reporter.maybeFlush();
      });

      // Read no further until the workers have caught up, or unpacking outruns counting
      // and the whole repository ends up in memory at once.
      await pool.settle(MAX_INFLIGHT_BYTES);
      return true;
    });

    await pool.settle(0);
  } finally {
    pool.terminate();
  }

  // Anything the tree listed but the archive did not carry — a submodule, say. Reported
  // rather than quietly dropped, so the count is never silently short.
  for (const file of wanted.values()) {
    failures.push({ path: file.path, reason: 'not present in the repository archive' });
  }

  reporter.setDone(request.files.length);
  return { failures, binaries };
}

type BlobDone = (result: FileResult | null, error?: string) => void;

/**
 * A pool of counting workers fed one unpacked file at a time.
 *
 * Work goes to whichever worker has the least outstanding, and `settle` gives the
 * producer a way to wait for the pool to drain below a byte budget.
 */
class CounterPool {
  private readonly workers: Worker[];
  private readonly load: number[];
  private readonly handlers = new Map<number, BlobDone>();
  private nextId = 0;
  private inflight = 0;
  private release: (() => void) | null = null;
  private crashed: Error | null = null;

  constructor(size: number) {
    this.workers = Array.from({ length: size }, () => spawnWorker());
    this.load = new Array<number>(size).fill(0);

    this.workers.forEach((worker, index) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;

        this.load[index] = (this.load[index] ?? 1) - 1;
        const handler = this.handlers.get(message.id);
        this.handlers.delete(message.id);
        handler?.(message.result, message.error);
      };

      worker.onerror = (event) => {
        this.crashed = new Error(event.message || 'Worker crashed');
        this.release?.();
      };
    });
  }

  submit(file: CountableFile, bytes: Uint8Array, onDone: BlobDone): void {
    const id = this.nextId++;
    const size = bytes.byteLength;

    let lightest = 0;
    for (let i = 1; i < this.load.length; i++) {
      if (this.load[i]! < this.load[lightest]!) lightest = i;
    }

    this.load[lightest]! += 1;
    this.inflight += size;

    this.handlers.set(id, (result, error) => {
      this.inflight -= size;
      onDone(result, error);
      this.release?.();
    });

    const job: BlobJob = { kind: 'blob', id, file, bytes };
    this.workers[lightest]!.postMessage(job, [bytes.buffer]);
  }

  /** Resolves once the bytes handed out but not yet counted are at or below `limit`. */
  async settle(limit: number): Promise<void> {
    while (this.inflight > limit) {
      if (this.crashed) throw this.crashed;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      this.release = null;
    }

    if (this.crashed) throw this.crashed;
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
  }
}

/* ---------- Reporting ---------- */

/**
 * Batches counted files back to the background worker.
 *
 * Sends are chained rather than fired off, so batches arrive in the order they were
 * produced and the final one has definitely landed before the job reports completion.
 */
class Reporter {
  private pending: FileResult[] = [];
  private done = 0;
  private lastFlush = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly jobId: string,
    private readonly total: number,
  ) {}

  add(results: FileResult[]): void {
    if (results.length > 0) this.pending.push(...results);
  }

  setDone(done: number): void {
    this.done = done;
  }

  maybeFlush(): void {
    if (Date.now() - this.lastFlush < FLUSH_INTERVAL_MS) return;
    this.flush();
  }

  /** Sends the last batch and waits for every send to have been taken. */
  finish(): Promise<void> {
    this.flush();
    return this.chain;
  }

  private flush(): void {
    this.lastFlush = Date.now();

    const results = this.pending;
    this.pending = [];

    const message: OffscreenProgress = {
      target: 'background',
      kind: 'progress',
      jobId: this.jobId,
      done: this.done,
      total: this.total,
      results,
    };

    // A rejected send means the background is gone, which the job's own teardown handles;
    // swallowing it here keeps the chain alive so later batches still get their turn.
    this.chain = this.chain.then(() =>
      browser.runtime.sendMessage(message).then(
        () => {},
        () => {},
      ),
    );
  }
}
