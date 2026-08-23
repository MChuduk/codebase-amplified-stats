import type { ProviderId } from '../common';
import type { FilterOptions } from './interfaces';

export type Settings = FilterOptions;

export const DEFAULT_SETTINGS: Settings = {
  maxFileSize: 1024 * 1024,
  excludePaths: [],
};

const SETTINGS_KEY = 'settings';
const TOKENS_KEY = 'tokens';
const CLEANUP_KEY = 'lastCacheCleanup';

/** How often the cache sweep may run. It is a full index scan, not a per-run chore. */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * True at most once a day, and stamps the clock as a side effect.
 *
 * Lives here rather than in the cache so the cache stays free of extension storage, and
 * so the stamp survives service-worker restarts, which an in-memory flag would not.
 */
export async function claimCacheCleanup(): Promise<boolean> {
  const stored = await browser.storage.local.get(CLEANUP_KEY);
  const last = (stored[CLEANUP_KEY] as number | undefined) ?? 0;
  if (Date.now() - last < CLEANUP_INTERVAL_MS) return false;

  await browser.storage.local.set({ [CLEANUP_KEY]: Date.now() });
  return true;
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const merged = { ...(await getSettings()), ...settings };
  await browser.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

type TokenStore = Partial<Record<ProviderId, string>>;

async function readTokens(): Promise<TokenStore> {
  const stored = await browser.storage.local.get(TOKENS_KEY);
  return (stored[TOKENS_KEY] as TokenStore | undefined) ?? {};
}

export async function getToken(provider: ProviderId): Promise<string | null> {
  return (await readTokens())[provider] ?? null;
}

/**
 * Notifies on any sign-in or sign-out, without ever handing out the token: callers outside
 * the background — the panel's mounting, above all — must not see its value.
 */
export function onTokensChanged(listener: () => void): () => void {
  const handler = (changes: Record<string, unknown>) => {
    if (TOKENS_KEY in changes) listener();
  };

  browser.storage.local.onChanged.addListener(handler);
  return () => browser.storage.local.onChanged.removeListener(handler);
}

export async function setToken(provider: ProviderId, token: string | null): Promise<void> {
  const tokens = await readTokens();
  if (token) tokens[provider] = token;
  else delete tokens[provider];
  await browser.storage.local.set({ [TOKENS_KEY]: tokens });
}
