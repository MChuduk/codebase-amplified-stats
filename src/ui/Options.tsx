import { useEffect, useState } from 'react';
import {
  AuthError,
  fetchViewer,
  isConfigured,
  pollForToken,
  requestDeviceCode,
  signOut,
  type DeviceCode,
} from '../core/auth';
import { getSettings, getToken, saveSettings, type Settings } from '../core/storage';
import { sendRequest } from '../core/messages';
import { formatBytes, formatCount } from './format';
import type { FileCategory } from '../core/types';

const CATEGORY_LABELS: Record<FileCategory, string> = {
  code: 'Source code',
  test: 'Tests',
  docs: 'Documentation and prose',
  data: 'Data and configuration',
};

export function Options() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">GitHub Amplified Stats</h1>
      <p className="mt-1 text-sm text-[var(--page-muted)]">
        Real lines-of-code statistics per language, with vendored and generated files filtered out.
      </p>

      <AccountSection />
      <FiltersSection />
      <CacheSection />
      <AboutSection />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-lg border border-[var(--page-border)] p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm">{children}</div>
    </section>
  );
}

function AccountSection() {
  const [login, setLogin] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getToken().then(async (token) => {
      if (!token) return;
      const viewer = await fetchViewer(token);
      setLogin(viewer?.login ?? null);
      // A token that no longer resolves to a user is dead weight.
      if (!viewer) await signOut();
    });
  }, []);

  const startSignIn = async () => {
    setError(null);
    setBusy(true);
    try {
      const code = await requestDeviceCode();
      setDevice(code);
      await browser.tabs.create({ url: code.verificationUri });

      const token = await pollForToken(code);
      const viewer = await fetchViewer(token);
      setLogin(viewer?.login ?? 'signed in');
      setDevice(null);
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : String(caught));
      setDevice(null);
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setLogin(null);
  };

  return (
    <Section title="GitHub account">
      <p className="text-[var(--page-muted)]">
        Signing in raises the GitHub API limit from 60 to 5,000 requests an hour. No permissions are
        requested — the token only reads public data. File downloads never touch this limit.
      </p>

      {!isConfigured() && (
        <p className="rounded-md bg-[var(--page-subtle)] p-2 text-[var(--page-muted)]">
          No OAuth client ID was set at build time, so sign-in is unavailable. The extension still
          works at the anonymous 60 requests an hour.
        </p>
      )}

      {login ? (
        <div className="flex items-center justify-between gap-3">
          <span>
            Signed in as <strong>{login}</strong>
          </span>
          <button type="button" onClick={handleSignOut} className="rounded-md border border-[var(--page-border)] px-3 py-1">
            Sign out
          </button>
        </div>
      ) : device ? (
        <div className="rounded-md bg-[var(--page-subtle)] p-3">
          <p>
            Enter this code at{' '}
            <a href={device.verificationUri} target="_blank" rel="noreferrer" className="text-[var(--page-accent)] underline">
              {device.verificationUri}
            </a>
            :
          </p>
          <p className="mt-2 font-mono text-2xl tracking-widest">{device.userCode}</p>
          <p className="mt-2 text-[var(--page-muted)]">Waiting for authorisation…</p>
        </div>
      ) : (
        <button
          type="button"
          onClick={startSignIn}
          disabled={busy || !isConfigured()}
          className="rounded-md bg-[var(--page-accent)] px-3 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Sign in with GitHub'}
        </button>
      )}

      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
    </Section>
  );
}

function FiltersSection() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const update = (patch: Partial<Settings>) => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    void saveSettings(patch);
  };

  const toggleCategory = (category: FileCategory) => {
    const next = settings.include.includes(category)
      ? settings.include.filter((item) => item !== category)
      : [...settings.include, category];
    // Code is the whole point of the extension; refuse to leave nothing to count.
    if (next.length === 0) return;
    update({ include: next });
  };

  return (
    <Section title="What to count">
      <p className="text-[var(--page-muted)]">
        Vendored and generated files are always excluded, using GitHub Linguist&apos;s own rules.
        These categories are downloaded and counted; you can still toggle them per repository.
      </p>

      {(Object.keys(CATEGORY_LABELS) as FileCategory[]).map((category) => (
        <label key={category} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.include.includes(category)}
            onChange={() => toggleCategory(category)}
          />
          {CATEGORY_LABELS[category]}
        </label>
      ))}

      <label className="block">
        <span className="block">Skip files larger than</span>
        <span className="mt-1 flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={64}
            value={Math.round(settings.maxFileSize / 1024 / 1024)}
            onChange={(event) =>
              update({ maxFileSize: Math.max(1, Number(event.target.value)) * 1024 * 1024 })
            }
            className="w-20 rounded-md border border-[var(--page-border)] bg-transparent px-2 py-1"
          />
          <span className="text-[var(--page-muted)]">
            MB — files this large are almost always generated ({formatBytes(settings.maxFileSize)})
          </span>
        </span>
      </label>

      <label className="block">
        <span className="block">Additional paths to exclude</span>
        <textarea
          rows={3}
          value={settings.excludePaths.join('\n')}
          onChange={(event) =>
            update({ excludePaths: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })
          }
          placeholder="legacy/&#10;examples/"
          className="mt-1 w-full rounded-md border border-[var(--page-border)] bg-transparent px-2 py-1 font-mono text-xs"
        />
        <span className="text-[var(--page-muted)]">One path prefix per line.</span>
      </label>
    </Section>
  );
}

function CacheSection() {
  const [stats, setStats] = useState<{ blobs: number; runs: number } | null>(null);

  const refresh = () => {
    void sendRequest<{ blobs: number; runs: number }>({ kind: 'cache-stats' }).then((response) => {
      if (response.ok) setStats(response.data);
    });
  };

  useEffect(refresh, []);

  const clear = async () => {
    await sendRequest({ kind: 'clear-cache' });
    refresh();
  };

  return (
    <Section title="Cache">
      <p className="text-[var(--page-muted)]">
        Counts are cached per file content hash, so unchanged files are never downloaded twice —
        even across branches, commits and forks.
      </p>
      <p>
        {stats
          ? `${formatCount(stats.blobs)} files and ${formatCount(stats.runs)} repository snapshots cached`
          : 'Reading…'}
      </p>
      <button type="button" onClick={clear} className="rounded-md border border-[var(--page-border)] px-3 py-1">
        Clear cache
      </button>
    </Section>
  );
}

function AboutSection() {
  return (
    <Section title="About">
      <p className="text-[var(--page-muted)]">
        Language detection, vendored-path rules and language colours come from{' '}
        <a
          href="https://github.com/github-linguist/linguist"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--page-accent)] underline"
        >
          GitHub Linguist
        </a>
        , used under the MIT licence.
      </p>
      <p className="text-[var(--page-muted)]">
        Comment counting follows the same conventions as <code>cloc</code>: a line holding both code
        and a comment counts as code, and Python docstrings count as comments.
      </p>
    </Section>
  );
}
