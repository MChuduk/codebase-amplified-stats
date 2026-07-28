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
