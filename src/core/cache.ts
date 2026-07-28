import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FileResult } from './aggregate';
import type { LineStats, RepoStats } from './types';

/**
 * Two-level cache.
 *
 * `blobStats` is keyed by Git blob SHA, which is a hash of the file's *contents*. That
 * makes it valid across commits, branches and even forks: a file that has not changed is
 * never downloaded twice, and pushing one commit re-counts only what that commit touched.
 *
 * `repoRuns` stores whole results per commit so a revisit renders instantly.
 */

const DB_NAME = 'amplified-stats';
const DB_VERSION = 1;

/** Blob entries older than this are evicted; they cost nothing to recompute. */
const BLOB_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Above this many blob entries, the oldest are trimmed on the next cleanup. */
const MAX_BLOB_ENTRIES = 200_000;

export interface BlobStatsRecord {
  /** Git blob SHA. */
  sha: string;
  stats: LineStats;
  /** Language at count time; a re-detection may disagree, so it is stored, not assumed. */
  language: string;
  lastUsed: number;
}

interface CacheSchema extends DBSchema {
  blobStats: {
    key: string;
    value: BlobStatsRecord;
    indexes: { lastUsed: number };
  };
  repoRuns: {
    key: string;
    value: RepoStats & { key: string; lastUsed: number };
    indexes: { lastUsed: number };
  };
}

let dbPromise: Promise<IDBPDatabase<CacheSchema>> | null = null;

function db(): Promise<IDBPDatabase<CacheSchema>> {
  dbPromise ??= openDB<CacheSchema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const blobs = database.createObjectStore('blobStats', { keyPath: 'sha' });
      blobs.createIndex('lastUsed', 'lastUsed');

      const runs = database.createObjectStore('repoRuns', { keyPath: 'key' });
      runs.createIndex('lastUsed', 'lastUsed');
    },
  });
  return dbPromise;
}

const runKey = (owner: string, repo: string, commitSha: string) =>
  `${owner}/${repo}@${commitSha}`;

/** Looks up cached line counts for a set of blob SHAs. */
export async function getBlobStats(
  shas: string[],
): Promise<Map<string, BlobStatsRecord>> {
  if (shas.length === 0) return new Map();

  const database = await db();
  const transaction = database.transaction('blobStats', 'readonly');
  const store = transaction.objectStore('blobStats');

  const found = new Map<string, BlobStatsRecord>();
  await Promise.all(
    shas.map(async (sha) => {
      const record = await store.get(sha);
      if (record) found.set(sha, record);
    }),
  );
  await transaction.done;

  return found;
}

/** Stores line counts for freshly counted files. */
export async function putBlobStats(results: FileResult[]): Promise<void> {
  if (results.length === 0) return;

  const database = await db();
  const transaction = database.transaction('blobStats', 'readwrite');
  const store = transaction.objectStore('blobStats');
  const now = Date.now();

  await Promise.all(
    results.map((result) =>
      store.put({
        sha: result.sha,
        stats: result.stats,
        language: result.language,
        lastUsed: now,
      }),
    ),
  );
  await transaction.done;
}

/** Refreshes `lastUsed` so entries in active use survive eviction. */
export async function touchBlobStats(shas: string[]): Promise<void> {
  if (shas.length === 0) return;

  const database = await db();
  const transaction = database.transaction('blobStats', 'readwrite');
  const store = transaction.objectStore('blobStats');
  const now = Date.now();

  await Promise.all(
    shas.map(async (sha) => {
      const record = await store.get(sha);
      if (record) await store.put({ ...record, lastUsed: now });
    }),
  );
  await transaction.done;
}

export async function getRepoRun(
  owner: string,
  repo: string,
  commitSha: string,
): Promise<RepoStats | null> {
  const database = await db();
  const record = await database.get('repoRuns', runKey(owner, repo, commitSha));
  if (!record) return null;

  // Keep it warm without blocking the read.
  void database.put('repoRuns', { ...record, lastUsed: Date.now() });

  const { key, lastUsed, ...stats } = record;
  void key;
  void lastUsed;
  return stats;
}

export async function putRepoRun(stats: RepoStats): Promise<void> {
  const database = await db();
  await database.put('repoRuns', {
    ...stats,
    key: runKey(stats.owner, stats.repo, stats.commitSha),
    lastUsed: Date.now(),
  });
}

/** Drops stale and surplus entries. Cheap enough to run after each completed job. */
export async function cleanup(): Promise<void> {
  const database = await db();
  const cutoff = Date.now() - BLOB_TTL_MS;

  const transaction = database.transaction('blobStats', 'readwrite');
  const index = transaction.store.index('lastUsed');

  let removed = 0;
  for await (const cursor of index.iterate(IDBKeyRange.upperBound(cutoff))) {
    await cursor.delete();
    removed += 1;
  }

  const remaining = await transaction.store.count();
  if (remaining > MAX_BLOB_ENTRIES) {
    let surplus = remaining - MAX_BLOB_ENTRIES;
    for await (const cursor of index.iterate()) {
      if (surplus <= 0) break;
      await cursor.delete();
      surplus -= 1;
      removed += 1;
    }
  }

  await transaction.done;
}

export interface CacheStats {
  blobs: number;
  runs: number;
}

export async function cacheStats(): Promise<CacheStats> {
  const database = await db();
  return {
    blobs: await database.count('blobStats'),
    runs: await database.count('repoRuns'),
  };
}

export async function clearCache(): Promise<void> {
  const database = await db();
  await Promise.all([database.clear('blobStats'), database.clear('repoRuns')]);
}
