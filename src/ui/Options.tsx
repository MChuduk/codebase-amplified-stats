import { createContext, use, useEffect, useRef, useState } from 'react';
import { AuthError } from '../common';
import type { Account, DeviceCode } from '../common';
import { providerFor } from '../providers/registry';
import { getToken, setToken } from '../logic/settings';
import { sendRequest } from '../messaging/messages';
import { formatCount } from './format';

/** The same settings rendered inside the toolbar popup, where space is a few hundred pixels. */
const CompactContext = createContext(false);

const SOURCE_URL = 'https://github.com/MChuduk/codebase-amplified-stats';

/** One provider for now; a second would turn this into a section per provider. */
const provider = providerFor('github');

export function Options({ compact = false }: { compact?: boolean }) {
  const session = useSignIn(compact);

  return (
    <CompactContext value={compact}>
      <main className={compact ? 'px-4 py-4' : 'mx-auto max-w-xl px-6 py-12'}>
        <PageHeader />

        {session.account ? (
          compact ? (
            <SettingsRow />
          ) : (
            <>
              <SignedInRow account={session.account} onSignOut={session.signOut} />
              <CacheRow />
              <SourceRow />
            </>
          )
        ) : session.device ? (
          <DeviceFlowPanel device={session.device} copied={session.copied} />
        ) : (
          <SignInPanel busy={session.busy} onSignIn={session.start} />
        )}

        {session.notice && <Note>{session.notice}</Note>}
        {session.error && <Note tone="error">{session.error}</Note>}
      </main>
    </CompactContext>
  );
}

function PageHeader() {
  const compact = use(CompactContext);

  return (
    <header className={`flex items-center gap-3 ${compact ? 'pb-4' : 'pb-6'}`}>
      <img src={browser.runtime.getURL('/icon/48.png')} alt="" className="size-7 rounded-lg" />
      <h1 className="flex-1 text-base font-semibold">Codebase Amplified Stats</h1>
      <span className="font-mono text-xs text-[var(--page-muted)]">
        {browser.runtime.getManifest().version}
      </span>
    </header>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const compact = use(CompactContext);

  return (
    <div
      className={`flex items-center justify-between gap-4 border-t border-[var(--page-border)] ${compact ? 'py-3' : 'py-4'}`}
    >
      <span>{label}</span>
      <div className="flex items-center gap-3 text-right text-[var(--page-muted)]">{children}</div>
    </div>
  );
}

/** Sign-in and device flow take the rows' place rather than sitting inside one. */
function Panel({ children }: { children: React.ReactNode }) {
  const compact = use(CompactContext);

  return (
    <div
      className={`flex flex-col items-center gap-3 border-t border-[var(--page-border)] text-center ${compact ? 'py-6' : 'py-10'}`}
    >
      {children}
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <p
      className={`border-t border-[var(--page-border)] py-3 ${tone === 'error' ? 'text-red-600' : 'text-[var(--page-muted)]'}`}
    >
      {children}
    </p>
  );
}

function QuietButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-[var(--page-border)] px-3 py-1 text-[var(--page-fg)] hover:bg-[var(--page-subtle)]"
    >
      {children}
    </button>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--page-accent)] underline underline-offset-2"
    >
      {children}
    </a>
  );
}

function useSignIn(compact: boolean) {
  const [account, setAccount] = useState<Account | null>(null);
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

      setAccount(check);
    });
  }, []);

  const start = async () => {
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
      setAccount(typeof check === 'string' ? { login: 'Signed in', avatarUrl: null } : check);
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

  const signOut = async () => {
    await setToken(provider.id, null);
    setAccount(null);
    setNotice(null);
  };

  return {
    account,
    device,
    copied,
    busy,
    error,
    notice,
    start: () => void start(),
    signOut: () => void signOut(),
  };
}

function SignedInRow({ account, onSignOut }: { account: Account; onSignOut: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--page-border)] py-4">
      <div className="flex items-center gap-3">
        <Avatar account={account} />
        <span className="font-medium">{account.login}</span>
      </div>
      <QuietButton onClick={onSignOut}>Sign out</QuietButton>
    </div>
  );
}

function Avatar({ account }: { account: Account }) {
  const className = 'size-7 rounded-full bg-[var(--page-subtle)]';

  if (!account.avatarUrl) return <span className={className} />;
  return <img src={account.avatarUrl} alt="" className={className} />;
}

function SignInPanel({ busy, onSignIn }: { busy: boolean; onSignIn: () => void }) {
  const configured = provider.auth.isConfigured();

  return (
    <Panel>
      <p className="text-[var(--page-muted)]">
        {configured
          ? 'Sign in to use extension features'
          : 'This build has no OAuth client ID, so signing in is impossible.'}
      </p>
      <button
        type="button"
        onClick={onSignIn}
        disabled={busy || !configured}
        className="inline-flex items-center gap-2 rounded-md bg-[var(--page-accent)] px-4 py-1.5 font-medium text-white disabled:opacity-50"
      >
        <GitHubMark />
        {busy ? 'Starting…' : 'Sign in with GitHub'}
      </button>
    </Panel>
  );
}

/** GitHub's own mark, from Octicons (MIT), so the button reads as a GitHub sign-in. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 fill-current">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

function DeviceFlowPanel({ device, copied }: { device: DeviceCode; copied: boolean }) {
  const [justCopied, setJustCopied] = useState(copied);

  const copy = async () => {
    await navigator.clipboard.writeText(device.userCode);
    setJustCopied(true);
  };

  return (
    <Panel>
      <p className="max-w-sm text-[var(--page-muted)]">
        Copy this code and paste it on GitHub&apos;s authorisation screen to grant access to your
        repositories.
      </p>
      <div className="flex items-center gap-2">
        {[...device.userCode].map((character, position) =>
          character === '-' ? (
            <span key={position} className="text-xl text-[var(--page-muted)]">
              –
            </span>
          ) : (
            <span
              key={position}
              className="flex size-11 items-center justify-center rounded-md border border-[var(--page-border)] font-mono text-2xl"
            >
              {character}
            </span>
          ),
        )}
      </div>
      <QuietButton onClick={() => void copy()}>{justCopied ? 'Copied' : 'Copy code'}</QuietButton>
    </Panel>
  );
}

function CacheRow() {
  const [repositories, setRepositories] = useState<number | null>(null);

  const refresh = () => {
    void sendRequest<{ blobs: number; runs: number }>({ kind: 'cache-stats' }).then((response) => {
      if (response.ok) setRepositories(response.data.runs);
    });
  };

  useEffect(refresh, []);

  const clear = async () => {
    await sendRequest({ kind: 'clear-cache' });
    refresh();
  };

  const summary =
    repositories === null
      ? '…'
      : `${formatCount(repositories)} ${repositories === 1 ? 'repository' : 'repositories'}`;

  return (
    <Row label="Cache">
      <span>{summary}</span>
      <QuietButton onClick={() => void clear()}>Clear</QuietButton>
    </Row>
  );
}

function SettingsRow() {
  return (
    <Row label="Settings">
      <button
        type="button"
        onClick={() => void browser.runtime.openOptionsPage()}
        className="text-[var(--page-accent)] underline underline-offset-2"
      >
        Open →
      </button>
    </Row>
  );
}

function SourceRow() {
  return (
    <div className="flex justify-end border-t border-[var(--page-border)] py-4">
      <Link href={SOURCE_URL}>Source code</Link>
    </div>
  );
}
