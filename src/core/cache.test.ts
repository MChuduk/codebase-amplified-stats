import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCache,
  getBlobStats,
  putBinaryBlobs,
  putBlobStats,
  touchBlobStats,
  type BlobStatsRecord,
} from './cache';
import type { FileResult } from './aggregate';

function result(sha: string): FileResult {
  return {
    path: `${sha}.ts`,
    sha,
    size: 10,
    language: 'TypeScript',
    category: 'code',
    stats: { total: 3, blank: 1, comment: 1, code: 1 },
  };
}

/** Blob SHAs are 40 lowercase hex characters; the lookup relies on that ordering. */
function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

beforeEach(async () => {
  await clearCache();
});

describe('getBlobStats', () => {
  it('returns nothing for an empty request', async () => {
    expect(await getBlobStats([])).toEqual(new Map());
  });

  it('finds every stored SHA and skips the ones absent', async () => {
    await putBlobStats([sha(2), sha(4), sha(6)].map(result));

    const found = await getBlobStats([sha(1), sha(2), sha(3), sha(4), sha(5), sha(6), sha(7)]);

    expect([...found.keys()].sort()).toEqual([sha(2), sha(4), sha(6)]);
    expect(found.get(sha(4))?.stats.code).toBe(1);
  });

  it('is unaffected by the order it is asked in, or by duplicates', async () => {
    await putBlobStats([sha(1), sha(5), sha(9)].map(result));

    const found = await getBlobStats([sha(9), sha(5), sha(9), sha(1), sha(5)]);

    expect([...found.keys()].sort()).toEqual([sha(1), sha(5), sha(9)]);
  });

  it('agrees with a plain lookup over a large random sample', async () => {
    const stored = Array.from({ length: 500 }, (_, i) => sha(i * 3));
    await putBlobStats(stored.map(result));

    const asked = Array.from({ length: 400 }, () => sha(Math.floor(Math.random() * 1500)));
    const expected = new Set(asked.filter((value) => stored.includes(value)));

    const found = await getBlobStats(asked);

    expect(new Set(found.keys())).toEqual(expected);
  });

  it('handles a request that starts and ends outside the stored range', async () => {
    await putBlobStats([sha(100), sha(200)].map(result));

    const found = await getBlobStats([sha(1), sha(100), sha(999)]);

    expect([...found.keys()]).toEqual([sha(100)]);
  });
});

describe('putBinaryBlobs', () => {
  it('marks blobs so they are recognised without being re-counted', async () => {
    await putBinaryBlobs([sha(7)]);

    const found = await getBlobStats([sha(7)]);

    expect(found.get(sha(7))?.binary).toBe(true);
  });
});

describe('touchBlobStats', () => {
  it('leaves recently used records alone', async () => {
    await putBlobStats([result(sha(1))]);
    const before = (await getBlobStats([sha(1)])).get(sha(1))!;

    await touchBlobStats([before]);

    const after = (await getBlobStats([sha(1)])).get(sha(1))!;
    expect(after.lastUsed).toBe(before.lastUsed);
  });

  it('re-stamps records that have gone stale', async () => {
    await putBlobStats([result(sha(1))]);
    const stored = (await getBlobStats([sha(1)])).get(sha(1))!;

    const stale: BlobStatsRecord = {
      ...stored,
      lastUsed: Date.now() - 30 * 24 * 60 * 60 * 1000,
    };
    await touchBlobStats([stale]);

    const after = (await getBlobStats([sha(1)])).get(sha(1))!;
    expect(after.lastUsed).toBeGreaterThan(stale.lastUsed);
  });
});
