import { LineCounter } from './counter';
import { syntaxFor } from './comment-syntax';
import { rawUrl } from './github-api';
import type { FileResult } from './aggregate';
import type { CountableFile, RepoRef } from './types';

/** Files larger than this are read as one chunk; smaller reads gain nothing from streaming. */
const NUL_SCAN_BYTES = 8192;

export interface FetchFailure {
  path: string;
  reason: string;
}

export interface CountOptions {
  repo: RepoRef;
  commitSha: string;
  /** Simultaneous requests. Kept modest — the raw CDN throttles aggressive clients. */
  concurrency: number;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
  /** Called as each file finishes, so results stream out instead of piling up. */
  onResult: (result: FileResult) => void;
}

/**
 * Downloads one file and counts it without ever holding the whole text in memory.
 * Returns null when the file turns out to be binary.
 */
export async function countFile(
  file: CountableFile,
  options: { repo: RepoRef; commitSha: string; signal?: AbortSignal },
): Promise<FileResult | null> {
  const response = await fetch(rawUrl(options.repo, options.commitSha, file.path), {
    signal: options.signal,
  });

  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}`, retryAfterMs(response.headers));
  }

  const counter = new LineCounter(syntaxFor(file.language));
  const decoder = new TextDecoder('utf-8', { fatal: false });

  if (!response.body) {
    const text = await response.text();
    if (hasNulByte(text)) return null;
    counter.push(text);
    return { ...file, stats: counter.finish() };
  }

  const reader = response.body.getReader();
  let scanned = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      // A NUL byte early in the file means it is binary despite its extension. Bail out
      // rather than let mojibake pollute the counts. The window is measured in bytes from
      // the start of the file, not in whole chunks, so that where the stream happens to
      // break cannot change the verdict — and so `countBytes` reaches the same one.
      if (scanned < NUL_SCAN_BYTES && value.subarray(0, NUL_SCAN_BYTES - scanned).includes(0)) {
        return null;
      }
      scanned += value.byteLength;

      counter.push(decoder.decode(value, { stream: true }));
    }
    counter.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  return { ...file, stats: counter.finish() };
}

function hasNulByte(text: string): boolean {
  return text.slice(0, NUL_SCAN_BYTES).includes('\u0000');
}

/**
 * Counts a file whose bytes are already in memory.
 *
 * The tarball path unpacks whole files at once, so there is nothing to stream. Shares the
 * binary detection and counting rules with `countFile` so both paths produce identical
 * numbers for identical content.
 */
export function countBytes(file: CountableFile, bytes: Uint8Array): FileResult | null {
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) return null;

  const counter = new LineCounter(syntaxFor(file.language));
  counter.push(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  return { ...file, stats: counter.finish() };
}

/** A throttled server tells us how long to wait; cap it so a bad header cannot stall a run. */
const MAX_RETRY_AFTER_MS = 60_000;

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);

  // The header may also be an HTTP date.
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Milliseconds the server asked us to wait, from `Retry-After`. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Retries throttled and transient failures with exponential backoff and jitter. */
async function withRetry<T>(
  attempt: () => Promise<T>,
  options: {
    retries: number;
    signal?: AbortSignal;
    /** Called when the CDN throttles us, with the epoch millis to hold off until. */
    onThrottle?: (until: number) => void;
  },
): Promise<T> {
  let lastError: unknown;

  for (let tryIndex = 0; tryIndex <= options.retries; tryIndex++) {
    if (options.signal?.aborted) throw new Error('aborted');
    try {
      return await attempt();
    } catch (error) {
      lastError = error;

      // 404s and other client errors will not fix themselves.
      const status = error instanceof HttpError ? error.status : 0;
      const retriable = status === 0 || status === 429 || status >= 500;
      if (!retriable || tryIndex === options.retries) break;

      const asked = error instanceof HttpError ? error.retryAfter : undefined;
      const backoff = asked ?? Math.min(2 ** tryIndex * 500, 8000);
      const delay = backoff + Math.random() * 250;

      // A 429 is aimed at the client, not at this one file, so tell the whole batch.
      if (status === 429) options.onThrottle?.(Date.now() + delay);

      await sleep(delay, options.signal);
    }
  }

  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export interface CountBatchResult {
  failures: FetchFailure[];
  /** Blob SHAs that turned out to be binary, so they are never downloaded again. */
  binaries: string[];
}

/**
 * Downloads and counts a list of files with bounded concurrency.
 *
 * Workers pull from a shared cursor rather than taking a pre-assigned slice, so one
 * worker landing on a run of large files does not stall the whole batch. Counted files
 * are handed to `onResult` as they land rather than returned in a lump — the caller
 * forwards them upstream so the panel can fill in while the run is still going.
 */
export async function countFiles(
  files: CountableFile[],
  options: CountOptions,
): Promise<CountBatchResult> {
  const failures: FetchFailure[] = [];
  const binaries: string[] = [];
  let cursor = 0;
  let done = 0;

  // Shared across runners: when one of them is throttled, the rest back off too rather
  // than keep hammering and extend the block.
  let pauseUntil = 0;
  const onThrottle = (until: number) => {
    if (until > pauseUntil) pauseUntil = until;
  };

  const runner = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;

      const wait = pauseUntil - Date.now();
      if (wait > 0) await sleep(wait, options.signal);

      const index = cursor++;
      const file = files[index];
      if (!file) return;

      try {
        const result = await withRetry(
          () => countFile(file, { repo: options.repo, commitSha: options.commitSha, signal: options.signal }),
          { retries: 3, signal: options.signal, onThrottle },
        );
        if (result) options.onResult(result);
        else binaries.push(file.sha);
      } catch (error) {
        failures.push({
          path: file.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      done += 1;
      options.onProgress?.(done);
    }
  };

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, runner);
  await Promise.all(workers);

  return { failures, binaries };
}
