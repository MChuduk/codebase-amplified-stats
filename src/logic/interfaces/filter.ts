/** Every exclusion carries one of these, so the panel can always explain its numbers. */
export type SkipReason =
  | 'not-a-file'
  | 'vendored'
  | 'generated'
  | 'binary'
  | 'unknown-language'
  | 'excluded-type'
  | 'too-large';

export interface CountableFile {
  path: string;
  sha: string;
  size: number;
  language: string;
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
  /** Path prefixes the user chose to exclude, on top of the built-in rules. */
  excludePaths: string[];
}
