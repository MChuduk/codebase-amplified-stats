import {
  DOCUMENTATION_PATTERNS,
  EXTENSIONS,
  FILENAMES,
  LANGUAGES,
  VENDOR_PATTERNS,
} from './languages.generated';
import type {
  CountableFile,
  FileCategory,
  FilterOptions,
  FilterResult,
  SkipReason,
  SkippedFile,
  TreeEntry,
} from './types';

/**
 * Paths that are machine-written rather than authored. Linguist decides most of these by
 * inspecting file contents (`lib/linguist/generated.rb`); we can only afford path-based
 * rules, so this covers the cases where the path alone is conclusive.
 */
const GENERATED_PATTERNS: string[] = [
  // Minified and bundled output
  '\\.min\\.(js|css)$',
  '[.-](bundle|chunk)\\.js$',
  '\\.map$',
  // Dependency lockfiles
  '(^|/)(package-lock\\.json|npm-shrinkwrap\\.json)$',
  '(^|/)(yarn|pnpm|bun)\\.lock(b|)$',
  '(^|/)(Cargo|Gemfile|Podfile|composer|poetry|deno|flake)\\.lock$',
  '(^|/)go\\.sum$',
  '(^|/)(Pipfile|uv)\\.lock$',
  '(^|/)gradle\\.lockfile$',
  // Protocol buffers, gRPC, Thrift, FlatBuffers
  '\\.pb\\.(go|cc|h|rb|py|swift|ts|js)$',
  '_pb2(_grpc)?\\.pyi?$',
  '\\.pb\\.gw\\.go$',
  '_grpc\\.pb\\.(go|ts|js)$',
  '\\.g\\.dart$',
  '\\.freezed\\.dart$',
  // Generated C#/Xamarin/WPF
  '\\.designer\\.cs$',
  '\\.g\\.cs$',
  '\\.generated\\.(cs|ts|js|go|java)$',
  // Parser generators
  '(^|/)(y\\.tab|lex\\.yy)\\.(c|h)$',
  '(^|/).*\\.tab\\.(c|h)$',
  // Snapshots and fixtures that are written by tooling
  '(^|/)__snapshots__/',
  '\\.snap$',
  // ORM / schema codegen
  '(^|/)migrations?/.*\\.(py|rb|go|sql|cs|php)$',
  '(^|/)schema\\.graphql$',
  // Build system output not caught by Linguist's vendor list
  '(^|/)(target|out|bin|obj)/',
  '(^|/)\\.next/',
  '(^|/)\\.nuxt/',
  '(^|/)__pycache__/',
];

/**
 * Extensions whose content is not text. Linguist has no binary flag, so this is a
 * hand-maintained list; anything that slips through is caught by the NUL-byte check in
 * the counter.
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.webp',
  '.avif', '.heic', '.psd', '.ai', '.eps',
  // Video and audio
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.ear', '.tgz',
  '.zst', '.lz4',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Binaries and libraries
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.pyc', '.pyo',
  '.wasm', '.bin', '.dat', '.dmg', '.iso', '.deb', '.rpm', '.apk', '.ipa',
  // Documents and data blobs
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.db', '.sqlite', '.sqlite3', '.mdb', '.parquet', '.avro', '.pickle', '.pkl',
  '.npy', '.npz', '.h5', '.hdf5', '.pt', '.pth', '.onnx', '.safetensors', '.gguf',
]);

/** Paths and filename shapes that mark a file as a test. */
const TEST_PATTERNS: string[] = [
  '(^|/)(tests?|__tests__|spec|specs|testing)/',
  '(^|/)test_[^/]+\\.(py|rb)$',
  '[._-]test\\.(js|jsx|ts|tsx|go|py|rb|dart|kt|swift)$',
  '[._-]spec\\.(js|jsx|ts|tsx|rb|py|kt)$',
  '(^|/)[^/]+Test(s)?\\.(java|kt|cs|scala|php)$',
  '(^|/)[^/]+Spec\\.(scala|kt|groovy)$',
  '(^|/)conftest\\.py$',
];

/**
 * Compiles a pattern list into one alternation for the hot path, keeping the individual
 * expressions around so a match can be attributed to a specific rule when reporting.
 */
function compile(patterns: string[]) {
  return {
    combined: new RegExp(patterns.map((p) => `(?:${p})`).join('|')),
    individual: patterns.map((p) => ({ source: p, regex: new RegExp(p) })),
  };
}

const vendor = compile(VENDOR_PATTERNS);
const generated = compile(GENERATED_PATTERNS);
const documentation = compile(DOCUMENTATION_PATTERNS);
const tests = compile(TEST_PATTERNS);

function whichPattern(set: ReturnType<typeof compile>, path: string): string | undefined {
  return set.individual.find((entry) => entry.regex.test(path))?.source;
}

/** Extension including the leading dot, lower-cased. Empty when the file has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  // A leading dot means a dotfile (.gitignore), not an extension.
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

export function filenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Resolves a path to a Linguist language, or null when we do not recognise it. */
export function detectLanguage(path: string): string | null {
  const byFilename = FILENAMES[filenameOf(path)];
  if (byFilename) return byFilename;

  const extension = extensionOf(path);
  if (!extension) return null;

  return EXTENSIONS[extension] ?? null;
}

function categorise(path: string, language: string): FileCategory {
  if (tests.combined.test(path)) return 'test';

  const meta = LANGUAGES[language];
  if (meta?.type === 'prose' || documentation.combined.test(path)) return 'docs';
  if (meta?.type === 'data') return 'data';
  return 'code';
}

const EMPTY_REASONS: Record<SkipReason, number> = {
  'not-a-file': 0,
  vendored: 0,
  generated: 0,
  binary: 0,
  'unknown-language': 0,
  'excluded-type': 0,
  'too-large': 0,
};

/**
 * Splits a Git tree into files worth counting and files to skip, recording why each one
 * was dropped. The reasons are shown in the UI — a number that cannot be explained is
 * worse than no number.
 */
export function filterTree(entries: TreeEntry[], options: FilterOptions): FilterResult {
  const files: CountableFile[] = [];
  const skipped: SkippedFile[] = [];
  const skippedByReason = { ...EMPTY_REASONS };
  let totalBytes = 0;

  const included = new Set(options.include);
  const excludePrefixes = options.excludePaths.filter(Boolean);

  const skip = (path: string, reason: SkipReason, detail?: string) => {
    skipped.push({ path, reason, ...(detail ? { detail } : {}) });
    skippedByReason[reason] += 1;
  };

  for (const entry of entries) {
    const { path } = entry;

    // Trees, symlinks (120000) and submodule pointers (160000) hold no countable content.
    if (entry.type !== 'blob' || entry.mode === '120000' || entry.mode === '160000') {
      skip(path, 'not-a-file');
      continue;
    }

    if (excludePrefixes.some((prefix) => path.startsWith(prefix))) {
      skip(path, 'excluded-type', 'user exclusion');
      continue;
    }

    // Cheap extension check before the regex batteries.
    if (BINARY_EXTENSIONS.has(extensionOf(path))) {
      skip(path, 'binary');
      continue;
    }

    if (vendor.combined.test(path)) {
      skip(path, 'vendored', whichPattern(vendor, path));
      continue;
    }

    if (generated.combined.test(path)) {
      skip(path, 'generated', whichPattern(generated, path));
      continue;
    }

    const language = detectLanguage(path);
    if (!language) {
      skip(path, 'unknown-language');
      continue;
    }

    const category = categorise(path, language);
    if (!included.has(category)) {
      skip(path, 'excluded-type', category);
      continue;
    }

    const size = entry.size ?? 0;
    if (size > options.maxFileSize) {
      skip(path, 'too-large', `${size} bytes`);
      continue;
    }

    // Empty files have nothing to count but would still cost a request.
    if (size === 0) {
      skip(path, 'not-a-file', 'empty');
      continue;
    }

    files.push({ path, sha: entry.sha, size, language, category });
    totalBytes += size;
  }

  return { files, skipped, skippedByReason, totalBytes };
}
