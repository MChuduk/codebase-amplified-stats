import {
  ANALYZE_PORT,
  type AnalyzeEvent,
  type AnalyzeStart,
  type ErrorCode,
  type Request,
  type Response,
} from '../src/messaging/messages';
import { ProviderError } from '../src/common';
import type { ProviderId, RepoRef } from '../src/common';
import { providerFor } from '../src/providers/registry';
import { filterTree } from '../src/logic/filter';
import { disambiguate } from '../src/logic/disambiguate';
import { buildRepoStats, type FileResult } from '../src/logic/aggregate';
import { runCountJob } from '../src/messaging/offscreen-host';
import * as cache from '../src/logic/cache';
import { claimCacheCleanup, getToken, setToken } from '../src/logic/settings';
import type { CountableFile } from '../src/logic/interfaces';

class NoTokenError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NoTokenError';
  }
}

async function requireToken(repo: RepoRef): Promise<string> {
  const token = await getToken(repo.provider);
  if (!token) throw new NoTokenError();
  return token;
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: Response<unknown>) => void) => {
      const request = message as Request;
      if (!request || typeof request.kind !== 'string') return false;
      // Messages addressed to the offscreen document travel on the same bus.
      if ('target' in request) return false;

      handle(request)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(toErrorResponse(error, null)));

      // Returning true keeps the message channel open for the async response.
      return true;
    },
  );

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== ANALYZE_PORT) return;

    const controller = new AbortController();
    port.onDisconnect.addListener(() => controller.abort());

    port.onMessage.addListener((message: unknown) => {
      const start = message as AnalyzeStart;
      if (start?.kind !== 'analyze') return;

      const send = (event: AnalyzeEvent) => {
        try {
          port.postMessage(event);
        } catch {
          // The tab navigated away mid-run; the disconnect listener handles the rest.
        }
      };

      void analyze(start, controller.signal, send).catch((error: unknown) => {
        const response = toErrorResponse(error, start.repo.provider);
        send({
          kind: 'error',
          message: response.error,
          code: response.code,
          ...(response.resetAt ? { resetAt: response.resetAt } : {}),
        });
      });
    });
  });
});

/** `provider` is null for requests that touch no host, such as the cache ones. */
function toErrorResponse(
  error: unknown,
  provider: ProviderId | null,
): { ok: false; error: string; code?: ErrorCode; resetAt?: number } {
  if (error instanceof NoTokenError) {
    return { ok: false, error: error.message, code: 'no-token' };
  }

  if (error instanceof ProviderError) {
    // Keeping a token the host has rejected only makes every later request fail the same
    // way, until the user happens to open the options page.
    if (error.status === 401 && provider) {
      void setToken(provider, null);
      return { ok: false, error: 'Your sign-in expired. Sign in again.', code: 'no-token' };
    }

    return {
      ok: false,
      error: error.message,
      code: error.code === 'server' ? 'network' : error.code,
      ...(error.resetAt ? { resetAt: error.resetAt } : {}),
    };
  }

  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function handle(request: Request): Promise<unknown> {
  switch (request.kind) {
    case 'cache-stats':
      return cache.cacheStats();
    case 'clear-cache':
      return cache.clearCache();
    case 'open-options':
      return browser.runtime.openOptionsPage();
  }
}

type Resolved = Awaited<ReturnType<typeof resolveUncached>>;

/**
 * Short-lived cache of resolved repositories.
 *
 * Each resolve costs three API requests. Without this, every re-mount of the panel — and
 * the host re-renders its sidebar often — spent three again, all to learn the same commit
 * SHA over and over.
 */
const RESOLVE_TTL_MS = 10 * 60 * 1000;
const resolveCache = new Map<string, { at: number; value: Promise<Resolved> }>();
const resolveKey = (repo: RepoRef) =>
  `${repo.provider}:${repo.owner}/${repo.repo}@${repo.ref ?? ''}`;

function resolve(repo: RepoRef, token: string): Promise<Resolved> {
  const key = resolveKey(repo);
  const cached = resolveCache.get(key);

  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.value;

  // Stored as a promise so concurrent callers share one set of requests rather than
  // racing and each spending their own three.
  const value = resolveUncached(repo, token);
  const entry = { at: Date.now(), value };
  resolveCache.set(key, entry);

  // A failed lookup must not be cached, or a transient error sticks for ten minutes.
  value.catch(() => {
    if (resolveCache.get(key) === entry) resolveCache.delete(key);
  });

  // Bound the map; this is a service worker that can live for a long time.
  if (resolveCache.size > 50) {
    const oldest = [...resolveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) resolveCache.delete(oldest[0]);
  }

  return value;
}

/** Resolves a repository to a commit and the list of files worth counting. */
async function resolveUncached(repo: RepoRef, token: string) {
  const provider = providerFor(repo.provider);
  let branch = repo.ref;
  let commitSha: string;

  if (branch) {
    commitSha = await provider.fetchCommitSha(repo, branch, token);
  } else {
    // HEAD lets us look up the commit while the default branch name is still loading.
    const [info, headSha] = await Promise.all([
      provider.fetchRepoInfo(repo, token),
      provider.fetchCommitSha(repo, 'HEAD', token).catch(() => null),
    ]);
    branch = info.defaultBranch;
    commitSha = headSha ?? (await provider.fetchCommitSha(repo, branch, token));
  }

  const tree = await provider.fetchTree(repo, commitSha, token);

  const filtered = filterTree(tree.entries);
  const { files } = disambiguate(filtered.files);

  return {
    branch,
    commitSha,
    files,
    skippedByReason: filtered.skippedByReason,
    truncated: tree.truncated,
  };
}

/**
 * Blob SHAs make the cache check exact across commits, branches and forks, but with a
 * whole-archive download that saves counting rather than bandwidth — except when a commit
 * turns out to be fully covered, in which case no archive is fetched at all.
 */
async function analyze(
  start: AnalyzeStart,
  signal: AbortSignal,
  emit: (event: AnalyzeEvent) => void,
): Promise<void> {
  const { repo } = start;

  // `resolve` may answer from its cache without ever touching storage, so read it here.
  const token = await requireToken(repo);

  // "Refresh" must see new commits, so it bypasses the resolve cache too. It deliberately
  // leaves `blobStats` alone: a blob SHA is a hash of the file's contents, so a cached
  // count for one is correct by construction and re-downloading to redo it buys nothing.
  if (start.force) resolveCache.delete(resolveKey(repo));

  emit({ kind: 'progress', phase: 'resolving', done: 0, total: 0 });
  const resolved = await resolve(repo, token);
  if (signal.aborted) return;

  if (!start.force) {
    const cached = await cache.getRepoRun(repo, resolved.commitSha);
    if (cached) {
      emit({ kind: 'result', stats: { ...cached, branch: resolved.branch }, failures: 0 });
      return;
    }
  }

  emit({ kind: 'progress', phase: 'listing', done: 0, total: resolved.files.length });

  // Reuse everything already counted, whatever commit or repository it came from —
  // including blobs previously found to be binary, which are worth nothing to re-count.
  const known = await cache.getBlobStats(resolved.files.map((file) => file.sha));
  if (signal.aborted) return;
  const cachedResults: FileResult[] = [];
  const toDownload: CountableFile[] = [];

  for (const file of resolved.files) {
    const record = known.get(file.sha);
    if (!record) toDownload.push(file);
    else if (!record.binary) cachedResults.push({ ...file, stats: record.stats });
  }

  emit({
    kind: 'progress',
    phase: 'counting',
    done: cachedResults.length,
    total: resolved.files.length,
  });

  // Keyed by path so a batch arriving twice overwrites rather than double-counting.
  const downloaded = new Map<string, FileResult>();
  let failureCount = 0;

  const buildStats = (partial: boolean) =>
    buildRepoStats({
      repo,
      commitSha: resolved.commitSha,
      branch: resolved.branch,
      results: [...cachedResults, ...downloaded.values()],
      skippedByReason: resolved.skippedByReason,
      truncated: resolved.truncated,
      partial,
    });

  if (toDownload.length > 0) {
    const counted = cachedResults.length;

    const job = await runCountJob({
      repo,
      commitSha: resolved.commitSha,
      files: toDownload,
      token,
      onProgress: (done) => {
        emit({
          kind: 'progress',
          phase: 'counting',
          done: counted + done,
          total: resolved.files.length,
        });
      },
      onResults: (batch) => {
        for (const result of batch) downloaded.set(result.path, result);
        // Persisted as it arrives, so a run cut short still leaves the work banked.
        void cache.putBlobStats(batch);
        emit({
          kind: 'partial',
          stats: buildStats(true),
          done: counted + downloaded.size,
          total: resolved.files.length,
        });
      },
    });

    failureCount = job.failures.length;
    void cache.putBinaryBlobs(job.binaries);
  }

  const cachedRecords = cachedResults
    .map((result) => known.get(result.sha))
    .filter((record): record is cache.BlobStatsRecord => record !== undefined);
  void cache.touchBlobStats(cachedRecords);

  const stats = buildStats(failureCount > 0);

  await cache.putRepoRun(stats);
  if (await claimCacheCleanup()) void cache.cleanup();

  emit({ kind: 'result', stats, failures: failureCount });
}
