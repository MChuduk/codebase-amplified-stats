import type { RepoRef } from '../common';
import { LANGUAGES } from './languages.generated';
import type { LanguageStats, LineStats, RepoStats, SkipReason } from './interfaces';

export interface FileResult {
  path: string;
  sha: string;
  size: number;
  language: string;
  stats: LineStats;
}

function emptyStats(): LineStats & { files: number; bytes: number } {
  return { total: 0, blank: 0, comment: 0, code: 0, files: 0, bytes: 0 };
}

/**
 * Adds `from` into `into`. A null comment count is contagious: once any file in a
 * language has no comment data, the language total cannot claim one.
 */
function accumulate(
  into: LineStats & { files: number; bytes: number },
  from: LineStats,
  bytes: number,
): void {
  into.total += from.total;
  into.blank += from.blank;
  into.code += from.code;
  into.files += 1;
  into.bytes += bytes;
  if (into.comment === null || from.comment === null) into.comment = null;
  else into.comment += from.comment;
}

/**
 * Languages Linguist folds into a parent — TSX into TypeScript — are merged here, so the
 * rows line up with how GitHub's own language bar groups them.
 */
export function aggregate(
  results: FileResult[],
  options: { groupLanguages?: boolean } = {},
): LanguageStats[] {
  const groupLanguages = options.groupLanguages ?? true;
  const byLanguage = new Map<string, ReturnType<typeof emptyStats>>();

  for (const result of results) {
    const meta = LANGUAGES[result.language];
    const name = (groupLanguages && meta?.group) || result.language;

    let totals = byLanguage.get(name);
    if (!totals) {
      totals = emptyStats();
      byLanguage.set(name, totals);
    }

    accumulate(totals, result.stats, result.size);
  }

  const languages: LanguageStats[] = [];
  for (const [language, totals] of byLanguage) {
    languages.push({
      language,
      color: LANGUAGES[language]?.color ?? null,
      ...totals,
    });
  }

  // Most code first — the ordering the panel renders in.
  languages.sort((a, b) => b.code - a.code || a.language.localeCompare(b.language));
  return languages;
}

/**
 * Unlike the per-language rollup, a language with no comment data is left out of the
 * repository comment total rather than blanking it — otherwise one file in an exotic
 * language would erase an otherwise complete number.
 */
export function totalsOf(languages: LanguageStats[]): LineStats & { files: number; bytes: number } {
  const totals = emptyStats();
  let commentKnown = false;

  for (const language of languages) {
    totals.total += language.total;
    totals.blank += language.blank;
    totals.code += language.code;
    totals.files += language.files;
    totals.bytes += language.bytes;
    if (language.comment !== null) {
      totals.comment = (totals.comment ?? 0) + language.comment;
      commentKnown = true;
    }
  }

  if (!commentKnown) totals.comment = null;
  return totals;
}

export function buildRepoStats(params: {
  repo: RepoRef;
  commitSha: string;
  branch: string;
  results: FileResult[];
  skippedByReason: Record<SkipReason, number>;
  truncated: boolean;
  partial: boolean;
}): RepoStats {
  const languages = aggregate(params.results);
  return {
    provider: params.repo.provider,
    owner: params.repo.owner,
    repo: params.repo.repo,
    commitSha: params.commitSha,
    branch: params.branch,
    languages,
    totals: totalsOf(languages),
    skippedByReason: params.skippedByReason,
    truncated: params.truncated,
    partial: params.partial,
    computedAt: Date.now(),
  };
}

/** Shares of *code* lines specifically, which is what the stacked bar plots. */
export function sharesOf(languages: LanguageStats[]): Map<string, number> {
  const total = languages.reduce((sum, language) => sum + language.code, 0);
  const shares = new Map<string, number>();
  if (total === 0) return shares;
  for (const language of languages) {
    shares.set(language.language, (language.code / total) * 100);
  }
  return shares;
}

/**
 * A stable colour for languages Linguist gives none, derived from the name so the same
 * language always looks the same.
 */
export function colorFor(language: string, color: string | null): string {
  if (color) return color;
  let hash = 0;
  for (let i = 0; i < language.length; i++) {
    hash = (hash * 31 + language.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 45% 55%)`;
}
