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
