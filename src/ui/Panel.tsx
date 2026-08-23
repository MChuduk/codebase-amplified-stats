import { useMemo, useState } from 'react';
import { colorFor, filterByCategory, sharesOf, totalsOf } from '../logic/aggregate';
import type { RepoRef } from '../common';
import type { FileCategory, RepoStats, SkipReason } from '../logic/interfaces';
import type { RepoPreview } from '../messaging/messages';
import { useAnalysis, type AnalysisState } from './hooks/useAnalysis';
import { formatBytes, formatCount, formatPercent } from './format';

const CATEGORY_LABELS: Record<FileCategory, string> = {
  code: 'Code',
  test: 'Tests',
  docs: 'Docs',
  data: 'Data',
};

const SKIP_LABELS: Record<SkipReason, string> = {
  'not-a-file': 'empty or not a file',
  vendored: 'vendored',
  generated: 'generated',
  binary: 'binary',
  'unknown-language': 'unrecognised',
  'excluded-type': 'excluded',
  'too-large': 'too large',
};

export function Panel({ repo }: { repo: RepoRef }) {
  const { state, run } = useAnalysis(repo);

  return (
    <div className="gas-panel">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Lines of code</h2>
        {state.status === 'stats' && (
          <button
            type="button"
            onClick={() => run(true)}
            className="gas-muted cursor-pointer text-xs hover:underline"
            title="Ignore the cache and count again"
          >
            Refresh
          </button>
        )}
      </div>
      <Body state={state} onRun={run} />
    </div>
  );
}

function Body({ state, onRun }: { state: AnalysisState; onRun: (force?: boolean) => void }) {
  switch (state.status) {
    case 'loading':
      return <p className="gas-muted text-xs">Reading repository tree…</p>;

    case 'error':
      return <ErrorNotice message={state.message} code={state.code} resetAt={state.resetAt} />;

    case 'preview':
      return <PreviewView preview={state.preview} onRun={() => onRun(false)} />;

    // Totals are shown as soon as they exist and keep filling in, rather than holding a
    // bare progress bar until the very last file lands. Both states render the same
    // shape, and the key keeps the table mounted across the handover — otherwise the
    // categories and sorting someone picked mid-run would reset the moment it finished.
    case 'running':
    case 'stats': {
      const running = state.status === 'running';
      const stats = running ? state.partial : state.stats;

      return (
        <div className="space-y-3">
          {running && <RunningView done={state.done} total={state.total} phase={state.phase} />}
          {stats && <StatsView key="stats" stats={stats} failures={running ? 0 : state.failures} />}
        </div>
      );
    }
  }
}

function ErrorNotice({
  message,
  code,
  resetAt,
}: {
  message: string;
  code?: string;
  resetAt?: number;
}) {
  if (code === 'no-token') {
    return (
      <div className="space-y-2 text-xs">
        <p className="gas-muted">{message}</p>
        <button
          type="button"
          onClick={() => void browser.runtime.openOptionsPage()}
          className="w-full cursor-pointer rounded-md border border-[var(--borderColor-default,#d1d9e0)] px-3 py-1.5 font-medium hover:bg-[var(--bgColor-muted,#f6f8fa)]"
        >
          Sign in with GitHub
        </button>
      </div>
    );
  }

  if (code === 'rate-limit') {
    // Knowing when the budget comes back is the difference between "it is broken" and
    // "wait eight minutes".
    const minutes = resetAt
      ? // eslint-disable-next-line react-hooks/purity -- a countdown is meant to move; a stale one would be worse than an impure read.
        Math.max(1, Math.ceil((resetAt * 1000 - Date.now()) / 60000))
      : null;

    return (
      <div className="space-y-1 text-xs text-[var(--fgColor-danger,#d1242f)]">
        <p>
          Your GitHub API budget is spent
          {minutes !== null && `; it resets in ${minutes} min`}.
        </p>
        <p className="gas-muted">
          A signed-in account gets 5,000 requests an hour, and each repository costs four.
          Downloading the files does not touch this budget.
        </p>
      </div>
    );
  }

  if (code === 'sso') {
    return (
      <div className="space-y-1 text-xs text-[var(--fgColor-danger,#d1242f)]">
        <p>{message}</p>
        <p className="gas-muted">
          Open your GitHub authorised-apps settings and enable SSO for this extension on that
          organisation, then try again.
        </p>
      </div>
    );
  }

  return <p className="text-xs text-[var(--fgColor-danger,#d1242f)]">{message}</p>;
}

function PreviewView({ preview, onRun }: { preview: RepoPreview; onRun: () => void }) {
  return (
    <div className="space-y-2">
      <p className="gas-muted text-xs">
        {formatCount(preview.fileCount)} files
        {preview.cachedCount > 0 && ` · ${formatCount(preview.cachedCount)} already counted`}
        {preview.archiveBytes !== null
          ? ` · ~${formatBytes(preview.archiveBytes)} archive to download`
          : preview.needsDownload && ' · downloads the repository archive'}
      </p>

      {preview.truncated && <TruncatedNotice />}

      <button
        type="button"
        onClick={onRun}
        className="w-full cursor-pointer rounded-md border border-[var(--borderColor-default,#d1d9e0)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bgColor-muted,#f6f8fa)]"
      >
        Count lines
      </button>

      {preview.rateLimit && preview.rateLimit.remaining < 100 && (
        <p className="gas-muted text-xs">
          {preview.rateLimit.remaining} of {preview.rateLimit.limit} API requests left this hour (
          {Math.floor(preview.rateLimit.remaining / 4)} more repositories).
        </p>
      )}
    </div>
  );
}

function RunningView({ done, total, phase }: { done: number; total: number; phase: string }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const label =
    phase === 'resolving'
      ? 'Resolving commit…'
      : phase === 'listing'
        ? 'Listing files…'
        : `${formatCount(done)} of ${formatCount(total)} files`;

  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bgColor-neutral-muted,#eaeef2)]">
        <div
          className="h-full rounded-full bg-[var(--fgColor-accent,#0969da)] transition-[width] duration-200"
          style={{ width: `${total > 0 ? percent : 15}%` }}
        />
      </div>
      <p className="gas-muted text-xs">{label}</p>
    </div>
  );
}

function TruncatedNotice() {
  return (
    <p className="text-xs text-[var(--fgColor-attention,#9a6700)]">
      This repository exceeds GitHub&apos;s file listing limit, so the count will be incomplete.
    </p>
  );
}

type SortKey = 'code' | 'comment' | 'blank' | 'files' | 'language';

function StatsView({ stats, failures }: { stats: RepoStats; failures: number }) {
  const [categories, setCategories] = useState<FileCategory[]>(['code', 'test']);
  const [detailed, setDetailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('code');

  const filtered = useMemo(
    () => filterByCategory(stats.languages, categories),
    [stats.languages, categories],
  );

  const languages = useMemo(() => {
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortKey === 'language') return a.language.localeCompare(b.language);
      if (sortKey === 'comment') return (b.comment ?? -1) - (a.comment ?? -1);
      return b[sortKey] - a[sortKey];
    });
    return sorted;
  }, [filtered, sortKey]);

  // Shares always reflect code lines, whatever the table is sorted by.
  const totals = useMemo(() => totalsOf(filtered), [filtered]);
  const shares = useMemo(() => sharesOf(filtered), [filtered]);

  const visible = expanded ? languages : languages.slice(0, 8);
  const availableCategories = useMemo(() => {
    const present = new Set<FileCategory>();
    for (const language of stats.languages) {
      for (const category of Object.keys(language.byCategory) as FileCategory[]) {
        present.add(category);
      }
    }
    return (['code', 'test', 'docs', 'data'] as FileCategory[]).filter((c) => present.has(c));
  }, [stats.languages]);

  const toggle = (category: FileCategory) => {
    setCategories((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
  };

  if (languages.length === 0) {
    return <p className="gas-muted text-xs">No files in the selected categories.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xl font-semibold tabular-nums">{formatCount(totals.code)}</p>

      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {languages.map((language) => (
          <span
            key={language.language}
            title={`${language.language} ${formatPercent(shares.get(language.language) ?? 0)}`}
            style={{
              width: `${shares.get(language.language) ?? 0}%`,
              backgroundColor: colorFor(language.language, language.color),
            }}
          />
        ))}
      </div>

      <table className="w-full text-xs tabular-nums">
        {detailed && (
          <thead className="gas-muted">
            <tr>
              <SortHeader
                label="Language"
                sortKey="language"
                active={sortKey}
                onSort={setSortKey}
                align="left"
              />
              <SortHeader label="Code" sortKey="code" active={sortKey} onSort={setSortKey} />
              <SortHeader label="Comm." sortKey="comment" active={sortKey} onSort={setSortKey} />
              <SortHeader label="Blank" sortKey="blank" active={sortKey} onSort={setSortKey} />
              <SortHeader label="Files" sortKey="files" active={sortKey} onSort={setSortKey} />
              <th />
            </tr>
          </thead>
        )}
        <tbody>
          {visible.map((language) => (
            <tr key={language.language}>
              <td className="py-0.5 pr-2">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block size-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: colorFor(language.language, language.color),
                    }}
                  />
                  <span className="truncate">{language.language}</span>
                </span>
              </td>
              <td className="py-0.5 pr-2 text-right font-medium">{formatCount(language.code)}</td>
              {detailed && (
                <>
                  <td className="gas-muted py-0.5 pr-2 text-right">
                    {language.comment === null ? '—' : formatCount(language.comment)}
                  </td>
                  <td className="gas-muted py-0.5 pr-2 text-right">
                    {formatCount(language.blank)}
                  </td>
                  <td className="gas-muted py-0.5 pr-2 text-right">
                    {formatCount(language.files)}
                  </td>
                </>
              )}
              <td className="gas-muted py-0.5 text-right">
                {formatPercent(shares.get(language.language) ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {languages.length > 8 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="gas-accent cursor-pointer text-xs hover:underline"
        >
          {expanded ? 'Show less' : `Show ${languages.length - 8} more`}
        </button>
      )}

      <div className="flex flex-wrap gap-1.5 pt-1">
        {availableCategories.map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => toggle(category)}
            className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${
              categories.includes(category)
                ? 'border-transparent bg-[var(--bgColor-accent-emphasis,#0969da)] text-white'
                : 'border-[var(--borderColor-default,#d1d9e0)]'
            }`}
          >
            {CATEGORY_LABELS[category]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setDetailed((value) => !value)}
          className="gas-muted cursor-pointer rounded-full border border-[var(--borderColor-default,#d1d9e0)] px-2 py-0.5 text-xs"
        >
          {detailed ? 'Less' : 'Details'}
        </button>
      </div>

      <Footnotes stats={stats} failures={failures} />
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  active,
  onSort,
  align = 'right',
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  return (
    <th className={`font-normal ${align === 'left' ? 'text-left' : 'text-right'}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`cursor-pointer hover:underline ${active === sortKey ? 'font-semibold' : ''}`}
      >
        {label}
      </button>
    </th>
  );
}

function Footnotes({ stats, failures }: { stats: RepoStats; failures: number }) {
  const [open, setOpen] = useState(false);

  const skipped = Object.entries(stats.skippedByReason).filter(([, count]) => count > 0);
  const skippedTotal = skipped.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="gas-muted space-y-1 text-xs">
      {stats.truncated && <TruncatedNotice />}
      {failures > 0 && <p>{formatCount(failures)} files could not be downloaded.</p>}

      {skippedTotal > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="cursor-pointer hover:underline"
          >
            {formatCount(skippedTotal)} files excluded
          </button>
          {open && (
            <ul className="pl-3">
              {skipped
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <li key={reason}>
                    {formatCount(count)} {SKIP_LABELS[reason as SkipReason]}
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
