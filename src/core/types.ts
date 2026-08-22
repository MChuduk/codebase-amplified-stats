export interface RepoRef {
  owner: string;
  repo: string;
}

/** Linguist's own classification. Only `programming` and `markup` are counted by default. */
export type LanguageType = 'programming' | 'markup' | 'data' | 'prose';

export interface LanguageMeta {
  type: LanguageType;
  /** Hex, as Linguist writes it: `#3572A5`. */
  color: string | null;
  /** Set when Linguist folds this language into another for statistics — TSX into TypeScript. */
  group: string | null;
}

/** An entry from the Git Trees API, narrowed to the fields we use. */
export interface TreeEntry {
  path: string;
  /** Git file mode: `100644`, `100755`, `120000` (symlink), `160000` (submodule). */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** Present for blobs only. */
  size?: number;
}

/** Every exclusion carries one of these, so the panel can always explain its numbers. */
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

export interface CountableFile {
  path: string;
  sha: string;
  size: number;
  language: string;
  category: FileCategory;
}

export interface FilterResult {
  files: CountableFile[];
  skippedByReason: Record<SkipReason, number>;
  /** Summed over `files`, so it excludes everything filtering dropped. */
  totalBytes: number;
}

export interface FilterOptions {
  /** Files above this size are almost always generated dumps. */
  maxFileSize: number;
  /**
   * Categories to download and count. Everything except `code` is optional, but note
   * that excluding a category here means it cannot be toggled back on without a
   * re-download — the UI keeps all four and filters at display time instead.
   */
  include: FileCategory[];
  /** Path prefixes the user chose to exclude, on top of the built-in rules. */
  excludePaths: string[];
}

export const DEFAULT_FILTER_OPTIONS: FilterOptions = {
  maxFileSize: 1024 * 1024,
  include: ['code', 'test', 'docs', 'data'],
  excludePaths: [],
};

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
  /** The Git tree hit the API's 100k-entry cap, so these totals are a lower bound. */
  truncated: boolean;
  /** Some files failed to count, so these totals are a lower bound. */
  partial: boolean;
  /** Epoch millis. */
  computedAt: number;
}
