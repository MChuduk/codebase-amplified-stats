import { describe, expect, it } from 'vitest';
import { detectLanguage, extensionOf, filterTree } from './filter';
import { disambiguate } from './disambiguate';
import { DEFAULT_FILTER_OPTIONS } from './types';
import type { SkipReason, TreeEntry } from './types';

function blob(path: string, size = 100, sha = 'abc'): TreeEntry {
  return { path, mode: '100644', type: 'blob', sha, size };
}

/** Runs the filter over paths and returns path -> outcome ('kept' or the skip reason). */
function outcomes(paths: string[]): Record<string, string> {
  const result = filterTree(paths.map((p) => blob(p)), DEFAULT_FILTER_OPTIONS);
  const map: Record<string, string> = {};
  for (const file of result.files) map[file.path] = 'kept';
  for (const skip of result.skipped) map[skip.path] = skip.reason;
  return map;
}

describe('extensionOf', () => {
  it('returns the lower-cased extension with its dot', () => {
    expect(extensionOf('src/Main.TS')).toBe('.ts');
    expect(extensionOf('a/b/c.tar.gz')).toBe('.gz');
  });

  it('treats dotfiles as having no extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('src/.env')).toBe('');
  });

  it('returns empty for extensionless files', () => {
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('bin/run')).toBe('');
  });
});

describe('detectLanguage', () => {
  it('resolves by extension', () => {
    expect(detectLanguage('src/index.ts')).toBe('TypeScript');
    expect(detectLanguage('main.go')).toBe('Go');
    expect(detectLanguage('lib/thing.rb')).toBe('Ruby');
  });

  it('resolves extensionless files by exact name', () => {
    expect(detectLanguage('Dockerfile')).toBe('Dockerfile');
    expect(detectLanguage('build/Makefile')).toBe('Makefile');
  });

  it('returns null for unrecognised files', () => {
    expect(detectLanguage('data.qqq')).toBeNull();
  });
});

describe('filterTree', () => {
  it('keeps ordinary source files', () => {
    const result = outcomes(['src/index.ts', 'main.go', 'lib/parser.rs']);
    expect(result).toEqual({
      'src/index.ts': 'kept',
      'main.go': 'kept',
      'lib/parser.rs': 'kept',
    });
  });

  it('drops vendored and generated paths', () => {
    const result = outcomes([
      'node_modules/left-pad/index.js',
      'vendor/github.com/pkg/errors/errors.go',
      'dist/app.js',
      'src/app.min.js',
      'package-lock.json',
      'api/service.pb.go',
      'proto/thing_pb2.py',
      'src/__snapshots__/App.test.tsx.snap',
    ]);
    for (const [path, reason] of Object.entries(result)) {
      expect([path, reason]).toEqual([path, expect.stringMatching(/^(vendored|generated)$/)]);
    }
  });

  it('does not mistake substrings for directory names', () => {
    // `vendor/` is vendored; `vendor-utils.ts` is the author's own code.
    const result = outcomes(['src/vendor-utils.ts', 'src/distance.ts', 'src/testable.ts']);
    expect(result).toEqual({
      'src/vendor-utils.ts': 'kept',
      'src/distance.ts': 'kept',
      'src/testable.ts': 'kept',
    });
  });

  it('drops binaries by extension', () => {
    const result = outcomes(['assets/logo.png', 'fonts/Inter.woff2', 'model.safetensors']);
    expect(Object.values(result)).toEqual(['binary', 'binary', 'binary']);
  });

  it('drops symlinks, submodules and directories', () => {
    const entries: TreeEntry[] = [
      { path: 'link.ts', mode: '120000', type: 'blob', sha: 'a', size: 20 },
      { path: 'sub', mode: '160000', type: 'commit', sha: 'b' },
      { path: 'src', mode: '040000', type: 'tree', sha: 'c' },
    ];
    const result = filterTree(entries, DEFAULT_FILTER_OPTIONS);
    expect(result.files).toHaveLength(0);
    expect(result.skippedByReason['not-a-file']).toBe(3);
  });

  it('drops files above the size limit', () => {
    const entries = [blob('huge.json', 5 * 1024 * 1024), blob('small.json', 500)];
    const result = filterTree(entries, DEFAULT_FILTER_OPTIONS);
    expect(result.files.map((f) => f.path)).toEqual(['small.json']);
    expect(result.skippedByReason['too-large']).toBe(1);
  });

  it('drops empty files without spending a request on them', () => {
    const result = filterTree([blob('empty.ts', 0)], DEFAULT_FILTER_OPTIONS);
    expect(result.files).toHaveLength(0);
  });

  it('categorises tests, docs and data separately from code', () => {
    const result = filterTree(
      [
        blob('src/index.ts'),
        blob('src/index.test.ts'),
        blob('tests/helper.py'),
        blob('README.md'),
        blob('config.yml'),
      ],
      DEFAULT_FILTER_OPTIONS,
    );
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.category]));
    expect(byPath).toEqual({
      'src/index.ts': 'code',
      'src/index.test.ts': 'test',
      'tests/helper.py': 'test',
      'README.md': 'docs',
      'config.yml': 'data',
    });
  });

  it('honours category exclusions', () => {
    const result = filterTree(
      [blob('src/index.ts'), blob('README.md')],
      { ...DEFAULT_FILTER_OPTIONS, include: ['code'] },
    );
    expect(result.files.map((f) => f.path)).toEqual(['src/index.ts']);
    expect(result.skippedByReason['excluded-type']).toBe(1);
  });

  it('honours user path exclusions', () => {
    const result = filterTree(
      [blob('legacy/old.ts'), blob('src/new.ts')],
      { ...DEFAULT_FILTER_OPTIONS, excludePaths: ['legacy/'] },
    );
    expect(result.files.map((f) => f.path)).toEqual(['src/new.ts']);
  });

  it('reports total bytes of what will be downloaded', () => {
    const result = filterTree(
      [blob('a.ts', 300), blob('b.ts', 700), blob('logo.png', 99999)],
      DEFAULT_FILTER_OPTIONS,
    );
    expect(result.totalBytes).toBe(1000);
  });

  it('counts every skip reason exactly once per file', () => {
    const entries = [
      blob('node_modules/x/index.js'),
      blob('logo.png'),
      blob('data.qqq'),
      blob('src/ok.ts'),
    ];
    const result = filterTree(entries, DEFAULT_FILTER_OPTIONS);
    const total = Object.values(result.skippedByReason).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.skipped.length);
    expect(result.files.length + result.skipped.length).toBe(entries.length);
  });
});

describe('disambiguate', () => {
  const file = (path: string, language: string) => ({
    path,
    sha: 'x',
    size: 10,
    language,
    category: 'code' as const,
  });

  it('treats .h as C++ when C++ sources are present', () => {
    const { files } = disambiguate([
      file('src/thing.h', 'C'),
      file('src/thing.cpp', 'C++'),
    ]);
    expect(files.find((f) => f.path === 'src/thing.h')?.language).toBe('C++');
  });

  it('treats .h as Objective-C when .m files are present', () => {
    const { files } = disambiguate([
      file('App/View.h', 'C'),
      file('App/View.m', 'Objective-C'),
    ]);
    expect(files.find((f) => f.path === 'App/View.h')?.language).toBe('Objective-C');
  });

  it('leaves .h as C in a plain C project', () => {
    const { files } = disambiguate([file('src/thing.h', 'C'), file('src/thing.c', 'C')]);
    expect(files.find((f) => f.path === 'src/thing.h')?.language).toBe('C');
  });

  it('records a note explaining each reassignment', () => {
    const { notes } = disambiguate([
      file('src/thing.h', 'C'),
      file('src/thing.cpp', 'C++'),
    ]);
    expect(notes).toEqual([
      { extension: '.h', chosen: 'C++', basis: 'co-located C++ files', files: 1 },
    ]);
  });

  it('leaves unambiguous files untouched', () => {
    const input = [file('a.go', 'Go'), file('b.py', 'Python')];
    const { files, notes } = disambiguate(input);
    expect(files).toEqual(input);
    expect(notes).toEqual([]);
  });
});
