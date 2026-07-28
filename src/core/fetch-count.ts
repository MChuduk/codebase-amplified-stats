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
    throw new HttpError(response.status, `HTTP ${response.status}`);
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
      // rather than let mojibake pollute the counts.
      if (scanned < NUL_SCAN_BYTES && value.includes(0)) return null;
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

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Retries throttled and transient failures with exponential backoff and jitter. */
async function withRetry<T>(
  attempt: () => Promise<T>,
  options: { retries: number; signal?: AbortSignal },
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

      const backoff = Math.min(2 ** tryIndex * 500, 8000);
      const jitter = Math.random() * 250;
      await sleep(backoff + jitter, options.signal);
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
  results: FileResult[];
  failures: FetchFailure[];
}

/**
 * Downloads and counts a list of files with bounded concurrency.
 *
 * Workers pull from a shared cursor rather than taking a pre-assigned slice, so one
 * worker landing on a run of large files does not stall the whole batch.
 */
export async function countFiles(
  files: CountableFile[],
  options: CountOptions,
): Promise<CountBatchResult> {
  const results: FileResult[] = [];
  const failures: FetchFailure[] = [];
  let cursor = 0;
  let done = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;

      const index = cursor++;
      const file = files[index];
      if (!file) return;

      try {
        const result = await withRetry(
          () => countFile(file, { repo: options.repo, commitSha: options.commitSha, signal: options.signal }),
          { retries: 3, signal: options.signal },
        );
        if (result) results.push(result);
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

  return { results, failures };
}
