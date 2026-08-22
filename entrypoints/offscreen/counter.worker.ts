/// <reference lib="webworker" />
import { countBytes } from '../../src/core/counter';
import type { FileResult } from '../../src/core/aggregate';
import type { CountableFile } from '../../src/core/types';

/**
 * The host unpacks the archive and transfers each file's bytes here, so this side does no
 * I/O at all. Being pure CPU is the only reason these workers exist.
 */

export interface BlobJob {
  kind: 'blob';
  id: number;
  file: CountableFile;
  bytes: Uint8Array;
}

/** `result` is null for a binary file; `error` is set only when counting threw. */
export type WorkerMessage = {
  kind: 'blob-done';
  id: number;
  result: FileResult | null;
  error?: string;
};

const post = (message: WorkerMessage) => self.postMessage(message);

self.onmessage = (event: MessageEvent<BlobJob>) => {
  const job = event.data;
  if (job?.kind !== 'blob') return;

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
};
