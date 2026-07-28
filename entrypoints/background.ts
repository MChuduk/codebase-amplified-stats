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
import { getSettings, getToken } from '../src/core/storage';
import type { CountableFile, RepoRef } from '../src/core/types';

/** Simultaneous downloads per worker. Four workers means up to 24 requests in flight. */
const CONCURRENCY_PER_WORKER = 6;

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
        send({ kind: 'error', message: response.error, code: response.code });
      });
    });
  });
});

function toErrorResponse(error: unknown): { ok: false; error: string; code?: ErrorCode } {
  if (error instanceof GitHubApiError) {
    return {
      ok: false,
      error: error.message,
      code: error.code === 'server' ? 'network' : error.code,
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

/** Resolves a repository to a commit and the list of files worth counting. */
async function resolve(repo: RepoRef) {
  const [token, settings] = await Promise.all([getToken(), getSettings()]);

  const info = await fetchRepoInfo(repo, token);
  const commitSha = await fetchCommitSha(repo, info.defaultBranch, token);
  const tree = await fetchTree(repo, commitSha, token);

  const filtered = filterTree(tree.entries, settings);
  const { files } = disambiguate(filtered.files);

  return {
    branch: info.defaultBranch,
    commitSha,
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

  const bytesToDownload = resolved.files
    .filter((file) => !known.has(file.sha))
    .reduce((sum, file) => sum + file.size, 0);

  return {
    branch: resolved.branch,
    commitSha: resolved.commitSha,
    fileCount: resolved.files.length,
    totalBytes: resolved.totalBytes,
    cachedCount: known.size,
    bytesToDownload,
    truncated: resolved.truncated,
    cached,
    rateLimit: getLastRateLimit(),
  };
}

/**
 * Full counting run. Emits progress as it goes, and downloads only files whose contents
 * have never been counted — blob SHAs make that check exact across commits and forks.
 */
async function analyze(start: AnalyzeStart, emit: (event: AnalyzeEvent) => void): Promise<void> {
  const { repo } = start;

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

  // Reuse everything already counted, whatever commit or repository it came from.
  const known = await cache.getBlobStats(resolved.files.map((file) => file.sha));
  const cachedResults: FileResult[] = [];
  const toDownload: CountableFile[] = [];

  for (const file of resolved.files) {
    const record = known.get(file.sha);
    if (record) cachedResults.push({ ...file, stats: record.stats });
    else toDownload.push(file);
  }

  emit({
    kind: 'progress',
    phase: 'counting',
    done: cachedResults.length,
    total: resolved.files.length,
  });

  let downloaded: FileResult[] = [];
  let failureCount = 0;

  if (toDownload.length > 0) {
    const job = await runCountJob({
      repo,
      commitSha: resolved.commitSha,
      files: toDownload,
      concurrency: CONCURRENCY_PER_WORKER,
      onProgress: (done) => {
        emit({
          kind: 'progress',
          phase: 'counting',
          done: cachedResults.length + done,
          total: resolved.files.length,
        });
      },
    });

    downloaded = job.results;
    failureCount = job.failures.length;
    await cache.putBlobStats(downloaded);
  }

  if (cachedResults.length > 0) {
    void cache.touchBlobStats(cachedResults.map((result) => result.sha));
  }

  const stats = buildRepoStats({
    owner: repo.owner,
    repo: repo.repo,
    commitSha: resolved.commitSha,
    branch: resolved.branch,
    results: [...cachedResults, ...downloaded],
    skippedByReason: resolved.skippedByReason,
    truncated: resolved.truncated,
    partial: failureCount > 0,
  });

  await cache.putRepoRun(stats);
  void cache.cleanup();

  emit({ kind: 'result', stats, failures: failureCount });
}
