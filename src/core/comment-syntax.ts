/**
 * Comment and string syntax per language, used by `counter.ts` to tell code from
 * comments. Curated by hand — Linguist carries no such data.
 *
 * Languages absent from this table are still counted, but only for total/blank/code;
 * their comment count is reported as unknown rather than guessed at.
 */

/** A string delimiter pair that may span lines. */
export interface MultilineDelimiter {
  open: string;
  close: string;
  /**
   * True when backslash has no special meaning inside — Go's backtick strings. Getting
   * this wrong swallows the closing delimiter and corrupts everything after it.
   */
  raw?: boolean;
}

export interface CommentSyntax {
  /** Tokens that start a comment running to end of line. */
  line: string[];
  /** Block comment delimiters, as [open, close] pairs. */
  block: Array<[string, string]>;
  /** Quote characters that start a single-line string literal, where comment tokens are inert. */
  quotes: string[];
  /**
   * String delimiters that may span lines and hold real data — JavaScript template
   * literals, Go raw strings. Counted as code.
   */
  multilineStrings?: MultilineDelimiter[];
  /**
   * Multi-line strings used as documentation — Python docstrings. Counted as comments,
   * but only when the line has no code before them, so `x = """a"""` stays code.
   */
  docStrings?: MultilineDelimiter[];
  /** True when block comments may nest, as in Rust and Swift. */
  nestedBlocks?: boolean;
  /**
   * Rust-style raw strings: `r"…"`, `r#"…"#`, `r##"…"##`. The hash count chooses the
   * closing delimiter, so these cannot be expressed as a fixed pair.
   */
  rustRawStrings?: boolean;
  /** Escape character inside strings. Defaults to backslash; empty disables escaping. */
  escape?: string;
}

/** A multi-line delimiter whose opener and closer are the same, such as `"""`. */
function sym(delimiter: string, raw = false): MultilineDelimiter {
  return { open: delimiter, close: delimiter, raw };
}

const SLASH_LINE = ['//'];
const SLASH_BLOCK: Array<[string, string]> = [['/*', '*/']];
const HTML_BLOCK: Array<[string, string]> = [['<!--', '-->']];
const DOUBLE_SINGLE = ['"', "'"];

const C_STYLE: CommentSyntax = {
  line: SLASH_LINE,
  block: SLASH_BLOCK,
  quotes: DOUBLE_SINGLE,
};

const HASH_STYLE: CommentSyntax = {
  line: ['#'],
  block: [],
  quotes: DOUBLE_SINGLE,
};

/** JavaScript and friends: backticks are template literals, which span lines. */
const JS_STYLE: CommentSyntax = {
  line: SLASH_LINE,
  block: SLASH_BLOCK,
  quotes: DOUBLE_SINGLE,
  multilineStrings: [sym('`')],
};

/** Keys are Linguist language names, so they match `filter.ts` output exactly. */
export const COMMENT_SYNTAX: Record<string, CommentSyntax> = {
  // C family
  C: C_STYLE,
  'C++': C_STYLE,
  'C#': C_STYLE,
  'Objective-C': C_STYLE,
  'Objective-C++': C_STYLE,
  Java: C_STYLE,
  Dart: C_STYLE,
  Solidity: C_STYLE,
  Verilog: C_STYLE,
  SystemVerilog: C_STYLE,
  Gradle: C_STYLE,
  'Protocol Buffer': C_STYLE,
  Thrift: C_STYLE,
  // Backticks are raw strings: no escape processing, and they span lines.
  Go: { line: SLASH_LINE, block: SLASH_BLOCK, quotes: DOUBLE_SINGLE, multilineStrings: [sym('`', true)] },
  Rust: { line: SLASH_LINE, block: SLASH_BLOCK, quotes: DOUBLE_SINGLE, nestedBlocks: true, rustRawStrings: true },
  Swift: { ...C_STYLE, nestedBlocks: true, multilineStrings: [sym('"""')] },
  Kotlin: { ...C_STYLE, nestedBlocks: true, multilineStrings: [sym('"""')] },
  Scala: { ...C_STYLE, nestedBlocks: true, multilineStrings: [sym('"""')] },
  D: { ...C_STYLE, nestedBlocks: true },
  Zig: { line: SLASH_LINE, block: [], quotes: DOUBLE_SINGLE },
  VHDL: { line: ['--'], block: [], quotes: ['"'] },

  // JavaScript family
  JavaScript: JS_STYLE,
  TypeScript: JS_STYLE,
  TSX: JS_STYLE,
  JSX: JS_STYLE,
  Vue: { ...JS_STYLE, block: [...SLASH_BLOCK, ...HTML_BLOCK] },
  Svelte: { ...JS_STYLE, block: [...SLASH_BLOCK, ...HTML_BLOCK] },

  // Hash-comment scripting languages
  Python: {
    line: ['#'],
    block: [],
    quotes: DOUBLE_SINGLE,
    // Docstrings are string expressions, not comments, but they are overwhelmingly used
    // as documentation — so they count as comments when they open a statement.
    docStrings: [sym('"""'), sym("'''")],
  },
  Ruby: { line: ['#'], block: [['=begin', '=end']], quotes: DOUBLE_SINGLE },
  Perl: { line: ['#'], block: [['=pod', '=cut']], quotes: DOUBLE_SINGLE },
  Shell: HASH_STYLE,
  Bash: HASH_STYLE,
  Fish: HASH_STYLE,
  Zsh: HASH_STYLE,
  R: HASH_STYLE,
  Nix: HASH_STYLE,
  Makefile: HASH_STYLE,
  CMake: HASH_STYLE,
  Dockerfile: HASH_STYLE,
  Starlark: HASH_STYLE,
  Tcl: HASH_STYLE,
  Awk: HASH_STYLE,
  Puppet: HASH_STYLE,
  GDScript: HASH_STYLE,
  Ignore: HASH_STYLE,
  'Ignore List': HASH_STYLE,
  Crystal: { line: ['#'], block: [], quotes: DOUBLE_SINGLE },
  PowerShell: { line: ['#'], block: [['<#', '#>']], quotes: DOUBLE_SINGLE },
  Julia: { line: ['#'], block: [['#=', '=#']], quotes: ['"'], multilineStrings: [sym('"""')], nestedBlocks: true },
  Elixir: { line: ['#'], block: [], quotes: DOUBLE_SINGLE, multilineStrings: [sym('"""')] },
  Nim: { line: ['#'], block: [['#[', ']#']], quotes: ['"'], multilineStrings: [sym('"""')], nestedBlocks: true },

  // Configuration formats
  YAML: { line: ['#'], block: [], quotes: DOUBLE_SINGLE },
  TOML: { line: ['#'], block: [], quotes: DOUBLE_SINGLE, multilineStrings: [sym('"""'), sym("'''")] },
  INI: { line: ['#', ';'], block: [], quotes: DOUBLE_SINGLE },
  Terraform: { line: ['#', '//'], block: SLASH_BLOCK, quotes: ['"'] },
  HCL: { line: ['#', '//'], block: SLASH_BLOCK, quotes: ['"'] },

  // PHP mixes both comment styles
  PHP: { line: ['//', '#'], block: SLASH_BLOCK, quotes: DOUBLE_SINGLE },

  // Functional languages
  Haskell: { line: ['--'], block: [['{-', '-}']], quotes: ['"'], nestedBlocks: true },
  Elm: { line: ['--'], block: [['{-', '-}']], quotes: ['"'], nestedBlocks: true },
  OCaml: { line: [], block: [['(*', '*)']], quotes: ['"'], nestedBlocks: true },
  'F#': { line: SLASH_LINE, block: [['(*', '*)']], quotes: ['"'] },
  Erlang: { line: ['%'], block: [], quotes: ['"'] },
  Clojure: { line: [';'], block: [], quotes: ['"'] },
  Scheme: { line: [';'], block: [['#|', '|#']], quotes: ['"'] },
  'Common Lisp': { line: [';'], block: [['#|', '|#']], quotes: ['"'] },
  'Emacs Lisp': { line: [';'], block: [], quotes: ['"'] },

  // Markup and styles
  HTML: { line: [], block: HTML_BLOCK, quotes: [] },
  XML: { line: [], block: HTML_BLOCK, quotes: [] },
  SVG: { line: [], block: HTML_BLOCK, quotes: [] },
  Markdown: { line: [], block: HTML_BLOCK, quotes: [] },
  CSS: { line: [], block: SLASH_BLOCK, quotes: DOUBLE_SINGLE },
  SCSS: { line: SLASH_LINE, block: SLASH_BLOCK, quotes: DOUBLE_SINGLE },
  Sass: { line: SLASH_LINE, block: SLASH_BLOCK, quotes: DOUBLE_SINGLE },
  Less: { line: SLASH_LINE, block: SLASH_BLOCK, quotes: DOUBLE_SINGLE },

  // Formats with no comment syntax at all. Listing them explicitly means their comment
  // count is a confident zero rather than "unknown", which would otherwise poison the
  // repository total — one package.json should not blank out the comment column.
  JSON: { line: [], block: [], quotes: ['"'] },
  CSV: { line: [], block: [], quotes: ['"'] },
  TSV: { line: [], block: [], quotes: ['"'] },
  Text: { line: [], block: [], quotes: [] },

  // Query languages
  SQL: { line: ['--'], block: SLASH_BLOCK, quotes: DOUBLE_SINGLE },
  PLpgSQL: { line: ['--'], block: SLASH_BLOCK, quotes: DOUBLE_SINGLE },
  GraphQL: { line: ['#'], block: [], quotes: ['"'], multilineStrings: [sym('"""')] },

  // Everything else
  Lua: { line: ['--'], block: [['--[[', ']]']], quotes: DOUBLE_SINGLE, multilineStrings: [{ open: '[[', close: ']]', raw: true }] },
  MATLAB: { line: ['%'], block: [['%{', '%}']], quotes: ["'", '"'] },
  Fortran: { line: ['!'], block: [], quotes: ["'", '"'] },
  Ada: { line: ['--'], block: [], quotes: ['"'] },
  Pascal: { line: SLASH_LINE, block: [['{', '}'], ['(*', '*)']], quotes: ["'"] },
  Groovy: { ...C_STYLE, multilineStrings: [sym('"""'), sym("'''")] },
  TeX: { line: ['%'], block: [], quotes: [] },
  reStructuredText: { line: [], block: [], quotes: [] },
  AsciiDoc: { line: SLASH_LINE, block: [['////', '////']], quotes: [] },
  Batchfile: { line: ['REM ', 'rem ', '::'], block: [], quotes: ['"'] },
  'Visual Basic .NET': { line: ["'"], block: [], quotes: ['"'] },
  'Vim Script': { line: ['"'], block: [], quotes: ["'"] },
  Assembly: { line: [';', '#'], block: [], quotes: DOUBLE_SINGLE },
};

export function syntaxFor(language: string): CommentSyntax | null {
  return COMMENT_SYNTAX[language] ?? null;
}
