import type { TreeEntry } from '../common';
import { VENDOR_PATTERNS } from './languages.generated';
import { detectLanguage, extensionOf } from './detect';
import type { CountableFile, FilterResult, SkipReason } from './interfaces';

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
// prettier-ignore
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

/** One alternation per list, so the hot path is a single regex test. */
function compile(patterns: string[]): RegExp {
  return new RegExp(patterns.map((p) => `(?:${p})`).join('|'));
}

/**
 * A file this large is a minified bundle or a data dump, not something anyone wrote by
 * hand: counting it costs real CPU and skews the language it lands under.
 */
const MAX_FILE_SIZE = 1024 * 1024;

const vendor = compile(VENDOR_PATTERNS);
const generated = compile(GENERATED_PATTERNS);

const EMPTY_REASONS: Record<SkipReason, number> = {
  'not-a-file': 0,
  vendored: 0,
  generated: 0,
  binary: 0,
  'unknown-language': 0,
  'too-large': 0,
};

/**
 * Every skip records why. The reasons reach the panel, because a number the user cannot
 * account for is worse than no number at all.
 */
export function filterTree(entries: TreeEntry[]): FilterResult {
  const files: CountableFile[] = [];
  const skippedByReason = { ...EMPTY_REASONS };
  let totalBytes = 0;

  const skip = (reason: SkipReason) => {
    skippedByReason[reason] += 1;
  };

  for (const entry of entries) {
    const { path } = entry;

    // Trees, symlinks (120000) and submodule pointers (160000) hold no countable content.
    if (entry.type !== 'blob' || entry.mode === '120000' || entry.mode === '160000') {
      skip('not-a-file');
      continue;
    }

    // Cheap extension check before the regex batteries.
    if (BINARY_EXTENSIONS.has(extensionOf(path))) {
      skip('binary');
      continue;
    }

    if (vendor.test(path)) {
      skip('vendored');
      continue;
    }

    if (generated.test(path)) {
      skip('generated');
      continue;
    }

    const language = detectLanguage(path);
    if (!language) {
      skip('unknown-language');
      continue;
    }

    const size = entry.size ?? 0;
    if (size > MAX_FILE_SIZE) {
      skip('too-large');
      continue;
    }

    if (size === 0) {
      skip('not-a-file');
      continue;
    }

    files.push({ path, sha: entry.sha, size, language });
    totalBytes += size;
  }

  return { files, skippedByReason, totalBytes };
}
