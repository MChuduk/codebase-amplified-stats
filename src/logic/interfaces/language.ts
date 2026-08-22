/** Linguist's own classification. Only `programming` and `markup` are counted by default. */
export type LanguageType = 'programming' | 'markup' | 'data' | 'prose';

export interface LanguageMeta {
  type: LanguageType;
  /** Hex, as Linguist writes it: `#3572A5`. */
  color: string | null;
  /** Set when Linguist folds this language into another for statistics — TSX into TypeScript. */
  group: string | null;
}
