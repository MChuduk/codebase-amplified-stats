import type { CommentSyntax } from './comment-syntax';
import type { LineStats } from './types';

/**
 * Line counting that distinguishes code from comments.
 *
 * The parser walks each line character by character, tracking whether it is inside a
 * string or a block comment, so that `"// not a comment"` counts as code and
 * `/* int x; *​/` does not. State carries across lines, which is what makes block
 * comments and multi-line strings work.
 *
 * A line holding both code and a comment counts as code — the same convention tokei and
 * cloc use.
 */

interface ParserState {
  /** Closing token we are waiting for inside a block comment, if any. */
  blockCloser: string | null;
  /** Matching opener, needed to detect nesting. */
  blockOpener: string | null;
  /** Nesting depth for languages whose block comments nest. */
  blockDepth: number;
  /** Closing token for an open multi-line string. */
  stringCloser: string | null;
  /** True when the open multi-line string is a docstring and counts as a comment. */
  stringIsDoc: boolean;
  /** True when the open multi-line string ignores escape sequences. */
  stringIsRaw: boolean;
}

function initialState(): ParserState {
  return {
    blockCloser: null,
    blockOpener: null,
    blockDepth: 0,
    stringCloser: null,
    stringIsDoc: false,
    stringIsRaw: false,
  };
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v';
}

type OpenerKind = 'line' | 'block' | 'doc' | 'multiline';

interface Opener {
  kind: OpenerKind;
  token: string;
  /** Closing token; empty for line comments. */
  closer: string;
  raw: boolean;
}

/** Matches the opening of a Rust raw string: `r"`, `r#"`, `r##"`, and so on. */
const RUST_RAW_STRING = /^r(#*)"/;

/**
 * Recognises a Rust raw string at `index`, returning the delimiter that closes it. The
 * hash count is variable, so this cannot live in the fixed delimiter table.
 */
function rustRawStringAt(line: string, index: number): Opener | null {
  if (line[index] !== 'r') return null;

  // `r` must start a token, otherwise it is the tail of an identifier like `for"`.
  const previous = index > 0 ? line[index - 1]! : '';
  if (previous && /[\w$]/.test(previous)) return null;

  const match = RUST_RAW_STRING.exec(line.slice(index));
  if (!match) return null;

  const hashes = match[1]!;
  return { kind: 'multiline', token: match[0], closer: `"${hashes}`, raw: true };
}

/**
 * Finds the longest token starting at `index`, across every kind of opener. Longest
 * match is essential where one token prefixes another — Lua's `--` and `--[[`, or
 * Python's `"` and `"""`.
 */
function longestOpener(line: string, index: number, syntax: CommentSyntax): Opener | null {
  const candidates: Opener[] = [];

  for (const token of syntax.line) {
    candidates.push({ kind: 'line', token, closer: '', raw: false });
  }
  for (const [open, close] of syntax.block) {
    candidates.push({ kind: 'block', token: open, closer: close, raw: false });
  }
  for (const doc of syntax.docStrings ?? []) {
    candidates.push({ kind: 'doc', token: doc.open, closer: doc.close, raw: doc.raw ?? false });
  }
  for (const multi of syntax.multilineStrings ?? []) {
    candidates.push({
      kind: 'multiline',
      token: multi.open,
      closer: multi.close,
      raw: multi.raw ?? false,
    });
  }

  let best: Opener | null = syntax.rustRawStrings ? rustRawStringAt(line, index) : null;

  for (const candidate of candidates) {
    if (candidate.token.length <= (best?.token.length ?? 0)) continue;
    if (!line.startsWith(candidate.token, index)) continue;
    best = candidate;
  }

  return best;
}

/**
 * Classifies one line, mutating `state` for the next one.
 * Returns which kinds of content the line held.
 */
function scanLine(
  line: string,
  syntax: CommentSyntax,
  state: ParserState,
): { hasCode: boolean; hasComment: boolean } {
  let hasCode = false;
  let hasComment = false;
  const escape = syntax.escape ?? '\\';
  let i = 0;

  while (i < line.length) {
    // Inside a block comment: everything belongs to the comment until the closer.
    if (state.blockCloser) {
      hasComment = true;

      if (syntax.nestedBlocks && state.blockOpener && line.startsWith(state.blockOpener, i)) {
        state.blockDepth += 1;
        i += state.blockOpener.length;
        continue;
      }

      if (line.startsWith(state.blockCloser, i)) {
        i += state.blockCloser.length;
        state.blockDepth -= 1;
        if (state.blockDepth <= 0) {
          state.blockCloser = null;
          state.blockOpener = null;
          state.blockDepth = 0;
        }
        continue;
      }

      i += 1;
      continue;
    }

    // Inside a multi-line string: code, unless it is a docstring.
    if (state.stringCloser) {
      if (state.stringIsDoc) hasComment = true;
      else hasCode = true;

      // Raw strings take backslashes literally; treating one as an escape here would
      // swallow the closing delimiter and corrupt every line that follows.
      if (!state.stringIsRaw && escape && line.startsWith(escape, i)) {
        i += escape.length + 1;
        continue;
      }

      if (line.startsWith(state.stringCloser, i)) {
        i += state.stringCloser.length;
        state.stringCloser = null;
        state.stringIsDoc = false;
        state.stringIsRaw = false;
        continue;
      }

      i += 1;
      continue;
    }

    const char = line[i]!;

    if (isWhitespace(char)) {
      i += 1;
      continue;
    }

    // Longest match wins across all opener kinds. This matters wherever one token is a
    // prefix of another: Lua's `--` line comment versus its `--[[` block comment, or
    // Python's `"` versus `"""`.
    const opener = longestOpener(line, i, syntax);

    if (opener) {
      switch (opener.kind) {
        case 'line':
          // The rest of the line belongs to the comment.
          hasComment = true;
          return { hasCode, hasComment };

        case 'block':
          hasComment = true;
          state.blockOpener = opener.token;
          state.blockCloser = opener.closer;
          state.blockDepth = 1;
          i += opener.token.length;
          continue;

        case 'doc': {
          // A docstring is documentation only when it opens the statement; in
          // `x = """…"""` the triple quote is just a string.
          const isDocumentation = !hasCode;
          if (isDocumentation) hasComment = true;
          else hasCode = true;
          state.stringCloser = opener.closer;
          state.stringIsDoc = isDocumentation;
          state.stringIsRaw = opener.raw;
          i += opener.token.length;
          continue;
        }

        case 'multiline':
          hasCode = true;
          state.stringCloser = opener.closer;
          state.stringIsDoc = false;
          state.stringIsRaw = opener.raw;
          i += opener.token.length;
          continue;
      }
    }

    // Single-line string literal. Scanned inline; an unterminated one is assumed to end
    // with the line, which is true in every language in our table.
    if (syntax.quotes.includes(char)) {
      hasCode = true;
      i += 1;
      while (i < line.length) {
        if (escape && line.startsWith(escape, i)) {
          i += escape.length + 1;
          continue;
        }
        if (line[i] === char) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    hasCode = true;
    i += 1;
  }

  return { hasCode, hasComment };
}

/**
 * Incremental line counter. Feed it chunks of decoded text in order, then call
 * `finish()`. Chunk boundaries are handled by holding back the trailing partial line,
 * so a file never has to be assembled in memory.
 */
export class LineCounter {
  private readonly state = initialState();
  private pending = '';
  private total = 0;
  private blank = 0;
  private comment = 0;
  private code = 0;
  private finished = false;

  constructor(private readonly syntax: CommentSyntax | null) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.pending += chunk;

    let start = 0;
    let newline = this.pending.indexOf('\n', start);
    while (newline !== -1) {
      this.countLine(this.pending.slice(start, newline));
      start = newline + 1;
      newline = this.pending.indexOf('\n', start);
    }
    this.pending = this.pending.slice(start);
  }

  finish(): LineStats {
    if (!this.finished) {
      // A file not ending in a newline still has a final line.
      if (this.pending.length > 0) this.countLine(this.pending);
      this.pending = '';
      this.finished = true;
    }

    return {
      total: this.total,
      blank: this.blank,
      comment: this.syntax ? this.comment : null,
      code: this.code,
    };
  }

  private countLine(rawLine: string): void {
    // Strip the CR of CRLF endings so it does not count as content.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    this.total += 1;

    if (line.trim() === '') {
      this.blank += 1;
      return;
    }

    // Without comment syntax we cannot separate comments, so everything non-blank is
    // code and `comment` is reported as unknown.
    if (!this.syntax) {
      this.code += 1;
      return;
    }

    const { hasCode, hasComment } = scanLine(line, this.syntax, this.state);
    if (hasCode || !hasComment) this.code += 1;
    else this.comment += 1;
  }
}

/** Convenience wrapper for counting a string in one go. */
export function countLines(text: string, syntax: CommentSyntax | null): LineStats {
  const counter = new LineCounter(syntax);
  counter.push(text);
  return counter.finish();
}
