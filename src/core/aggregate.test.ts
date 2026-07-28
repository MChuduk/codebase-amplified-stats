import { describe, expect, it } from 'vitest';
import { aggregate, filterByCategory, sharesOf, totalsOf, type FileResult } from './aggregate';
import type { FileCategory, LineStats } from './types';

function result(
  path: string,
  language: string,
  stats: Partial<LineStats>,
  category: FileCategory = 'code',
): FileResult {
  return {
    path,
    sha: path,
    size: 100,
    language,
    category,
    stats: { total: 0, blank: 0, comment: 0, code: 0, ...stats },
  };
}

describe('aggregate', () => {
  it('sums files per language', () => {
    const languages = aggregate([
      result('a.ts', 'TypeScript', { total: 10, code: 8, blank: 1, comment: 1 }),
      result('b.ts', 'TypeScript', { total: 20, code: 15, blank: 3, comment: 2 }),
      result('c.go', 'Go', { total: 5, code: 5 }),
    ]);

    expect(languages.map((l) => [l.language, l.code, l.files])).toEqual([
      ['TypeScript', 23, 2],
      ['Go', 5, 1],
    ]);
  });

  it('sorts by code descending', () => {
    const languages = aggregate([
      result('a.go', 'Go', { code: 5 }),
      result('b.ts', 'TypeScript', { code: 50 }),
      result('c.py', 'Python', { code: 20 }),
    ]);
    expect(languages.map((l) => l.language)).toEqual(['TypeScript', 'Python', 'Go']);
  });

  it('folds grouped languages into their parent', () => {
    // Linguist groups TSX under TypeScript, matching GitHub's own language bar.
    const languages = aggregate([
      result('a.ts', 'TypeScript', { code: 10 }),
      result('b.tsx', 'TSX', { code: 5 }),
    ]);
    expect(languages).toHaveLength(1);
    expect(languages[0]!.language).toBe('TypeScript');
    expect(languages[0]!.code).toBe(15);
  });

  it('keeps languages separate when grouping is off', () => {
    const languages = aggregate(
      [result('a.ts', 'TypeScript', { code: 10 }), result('b.tsx', 'TSX', { code: 5 })],
      { groupLanguages: false },
    );
    expect(languages.map((l) => l.language).sort()).toEqual(['TSX', 'TypeScript']);
  });

  it('marks a language comment count unknown when any of its files is unknown', () => {
    const languages = aggregate([
      result('a.xyz', 'Exotic', { code: 5, comment: 2 }),
      result('b.xyz', 'Exotic', { code: 5, comment: null as unknown as number }),
    ]);
    expect(languages[0]!.comment).toBeNull();
  });

  it('carries a per-category breakdown', () => {
    const languages = aggregate([
      result('a.ts', 'TypeScript', { code: 10 }, 'code'),
      result('a.test.ts', 'TypeScript', { code: 4 }, 'test'),
    ]);
    expect(languages[0]!.byCategory.code?.code).toBe(10);
    expect(languages[0]!.byCategory.test?.code).toBe(4);
  });
});

describe('totalsOf', () => {
  it('does not let one unknown language blank the repository comment total', () => {
    // A single package.json should never erase an otherwise complete comment count.
    const languages = aggregate([
      result('a.ts', 'TypeScript', { code: 10, comment: 5 }),
      result('b.xyz', 'Exotic', { code: 3, comment: null as unknown as number }),
    ]);
    const totals = totalsOf(languages);
    expect(totals.code).toBe(13);
    expect(totals.comment).toBe(5);
  });

  it('reports comment as unknown only when nothing is known', () => {
    const languages = aggregate([
      result('a.xyz', 'Exotic', { code: 3, comment: null as unknown as number }),
    ]);
    expect(totalsOf(languages).comment).toBeNull();
  });
});

describe('filterByCategory', () => {
  const languages = aggregate([
    result('a.ts', 'TypeScript', { total: 12, code: 10, blank: 2 }, 'code'),
    result('a.test.ts', 'TypeScript', { total: 5, code: 4, blank: 1 }, 'test'),
    result('README.md', 'Markdown', { total: 8, code: 8 }, 'docs'),
  ]);

  it('recomputes totals for the selected categories', () => {
    const onlyCode = filterByCategory(languages, ['code']);
    expect(onlyCode).toHaveLength(1);
    expect(onlyCode[0]!.code).toBe(10);
    expect(onlyCode[0]!.files).toBe(1);
  });

  it('drops languages with nothing left', () => {
    const onlyDocs = filterByCategory(languages, ['docs']);
    expect(onlyDocs.map((l) => l.language)).toEqual(['Markdown']);
  });

  it('returns everything when all categories are selected', () => {
    const all = filterByCategory(languages, ['code', 'test', 'docs', 'data']);
    expect(totalsOf(all).code).toBe(totalsOf(languages).code);
  });
});

describe('sharesOf', () => {
  it('produces percentages summing to 100', () => {
    const languages = aggregate([
      result('a.ts', 'TypeScript', { code: 75 }),
      result('b.go', 'Go', { code: 25 }),
    ]);
    const shares = sharesOf(languages);
    expect(shares.get('TypeScript')).toBe(75);
    expect(shares.get('Go')).toBe(25);
  });

  it('handles a repository with no code lines', () => {
    expect(sharesOf([]).size).toBe(0);
  });
});
