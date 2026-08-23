import { createContext, use, useEffect, useRef, useState } from 'react';
import { AuthError } from '../common';
import type { DeviceCode } from '../common';
import { providerFor } from '../providers/registry';
import { getSettings, getToken, saveSettings, setToken, type Settings } from '../logic/settings';
import { sendRequest } from '../messaging/messages';
import { formatBytes, formatCount } from './format';

/** The same settings rendered inside the toolbar popup, where space is a few hundred pixels. */
const CompactContext = createContext(false);

export function Options({ compact = false }: { compact?: boolean }) {
  return (
    <CompactContext value={compact}>
      <main className={compact ? 'px-4 py-4' : 'mx-auto max-w-2xl px-6 py-10'}>
        <h1 className={compact ? 'text-base font-semibold' : 'text-xl font-semibold'}>
          Codebase Amplified Stats
        </h1>
        <p className="mt-1 text-sm text-[var(--page-muted)]">
          Real lines-of-code statistics per language, with vendored and generated files filtered
          out.
        </p>

        <AccountSection />
        <FiltersSection />
        <CacheSection />
        {compact ? <OpenFullSettings /> : <AboutSection />}
      </main>
    </CompactContext>
  );
}

function OpenFullSettings() {
  return (
    <button
      type="button"
      onClick={() => void browser.runtime.openOptionsPage()}
      className="mt-4 text-sm text-[var(--page-accent)] underline"
    >
      Open full settings
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const compact = use(CompactContext);

  return (
    <section
      className={`rounded-lg border border-[var(--page-border)] p-4 ${compact ? 'mt-4' : 'mt-8'}`}
    >
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm">{children}</div>
    </section>
  );
}

/** One provider for now; a second would turn this into a section per provider. */
const provider = providerFor('github');

function AccountSection() {
  const compact = use(CompactContext);
  const [login, setLogin] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = useRef<AbortController | null>(null);

  // Otherwise the poll loop outlives the page, with nobody left to receive the token.
  useEffect(() => () => signIn.current?.abort(), []);

  useEffect(() => {
    void getToken(provider.id).then(async (token) => {
      if (!token) return;

      const check = await provider.auth.verifyToken(token);
      if (check === 'invalid') {
        await setToken(provider.id, null);
        return;
      }
      // Deliberately keeps the token: a dropped connection says nothing about it, and
      // signing back in is a trip through GitHub.
      if (check === 'network') {
        setNotice('Could not reach GitHub to check your sign-in.');
        return;
      }

      setLogin(check.login);
    });
  }, []);

  const startSignIn = async () => {
    // The device-flow poll lives in this page, and a popup is closed by the browser the moment
    // the GitHub tab takes focus — so the popup hands sign-in over to the options page.
    if (compact) {
      await browser.runtime.openOptionsPage();
      window.close();
      return;
    }

    setError(null);
    setNotice(null);
    setBusy(true);

    const controller = new AbortController();
    signIn.current = controller;

    try {
      const code = await provider.auth.requestDeviceCode();
      setDevice(code);

      // GitHub's page wants the code typed in; the clipboard turns that into one paste.
      try {
        await navigator.clipboard.writeText(code.userCode);
        setCopied(true);
      } catch {
        setCopied(false);
      }

      await browser.tabs.create({ url: code.verificationUri });

      const token = await provider.auth.pollForToken(code, { signal: controller.signal });
      await setToken(provider.id, token);
      const check = await provider.auth.verifyToken(token);
      setLogin(typeof check === 'string' ? 'signed in' : check.login);
      setDevice(null);
    } catch (caught: unknown) {
      const cancelled = caught instanceof AuthError && caught.code === 'cancelled';
      if (!cancelled) setError(caught instanceof AuthError ? caught.message : String(caught));
      setDevice(null);
    } finally {
      signIn.current = null;
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    await setToken(provider.id, null);
    setLogin(null);
    setNotice(null);
  };

  return (
    <Section title="GitHub account">
      <p className="text-[var(--page-muted)]">
        Signing in is required: every request the extension makes is authenticated, which is what
        lets it count any repository you can read, private ones included.
      </p>
      {!compact && (
        <p className="text-[var(--page-muted)]">
          GitHub will ask you to grant the <code>repo</code> scope. There is no read-only version of
          it — <code>repo</code> is the only classic OAuth scope that opens private repositories, so
          the consent screen will mention write access. This extension only ever reads: it lists a
          repository&apos;s files and downloads an archive of them. The token is stored in this
          browser profile and is sent to GitHub and nowhere else.
        </p>
      )}

      {!provider.auth.isConfigured() && (
        <p className="rounded-md bg-[var(--page-subtle)] p-2 text-[var(--page-muted)]">
          This build has no OAuth client ID, so signing in is impossible and nothing will work.
          Rebuild with <code>WXT_GITHUB_CLIENT_ID</code> set.
        </p>
      )}

      {login ? (
        <div className="flex items-center justify-between gap-3">
          <span>
            Signed in as <strong>{login}</strong>
          </span>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="rounded-md border border-[var(--page-border)] px-3 py-1"
          >
            Sign out
          </button>
        </div>
      ) : device ? (
        <div className="rounded-md bg-[var(--page-subtle)] p-3">
          <p>
            {copied ? 'Paste this code at ' : 'Enter this code at '}
            <a
              href={device.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--page-accent)] underline"
            >
              {device.verificationUri}
            </a>
            :
          </p>
          <p className="mt-2 font-mono text-2xl tracking-widest">{device.userCode}</p>
          <p className="mt-2 text-[var(--page-muted)]">
            {copied ? 'Copied to your clipboard. ' : ''}Waiting for authorisation…
          </p>
          <button
            type="button"
            onClick={() => signIn.current?.abort()}
            className="mt-3 rounded-md border border-[var(--page-border)] px-3 py-1"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void startSignIn()}
          disabled={busy || !provider.auth.isConfigured()}
          className="rounded-md bg-[var(--page-accent)] px-3 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Sign in with GitHub'}
        </button>
      )}

      {notice && <p className="text-[var(--page-muted)]">{notice}</p>}
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

  return (
    <Section title="What to count">
      <p className="text-[var(--page-muted)]">
        Every recognised text file in the repository is counted. Vendored and generated files are
        always excluded, using GitHub Linguist&apos;s own rules.
      </p>

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
            update({
              excludePaths: event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            })
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
      <button
        type="button"
        onClick={() => void clear()}
        className="rounded-md border border-[var(--page-border)] px-3 py-1"
      >
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
