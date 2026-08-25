/** Every exclusion carries one of these, so the panel can always explain its numbers. */
export type SkipReason =
  | 'not-a-file'
  | 'vendored'
  | 'generated'
  | 'binary'
  | 'unknown-language'
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
