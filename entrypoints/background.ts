import {
  ANALYZE_PORT,
  type AnalyzeEvent,
  type AnalyzeStart,
  type ErrorCode,
  type PreviewRequest,
  type RepoPreview,
  type Request,
  type Response,
} from '../src/core/messages';
import {
  GitHubApiError,
  fetchCommitSha,
  fetchRepoInfo,
  fetchTree,
  getLastRateLimit,
} from '../src/core/github-api';
import { filterTree } from '../src/core/filter';
import { disambiguate } from '../src/core/disambiguate';
import { buildRepoStats, type FileResult } from '../src/core/aggregate';
import { runCountJob } from '../src/core/offscreen-host';
import * as cache from '../src/core/cache';
import { claimCacheCleanup, getSettings, getToken, setToken } from '../src/core/storage';
import type { CountableFile, RepoRef } from '../src/core/types';

/** Thrown before any request goes out when there is no token to make one with. */
class NoTokenError extends Error {
  constructor() {
    super('Sign in to GitHub from the extension options to count repositories.');
    this.name = 'NoTokenError';
  }
}

async function requireToken(): Promise<string> {
  const token = await getToken();
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
        .catch((error: unknown) => sendResponse(toErrorResponse(error)));

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

      void analyze(start, send).catch((error: unknown) => {
        const response = toErrorResponse(error);
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

function toErrorResponse(error: unknown): {
  ok: false;
  error: string;
  code?: ErrorCode;
  resetAt?: number;
} {
  if (error instanceof NoTokenError) {
    return { ok: false, error: error.message, code: 'no-token' };
  }

  if (error instanceof GitHubApiError) {
    // Keeping a token GitHub has rejected only makes every later request fail the same
    // way, until the user happens to open the options page.
    if (error.status === 401) {
      void setToken(null);
      return { ok: false, error: 'Your GitHub sign-in expired. Sign in again.', code: 'no-token' };
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
    case 'preview':
      return preview(request);
    case 'cache-stats':
      return cache.cacheStats();
    case 'clear-cache':
      return cache.clearCache();
  }
}

type Resolved = Awaited<ReturnType<typeof resolveUncached>>;

/**
 * Short-lived cache of resolved repositories.
 *
 * Each resolve costs three API requests. Without this, simply opening a repository page
 * spent three, clicking "Count lines" spent three more, and every re-mount of the panel
 * spent three again — all to learn the same commit SHA over and over.
 */
const RESOLVE_TTL_MS = 10 * 60 * 1000;
const resolveCache = new Map<string, { at: number; value: Promise<Resolved> }>();

function resolve(repo: RepoRef): Promise<Resolved> {
  const key = `${repo.owner}/${repo.repo}`;
  const cached = resolveCache.get(key);

  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.value;

  // Stored as a promise so concurrent callers share one set of requests rather than
  // racing and each spending their own three.
  const value = resolveUncached(repo);
  resolveCache.set(key, { at: Date.now(), value });

  // A failed lookup must not be cached, or a transient error sticks for ten minutes.
  value.catch(() => resolveCache.delete(key));

  // Bound the map; this is a service worker that can live for a long time.
  if (resolveCache.size > 50) {
    const oldest = [...resolveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) resolveCache.delete(oldest[0]);
  }

  return value;
}

/** Resolves a repository to a commit and the list of files worth counting. */
async function resolveUncached(repo: RepoRef) {
  const [token, settings] = await Promise.all([requireToken(), getSettings()]);

  // `HEAD` resolves to the default branch's tip without first having to learn the branch
  // name, so these two run together and the resolve costs two round trips instead of
  // three. The ref spelling is not contractual, so a failure falls back to the explicit
  // branch rather than failing the whole resolve.
  const [info, headSha] = await Promise.all([
    fetchRepoInfo(repo, token),
    fetchCommitSha(repo, 'HEAD', token).catch(() => null),
  ]);

  const commitSha = headSha ?? (await fetchCommitSha(repo, info.defaultBranch, token));
  const tree = await fetchTree(repo, commitSha, token);

  const filtered = filterTree(tree.entries, settings);
  const { files } = disambiguate(filtered.files);

  return {
    branch: info.defaultBranch,
    commitSha,
    sizeKb: info.sizeKb,
    files,
    skippedByReason: filtered.skippedByReason,
    totalBytes: filtered.totalBytes,
    truncated: tree.truncated,
  };
}

/**
 * Works out what counting would involve without downloading anything. Costs three API
 * requests, and answers from cache when this commit has been counted before.
 */
async function preview(request: PreviewRequest): Promise<RepoPreview> {
  const { repo } = request;
  const resolved = await resolve(repo);

  const cached = await cache.getRepoRun(repo.owner, repo.repo, resolved.commitSha);
  const known = await cache.getBlobStats(resolved.files.map((file) => file.sha));

  // The archive is all-or-nothing: either every file is already counted and nothing is
  // downloaded, or the whole repository comes down. Reporting the sum of the uncounted
  // files would understate that, sometimes by a lot.
  const needsDownload = resolved.files.some((file) => !known.has(file.sha));

  return {
    branch: resolved.branch,
    commitSha: resolved.commitSha,
    fileCount: resolved.files.length,
    totalBytes: resolved.totalBytes,
    cachedCount: known.size,
    archiveBytes: needsDownload ? resolved.sizeKb * 1024 : null,
    truncated: resolved.truncated,
    cached,
    rateLimit: getLastRateLimit(),
  };
}

/**
 * Blob SHAs make the cache check exact across commits, branches and forks, but with a
 * whole-archive download that saves counting rather than bandwidth — except when a commit
 * turns out to be fully covered, in which case no archive is fetched at all.
 */
async function analyze(start: AnalyzeStart, emit: (event: AnalyzeEvent) => void): Promise<void> {
  const { repo } = start;

  // `resolve` may answer from its cache without ever touching storage, so read it here.
  const token = await requireToken();

  // "Refresh" must see new commits, so it bypasses the resolve cache too. It deliberately
  // leaves `blobStats` alone: a blob SHA is a hash of the file's contents, so a cached
  // count for one is correct by construction and re-downloading to redo it buys nothing.
  if (start.force) resolveCache.delete(`${repo.owner}/${repo.repo}`);

  emit({ kind: 'progress', phase: 'resolving', done: 0, total: 0 });
  const resolved = await resolve(repo);

  if (!start.force) {
    const cached = await cache.getRepoRun(repo.owner, repo.repo, resolved.commitSha);
    if (cached) {
      emit({ kind: 'result', stats: cached, failures: 0 });
      return;
    }
  }

  emit({ kind: 'progress', phase: 'listing', done: 0, total: resolved.files.length });

  // Reuse everything already counted, whatever commit or repository it came from —
  // including blobs previously found to be binary, which are worth nothing to re-count.
  const known = await cache.getBlobStats(resolved.files.map((file) => file.sha));
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
      owner: repo.owner,
      repo: repo.repo,
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

