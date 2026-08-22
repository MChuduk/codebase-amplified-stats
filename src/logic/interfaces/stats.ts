import type { ProviderId } from '../../common';
import type { FileCategory, SkipReason } from './filter';

export interface LineStats {
  total: number;
  blank: number;
  /** `null` when we have no comment syntax rules for the language. */
  comment: number | null;
  code: number;
}

export interface LanguageStats extends LineStats {
  language: string;
  color: string | null;
  files: number;
  bytes: number;
  /** Per-category breakdown, so the UI can subtract tests or docs without recounting. */
  byCategory: Partial<Record<FileCategory, LineStats & { files: number; bytes: number }>>;
}

export interface RepoStats {
  provider: ProviderId;
  owner: string;
  repo: string;
  commitSha: string;
  branch: string;
  languages: LanguageStats[];
  totals: LineStats & { files: number; bytes: number };
  skippedByReason: Record<SkipReason, number>;
  /** The Git tree hit the API's 100k-entry cap, so these totals are a lower bound. */
  truncated: boolean;
  /** Some files failed to count, so these totals are a lower bound. */
  partial: boolean;
  /** Epoch millis. */
  computedAt: number;
}
