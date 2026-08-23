/**
 * Generates `src/core/languages.generated.ts` from GitHub Linguist's data files.
 *
 * Run with `pnpm gen:languages`. The output is committed so the extension never has to
 * fetch language data at runtime.
 *
 * Linguist is MIT licensed — see NOTICE.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const LINGUIST_BASE =
  'https://raw.githubusercontent.com/github-linguist/linguist/main/lib/linguist';

const OUTPUT = resolve(import.meta.dirname, '../src/core/languages.generated.ts');

interface LinguistLanguage {
  type: 'programming' | 'markup' | 'data' | 'prose';
  color?: string;
  extensions?: string[];
  filenames?: string[];
  group?: string;
}

/**
 * Languages that win any extension conflict, most-preferred first.
 *
 * Linguist has no popularity data, and "is this the language's primary extension?" is a
 * bad proxy for it: `.yaml` is MiniYAML's primary extension but only YAML's secondary
 * one, and `.txt` is primary for Adblock Filter List. Without this list those niche
 * languages win, which is both wrong and confusing. Order matters only where two
 * preferred languages claim the same extension, which `EXTENSION_OVERRIDES` handles.
 */
// prettier-ignore
const PREFERRED_LANGUAGES = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'Ruby',
  'PHP', 'Swift', 'Kotlin', 'Objective-C', 'Scala', 'Dart', 'Lua', 'Perl', 'R', 'Julia',
  'Haskell', 'Elixir', 'Erlang', 'Clojure', 'Groovy', 'OCaml', 'F#', 'Zig', 'Nim',
  'Shell', 'PowerShell', 'Batchfile', 'Makefile', 'CMake', 'Dockerfile', 'Nix',
  'HTML', 'CSS', 'SCSS', 'Sass', 'Less', 'Vue', 'Svelte', 'TSX', 'JSX', 'Astro',
  'YAML', 'JSON', 'TOML', 'XML', 'INI', 'CSV', 'SQL', 'GraphQL', 'Protocol Buffer',
  'Markdown', 'reStructuredText', 'AsciiDoc', 'TeX', 'Text',
  'Assembly', 'Fortran', 'MATLAB', 'Vim Script', 'Emacs Lisp', 'Common Lisp', 'Scheme',
  'Solidity', 'Terraform', 'HCL', 'Starlark', 'Gradle', 'Verilog', 'VHDL',
];

const PREFERENCE_RANK = new Map(PREFERRED_LANGUAGES.map((name, index) => [name, index]));

/**
 * Conflicts between two equally mainstream languages, resolved by hand.
 * `disambiguate.ts` refines several of these using repository-level signals.
 */
// prettier-ignore
const EXTENSION_OVERRIDES: Record<string, string> = {
  // C family: `.h` and `.m` are refined per-repository by disambiguate.ts.
  '.h': 'C',
  '.m': 'Objective-C',
  // TypeScript vs XML (Qt translation files also use `.ts`).
  '.ts': 'TypeScript',
  '.tsx': 'TSX',
  // Perl vs Prolog vs Turing.
  '.pl': 'Perl',
  '.pm': 'Perl',
  '.t': 'Perl',
  // R vs Rebol vs RenderScript.
  '.r': 'R',
  // Fortran vs Forth.
  '.f': 'Fortran',
  '.for': 'Fortran',
  // Verilog vs Coq vs V.
  '.v': 'Verilog',
  // Scala vs SuperCollider.
  '.sc': 'Scala',
  // PHP include vs Pascal vs SourcePawn — PHP dominates in practice.
  '.inc': 'PHP',
};

/** Ranking used when no override applies. Programming code is what users care about. */
const TYPE_RANK: Record<LinguistLanguage['type'], number> = {
  programming: 0,
  markup: 1,
  data: 2,
  prose: 3,
};

async function fetchYaml<T>(name: string): Promise<T> {
  const response = await fetch(`${LINGUIST_BASE}/${name}.yml`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${name}.yml: ${response.status}`);
  }
  return parse(await response.text()) as T;
}

interface Candidate {
  language: string;
  /** True when the extension is the language's first (primary) extension. */
  primary: boolean;
  type: LinguistLanguage['type'];
}

function pickLanguage(extension: string, candidates: Candidate[]): string {
  const override = EXTENSION_OVERRIDES[extension];
  if (override) {
    if (!candidates.some((c) => c.language === override)) {
      console.warn(
        `  override for ${extension} names "${override}", which Linguist no longer maps to it`,
      );
    }
    return override;
  }

  const sorted = [...candidates].sort((a, b) => {
    // A mainstream language beats a niche one regardless of whose primary extension it is.
    const preference =
      (PREFERENCE_RANK.get(a.language) ?? Infinity) - (PREFERENCE_RANK.get(b.language) ?? Infinity);
    if (preference !== 0) return preference;

    if (a.primary !== b.primary) return a.primary ? -1 : 1;

    const rank = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (rank !== 0) return rank;

    return a.language.localeCompare(b.language);
  });
  return sorted[0]!.language;
}

/**
 * Strips comments and blank lines from a Linguist regex list. The patterns are Ruby
 * regexes, but the ones Linguist ships use only syntax that is also valid in JavaScript.
 */
function cleanPatterns(patterns: string[]): string[] {
  return patterns.filter((pattern) => typeof pattern === 'string' && pattern.length > 0);
}

async function main() {
  console.log('Fetching Linguist data…');
  const [languages, vendor] = await Promise.all([
    fetchYaml<Record<string, LinguistLanguage>>('languages'),
    fetchYaml<string[]>('vendor'),
  ]);

  const languageMeta: Record<string, { type: string; color: string | null; group: string | null }> =
    {};
  const extensionCandidates = new Map<string, Candidate[]>();
  const filenames: Record<string, string> = {};

  for (const [name, spec] of Object.entries(languages)) {
    languageMeta[name] = {
      type: spec.type,
      color: spec.color ?? null,
      group: spec.group ?? null,
    };

    spec.extensions?.forEach((extension, index) => {
      const key = extension.toLowerCase();
      const list = extensionCandidates.get(key) ?? [];
      list.push({ language: name, primary: index === 0, type: spec.type });
      extensionCandidates.set(key, list);
    });

    for (const filename of spec.filenames ?? []) {
      // First writer wins; Linguist lists these in alphabetical language order and
      // exact-filename collisions are rare enough not to matter.
      filenames[filename] ??= name;
    }
  }

  const extensions: Record<string, string> = {};
  const ambiguous: Record<string, string[]> = {};
  for (const [extension, candidates] of extensionCandidates) {
    extensions[extension] = pickLanguage(extension, candidates);
    if (candidates.length > 1) {
      ambiguous[extension] = candidates.map((c) => c.language).sort();
    }
  }

  const vendorPatterns = cleanPatterns(vendor);

  // Validate every pattern compiles under the JavaScript engine before shipping it.
  for (const pattern of vendorPatterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`Pattern is not valid JavaScript regex: ${pattern}`, { cause: error });
    }
  }

  const source = `// AUTO-GENERATED by scripts/gen-languages.ts — do not edit.
// Source: https://github.com/github-linguist/linguist (MIT)
// Generated: ${new Date().toISOString().slice(0, 10)}

import type { LanguageMeta } from './types';

/** Every language Linguist knows, with its type and brand colour. */
export const LANGUAGES: Record<string, LanguageMeta> = ${JSON.stringify(languageMeta, null, 2)} as Record<string, LanguageMeta>;

/** Lower-cased file extension (with leading dot) to language name. */
export const EXTENSIONS: Record<string, string> = ${JSON.stringify(extensions, null, 2)};

/** Exact file name to language, for extensionless files like Dockerfile and Makefile. */
export const FILENAMES: Record<string, string> = ${JSON.stringify(filenames, null, 2)};

/** Extensions claimed by more than one language, for disambiguation heuristics. */
export const AMBIGUOUS_EXTENSIONS: Record<string, string[]> = ${JSON.stringify(ambiguous, null, 2)};

/** Paths Linguist treats as vendored — third-party code that is not the author's work. */
export const VENDOR_PATTERNS: string[] = ${JSON.stringify(vendorPatterns, null, 2)};
`;

  await writeFile(OUTPUT, source, 'utf8');

  console.log(`Wrote ${OUTPUT}`);
  console.log(
    `  ${Object.keys(languageMeta).length} languages, ` +
      `${Object.keys(extensions).length} extensions (${Object.keys(ambiguous).length} ambiguous), ` +
      `${Object.keys(filenames).length} filenames`,
  );
  console.log(`  ${vendorPatterns.length} vendor patterns`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
