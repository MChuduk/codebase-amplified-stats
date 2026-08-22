import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FileResult } from './aggregate';
import type { LineStats, RepoStats } from './types';

/**
 * Two-level cache.
 *
 * `blobStats` is keyed by Git blob SHA, a hash of the file's *contents*, which makes it
 * valid across commits, branches and even forks. Since the archive is fetched whole it
 * saves no bandwidth — it saves counting, and lets a fully covered commit skip the
 * download altogether.
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
  /**
   * Set when the blob turned out to be binary despite its extension. Without it the file
   * is decoded and thrown away again on every single run.
   */
  binary?: true;
}

/** Placeholder stats for a binary blob, which contributes nothing to any total. */
const NO_STATS: LineStats = { total: 0, blank: 0, comment: 0, code: 0 };

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

export async function getBlobStats(
  shas: string[],
): Promise<Map<string, BlobStatsRecord>> {
  if (shas.length === 0) return new Map();

  const wanted = [...new Set(shas)].sort();
  const database = await db();
  const transaction = database.transaction('blobStats', 'readonly');
  const store = transaction.objectStore('blobStats');

  const found = new Map<string, BlobStatsRecord>();

  // One directed walk instead of a `get` per SHA. Both are correct, but on a repository
  // with ten thousand files the walk is a single traversal rather than ten thousand
  // round trips into IndexedDB. Blob SHAs are lowercase hex, so JavaScript's string
  // ordering matches IndexedDB's key ordering and the two cursors advance in step.
  let index = 0;
  let cursor = await store.openCursor(IDBKeyRange.lowerBound(wanted[0]!));

  while (cursor && index < wanted.length) {
    const key = cursor.key;
    const target = wanted[index]!;

    if (key === target) {
      found.set(key, cursor.value);
      index += 1;
      cursor = index < wanted.length ? await cursor.continue(wanted[index]!) : null;
    } else if (key < target) {
      cursor = await cursor.continue(target);
    } else {
      // The store jumped past what we asked for: those SHAs are simply not cached.
      while (index < wanted.length && wanted[index]! < key) index += 1;
      if (index === wanted.length) break;
      // Landing exactly on the cursor is handled by re-entering the loop, since
      // `continue` may only be given a key strictly ahead of the current position.
      if (wanted[index] !== key) cursor = await cursor.continue(wanted[index]!);
    }
  }

  await transaction.done;

  return found;
}

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

/** Records blobs that turned out to be binary, so they are never decoded again. */
export async function putBinaryBlobs(shas: string[]): Promise<void> {
  if (shas.length === 0) return;

  const database = await db();
  const transaction = database.transaction('blobStats', 'readwrite');
  const store = transaction.objectStore('blobStats');
  const now = Date.now();

  await Promise.all(
    shas.map((sha) =>
      store.put({ sha, stats: NO_STATS, language: '', lastUsed: now, binary: true }),
    ),
  );
  await transaction.done;
}

/** Entries are only re-stamped once a day; finer granularity buys nothing but writes. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Refreshes `lastUsed` so entries in active use survive eviction. Takes the records the
 * caller already read rather than SHAs, and skips anything stamped recently — on a warm
 * repository that usually means no writes at all.
 */
export async function touchBlobStats(records: BlobStatsRecord[]): Promise<void> {
  const now = Date.now();
  const stale = records.filter((record) => now - record.lastUsed > TOUCH_INTERVAL_MS);
  if (stale.length === 0) return;

  const database = await db();
  const transaction = database.transaction('blobStats', 'readwrite');
  const store = transaction.objectStore('blobStats');

  await Promise.all(stale.map((record) => store.put({ ...record, lastUsed: now })));
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
