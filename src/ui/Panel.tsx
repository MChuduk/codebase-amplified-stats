import { useMemo, useState } from 'react';
import { colorFor, totalsOf } from '../logic/aggregate';
import type { RepoRef } from '../common';
import type { RepoStats } from '../logic/interfaces';
import { useAnalysis, type AnalysisState } from './hooks/useAnalysis';
import { formatCount } from './format';

export function Panel({ repo }: { repo: RepoRef }) {
  const { state, run } = useAnalysis(repo);

  // A signed-out user gets no panel at all: mounting already checks for a token, and this
  // covers the token being discarded mid-run, which unmounts a moment later.
  if (state.status === 'error' && state.code === 'no-token') return null;

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
      <Body state={state} />
    </div>
  );
}

function Body({ state }: { state: AnalysisState }) {
  switch (state.status) {
    case 'error':
      return <ErrorNotice message={state.message} code={state.code} resetAt={state.resetAt} />;

    // Totals are shown as soon as they exist and keep filling in, rather than holding a
    // bare progress bar until the very last file lands. Both states render the same
    // shape, and the key keeps the table mounted across the handover — otherwise an
    // expanded list would collapse the moment the run finished.
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

function StatsView({ stats, failures }: { stats: RepoStats; failures: number }) {
  const [expanded, setExpanded] = useState(false);

  const { languages } = stats;
  const totals = useMemo(() => totalsOf(languages), [languages]);

  const visible = expanded ? languages : languages.slice(0, 8);

  if (languages.length === 0) {
    return <p className="gas-muted text-xs">No countable files in this repository.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xl font-semibold tabular-nums">{formatCount(totals.code)}</p>

      <table className="w-full text-xs tabular-nums">
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
              <td className="py-0.5 text-right font-medium">{formatCount(language.code)}</td>
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

      <Footnotes stats={stats} failures={failures} />
    </div>
  );
}

function Footnotes({ stats, failures }: { stats: RepoStats; failures: number }) {
  return (
    <div className="gas-muted space-y-1 text-xs">
      {stats.truncated && <TruncatedNotice />}
      {failures > 0 && <p>{formatCount(failures)} files could not be downloaded.</p>}
    </div>
  );
}
