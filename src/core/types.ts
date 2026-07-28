/** Repository coordinates parsed out of a github.com URL. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** How Linguist classifies a language. We count `programming` and `markup` by default. */
export type LanguageType = 'programming' | 'markup' | 'data' | 'prose';

export interface LanguageMeta {
  type: LanguageType;
  /** Linguist's hex colour, e.g. `#3572A5`. Absent for languages Linguist gives no colour. */
  color: string | null;
  /**
   * Parent language, when Linguist folds this one into another for statistics —
   * e.g. TSX into TypeScript. Null for standalone languages.
   */
  group: string | null;
}

/** A single blob entry from the Git Trees API, narrowed to what we need. */
export interface TreeEntry {
  path: string;
  /** Git file mode: `100644`, `100755`, `120000` (symlink), `160000` (submodule). */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** Present for blobs only. */
  size?: number;
}

/** Why a file was excluded from the count. Surfaced in the UI so the number is explainable. */
export type SkipReason =
  | 'not-a-file'
  | 'vendored'
  | 'generated'
  | 'binary'
  | 'unknown-language'
  | 'excluded-type'
  | 'too-large';

/**
 * What kind of content a file holds. Users care about `code` above all, but the other
 * buckets are counted too so they can be toggled on without a re-download.
 */
export type FileCategory = 'code' | 'test' | 'docs' | 'data';

/** A file that survived filtering and will be counted. */
export interface CountableFile {
  path: string;
  sha: string;
  size: number;
  language: string;
  category: FileCategory;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
  /** The rule that matched, for debugging — e.g. the vendor pattern source. */
  detail?: string;
}

export interface FilterResult {
  files: CountableFile[];
  skipped: SkippedFile[];
  /** Counts per reason, for the "excluded N files" breakdown. */
  skippedByReason: Record<SkipReason, number>;
  /** Sum of `size` over `files` — used to warn about download volume before starting. */
  totalBytes: number;
}

export interface FilterOptions {
  /** Files above this size are almost always generated dumps. Default 1 MiB. */
  maxFileSize: number;
  /**
   * Categories to download and count. Everything except `code` is optional, but note
   * that excluding a category here means it cannot be toggled back on without a
   * re-download — the UI keeps all four and filters at display time instead.
   */
  include: FileCategory[];
  /** Extra path prefixes to exclude, from user settings. */
  excludePaths: string[];
}

export const DEFAULT_FILTER_OPTIONS: FilterOptions = {
  maxFileSize: 1024 * 1024,
  include: ['code', 'test', 'docs', 'data'],
  excludePaths: [],
};

/** Line counts for one file or one aggregated language. */
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
  owner: string;
  repo: string;
  commitSha: string;
  branch: string;
  languages: LanguageStats[];
  totals: LineStats & { files: number; bytes: number };
  skippedByReason: Record<SkipReason, number>;
  /** True when the Git tree was truncated by the API and the result is incomplete. */
  truncated: boolean;
  /** True when the run stopped early (rate limiting, network) and the result is partial. */
  partial: boolean;
  /** Epoch millis. */
  computedAt: number;
}
