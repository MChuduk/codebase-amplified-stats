import { extensionOf, filenameOf } from './filter';
import type { CountableFile } from './types';

/**
 * Repository-level disambiguation for extensions claimed by several languages.
 *
 * Linguist resolves these by reading file contents, which would mean downloading files we
 * would otherwise skip. Instead we look at what else is in the repository: a `.h` next to
 * `.cpp` files is C++, the same `.h` next to `.m` files is Objective-C. This gets the
 * common cases right at zero request cost.
 */

interface Rule {
  /** The extension being resolved, lower-cased with leading dot. */
  extension: string;
  /** Checked in order; the first whose signal is present wins. */
  candidates: Array<{
    language: string;
    /** Extensions whose presence anywhere in the repo implies this language. */
    extensions?: string[];
    /** Exact filenames whose presence implies this language. */
    filenames?: string[];
  }>;
  fallback: string;
}

const RULES: Rule[] = [
  {
    extension: '.h',
    candidates: [
      { language: 'Objective-C', extensions: ['.m', '.mm'] },
      { language: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.c++', '.hh'] },
    ],
    fallback: 'C',
  },
  {
    extension: '.m',
    candidates: [
      { language: 'Objective-C', extensions: ['.mm', '.h', '.pbxproj'] },
      { language: 'MATLAB', extensions: ['.mat', '.mlx', '.slx', '.fig'] },
    ],
    fallback: 'Objective-C',
  },
  {
    extension: '.ts',
    candidates: [
      // Qt translation sources are XML and live next to Qt project files.
      { language: 'XML', extensions: ['.pro', '.qrc', '.ui'] },
      { language: 'TypeScript', extensions: ['.tsx', '.js', '.mts'], filenames: ['package.json', 'tsconfig.json'] },
    ],
    fallback: 'TypeScript',
  },
  {
    extension: '.pl',
    candidates: [
      { language: 'Perl', extensions: ['.pm', '.t', '.pod'], filenames: ['cpanfile', 'Makefile.PL'] },
      { language: 'Prolog', extensions: ['.pro', '.prolog', '.plt'] },
    ],
    fallback: 'Perl',
  },
  {
    extension: '.v',
    candidates: [
      { language: 'Verilog', extensions: ['.sv', '.svh', '.vh'] },
      { language: 'Coq', extensions: ['.vo', '.glob'], filenames: ['_CoqProject'] },
    ],
    fallback: 'Verilog',
  },
  {
    extension: '.f',
    candidates: [
      { language: 'Fortran', extensions: ['.f90', '.f95', '.f03', '.for'] },
      { language: 'Forth', extensions: ['.fth', '.4th'] },
    ],
    fallback: 'Fortran',
  },
  {
    extension: '.cls',
    candidates: [
      { language: 'TeX', extensions: ['.tex', '.sty', '.bib'] },
      { language: 'Apex', extensions: ['.trigger', '.apex'] },
      { language: 'Visual Basic 6.0', extensions: ['.frm', '.bas', '.vbp'] },
    ],
    fallback: 'TeX',
  },
  {
    extension: '.r',
    candidates: [
      { language: 'R', extensions: ['.rmd', '.rd', '.rproj'], filenames: ['DESCRIPTION', 'NAMESPACE'] },
      { language: 'Rebol', extensions: ['.reb', '.r3'] },
    ],
    fallback: 'R',
  },
  {
    extension: '.pro',
    candidates: [
      { language: 'QMake', extensions: ['.qrc', '.ui', '.pri'] },
      { language: 'IDL', extensions: ['.idl'] },
      { language: 'Prolog', extensions: ['.pl', '.prolog'] },
    ],
    fallback: 'QMake',
  },
];

export interface DisambiguationNote {
  extension: string;
  chosen: string;
  /** The rule that fired, or 'fallback' when nothing matched. */
  basis: string;
  files: number;
}

export interface DisambiguationResult {
  files: CountableFile[];
  /** Surfaced in the UI so a surprising language attribution can be understood. */
  notes: DisambiguationNote[];
}

/** Returns the same files, with `language` corrected wherever a rule applied. */
export function disambiguate(files: CountableFile[]): DisambiguationResult {
  const presentExtensions = new Set<string>();
  const presentFilenames = new Set<string>();
  for (const file of files) {
    presentExtensions.add(extensionOf(file.path));
    presentFilenames.add(filenameOf(file.path));
  }

  const resolutions = new Map<string, { language: string; basis: string }>();
  const notes: DisambiguationNote[] = [];

  for (const rule of RULES) {
    if (!presentExtensions.has(rule.extension)) continue;

    const winner = rule.candidates.find(
      (candidate) =>
        candidate.extensions?.some((extension) => presentExtensions.has(extension)) ||
        candidate.filenames?.some((filename) => presentFilenames.has(filename)),
    );

    resolutions.set(rule.extension, {
      language: winner?.language ?? rule.fallback,
      basis: winner ? `co-located ${winner.language} files` : 'fallback',
    });
  }

  if (resolutions.size === 0) return { files, notes };

  const counts = new Map<string, number>();
  const result = files.map((file) => {
    const resolution = resolutions.get(extensionOf(file.path));
    if (!resolution || resolution.language === file.language) return file;

    counts.set(extensionOf(file.path), (counts.get(extensionOf(file.path)) ?? 0) + 1);
    return { ...file, language: resolution.language };
  });

  for (const [extension, count] of counts) {
    const resolution = resolutions.get(extension)!;
    notes.push({
      extension,
      chosen: resolution.language,
      basis: resolution.basis,
      files: count,
    });
  }

  return { files: result, notes };
}
