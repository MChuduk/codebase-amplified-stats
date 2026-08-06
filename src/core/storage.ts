import { DEFAULT_FILTER_OPTIONS } from './types';
import type { FilterOptions } from './types';

export interface Settings extends FilterOptions {
  /** Start counting automatically instead of waiting for a click. Off by default —
   *  downloading megabytes on someone's behalf should be a deliberate act. */
  autoAnalyze: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_FILTER_OPTIONS,
  autoAnalyze: false,
};

const SETTINGS_KEY = 'settings';
const TOKEN_KEY = 'githubToken';
const CLEANUP_KEY = 'lastCacheCleanup';

/** How often the cache sweep may run. It is a full index scan, not a per-run chore. */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * True at most once a day, and stamps the clock as a side effect.
 *
 * Kept here rather than in the cache so the cache stays free of extension storage, and
 * survives service-worker restarts, which an in-memory flag would not.
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

export async function getToken(): Promise<string | null> {
  const stored = await browser.storage.local.get(TOKEN_KEY);
  return (stored[TOKEN_KEY] as string | undefined) ?? null;
}

export async function setToken(token: string | null): Promise<void> {
  if (token) {
    await browser.storage.local.set({ [TOKEN_KEY]: token });
  } else {
    await browser.storage.local.remove(TOKEN_KEY);
  }
}
