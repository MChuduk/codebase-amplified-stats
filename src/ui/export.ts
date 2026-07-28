import type { LanguageStats, RepoStats } from '../core/types';

/**
 * Exporting results. Downloads are triggered from the content script, so the blob URL is
 * created and revoked in the page rather than through the downloads API — no extra
 * permission needed.
 */

function download(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();

  // Revoking immediately can cancel the download in some Chrome versions.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function baseName(stats: RepoStats): string {
  return `${stats.owner}-${stats.repo}-${stats.commitSha.slice(0, 7)}`;
}

export function exportJson(stats: RepoStats, languages: LanguageStats[]): void {
  const payload = {
    repository: `${stats.owner}/${stats.repo}`,
    branch: stats.branch,
    commit: stats.commitSha,
    countedAt: new Date(stats.computedAt).toISOString(),
    truncated: stats.truncated,
    partial: stats.partial,
    languages: languages.map((language) => ({
      language: language.language,
      code: language.code,
      comment: language.comment,
      blank: language.blank,
      total: language.total,
      files: language.files,
      bytes: language.bytes,
    })),
  };

  download(`${baseName(stats)}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

export function exportCsv(stats: RepoStats, languages: LanguageStats[]): void {
  const rows = [
    ['language', 'code', 'comment', 'blank', 'total', 'files', 'bytes'],
    ...languages.map((language) => [
      language.language,
      language.code,
      language.comment ?? '',
      language.blank,
      language.total,
      language.files,
      language.bytes,
    ]),
  ];

  const csv = rows
    .map((row) =>
      row
        // Quote anything that could otherwise break the column layout.
        .map((cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replaceAll('"', '""')}"` : cell))
        .join(','),
    )
    .join('\n');

  download(`${baseName(stats)}.csv`, csv, 'text/csv');
}
