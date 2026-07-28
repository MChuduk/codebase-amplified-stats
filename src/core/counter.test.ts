import { describe, expect, it } from 'vitest';
import { LineCounter, countLines } from './counter';
import { syntaxFor } from './comment-syntax';

/** Counts `text` as `language`, returning [total, blank, comment, code]. */
function count(language: string, text: string): [number, number, number | null, number] {
  const stats = countLines(text, syntaxFor(language));
  return [stats.total, stats.blank, stats.comment, stats.code];
}

describe('line totals', () => {
  it('counts a file without a trailing newline', () => {
    expect(count('JavaScript', 'a\nb')).toEqual([2, 0, 0, 2]);
  });

  it('counts a file with a trailing newline', () => {
    expect(count('JavaScript', 'a\nb\n')).toEqual([2, 0, 0, 2]);
  });

  it('returns zeroes for an empty file', () => {
    expect(count('JavaScript', '')).toEqual([0, 0, 0, 0]);
  });

  it('counts a file that is a single newline as one blank line', () => {
    expect(count('JavaScript', '\n')).toEqual([1, 1, 0, 0]);
  });

  it('handles CRLF endings without counting the CR as content', () => {
    expect(count('JavaScript', 'let a = 1;\r\n\r\n// note\r\n')).toEqual([3, 1, 1, 1]);
  });

  it('always satisfies total = blank + comment + code', () => {
    const source = `// header\n\nfunction f() {\n  /* block\n     continues */\n  return 1; // trailing\n}\n`;
    const stats = countLines(source, syntaxFor('JavaScript'));
    expect(stats.blank + (stats.comment ?? 0) + stats.code).toBe(stats.total);
  });
});

describe('comment detection', () => {
  it('separates line comments from code', () => {
    expect(count('JavaScript', '// a\nlet x = 1;\n\n// b\n')).toEqual([4, 1, 2, 1]);
  });

  it('counts a line with both code and a comment as code', () => {
    expect(count('JavaScript', 'let x = 1; // why\n')).toEqual([1, 0, 0, 1]);
  });

  it('spans block comments across lines', () => {
    expect(count('JavaScript', '/*\n * doc\n */\nlet x = 1;\n')).toEqual([4, 0, 3, 1]);
  });

  it('resumes code on the same line a block comment closes', () => {
    expect(count('JavaScript', '/* lead */ let x = 1;\n')).toEqual([1, 0, 0, 1]);
  });

  it('treats blank lines inside block comments as blank', () => {
    expect(count('JavaScript', '/*\n\n*/\n')).toEqual([3, 1, 2, 0]);
  });
});

describe('strings versus comments', () => {
  it('ignores comment tokens inside string literals', () => {
    expect(count('JavaScript', 'const s = "// not a comment";\n')).toEqual([1, 0, 0, 1]);
    expect(count('JavaScript', "const s = '/* nope */';\n")).toEqual([1, 0, 0, 1]);
  });

  it('ignores quotes inside comments', () => {
    expect(count('JavaScript', '// it\'s fine\nlet x = 1;\n')).toEqual([2, 0, 1, 1]);
  });

  it('respects escaped quotes', () => {
    expect(count('JavaScript', 'const s = "a\\"// b";\nlet x = 1;\n')).toEqual([2, 0, 0, 2]);
  });

  it('counts template literals spanning lines as code', () => {
    expect(count('JavaScript', 'const s = `\n// still a string\n`;\n')).toEqual([3, 0, 0, 3]);
  });

  it('counts Go raw strings as code', () => {
    expect(count('Go', 'var s = `\n// text\n`\n')).toEqual([3, 0, 0, 3]);
  });
});

describe('raw strings', () => {
  it('ignores backslashes inside Go backtick strings', () => {
    // Treating `\*` as an escape would swallow the closing backtick and corrupt the
    // rest of the file — this cost 443 lines on gin's tree_test.go.
    expect(count('Go', 'x := `/who/are/\\*you`\ny := 1\n')).toEqual([2, 0, 0, 2]);
  });

  it('does not see comments inside Go raw strings', () => {
    expect(count('Go', 'x := `\n// not a comment\n`\ny := 1\n')).toEqual([4, 0, 0, 4]);
  });

  it('handles Rust raw strings with hashes', () => {
    expect(count('Rust', 'let s = r#"// not a comment"#;\n')).toEqual([1, 0, 0, 1]);
    expect(count('Rust', 'let s = r##"has "# inside"##;\n')).toEqual([1, 0, 0, 1]);
  });

  it('spans Rust raw strings across lines', () => {
    expect(count('Rust', 'let s = r"\n/* not a comment */\n";\n')).toEqual([3, 0, 0, 3]);
  });

  it('does not mistake an identifier ending in r for a raw string', () => {
    expect(count('Rust', 'let user = "text"; // note\n')).toEqual([1, 0, 0, 1]);
  });

  it('treats a comment token inside a Go string as text', () => {
    // Both tokei and cloc get this wrong: `"/src/*filepath"` is a string, not a comment.
    expect(count('Go', 'routes := []string{"/src/*filepath"}\nx := 1\n')).toEqual([2, 0, 0, 2]);
  });
});

describe('nested block comments', () => {
  it('requires matching closers in Rust', () => {
    // The inner `*/` closes only the inner comment; code resumes after the outer one.
    expect(count('Rust', '/* a /* b */ still comment */ let x = 1;\n')).toEqual([1, 0, 0, 1]);
  });

  it('keeps a nested comment open across lines', () => {
    const source = '/* outer\n/* inner */\nstill comment\n*/\nfn main() {}\n';
    expect(count('Rust', source)).toEqual([5, 0, 4, 1]);
  });

  it('does not nest in C, where the first closer ends the comment', () => {
    expect(count('C', '/* a /* b */ int x;\n')).toEqual([1, 0, 0, 1]);
  });
});

describe('Python', () => {
  it('counts a leading docstring as a comment', () => {
    expect(count('Python', '"""Module doc."""\nimport os\n')).toEqual([2, 0, 1, 1]);
  });

  it('counts a multi-line docstring as comments', () => {
    expect(count('Python', '"""\nLong doc.\n"""\nx = 1\n')).toEqual([4, 0, 3, 1]);
  });

  it('counts an assigned triple-quoted string as code', () => {
    expect(count('Python', 'x = """\nvalue\n"""\n')).toEqual([3, 0, 0, 3]);
  });

  it('handles hash comments and shebangs', () => {
    expect(count('Python', '#!/usr/bin/env python\n# note\nx = 1\n')).toEqual([3, 0, 2, 1]);
  });

  it('ignores a hash inside a string', () => {
    expect(count('Python', 'url = "http://x/#frag"\n')).toEqual([1, 0, 0, 1]);
  });
});

describe('other language families', () => {
  it('handles HTML comments', () => {
    expect(count('HTML', '<!-- note -->\n<p>hi</p>\n')).toEqual([2, 0, 1, 1]);
  });

  it('handles Ruby block comments', () => {
    expect(count('Ruby', '=begin\ndoc\n=end\nputs 1\n')).toEqual([4, 0, 3, 1]);
  });

  it('handles SQL double-dash comments', () => {
    expect(count('SQL', '-- note\nSELECT 1;\n')).toEqual([2, 0, 1, 1]);
  });

  it('handles Lua block comments', () => {
    expect(count('Lua', '--[[ doc\nmore ]]\nprint(1)\n')).toEqual([3, 0, 2, 1]);
  });

  it('handles Haskell nested block comments', () => {
    expect(count('Haskell', '{- a {- b -} c -}\nmain = pure ()\n')).toEqual([2, 0, 1, 1]);
  });

  it('handles PHP hash and slash comments', () => {
    expect(count('PHP', '# a\n// b\n$x = 1;\n')).toEqual([3, 0, 2, 1]);
  });
});

describe('languages without comment syntax', () => {
  it('reports comment as unknown and counts content as code', () => {
    const stats = countLines('a\n\nb\n', null);
    expect(stats).toEqual({ total: 3, blank: 1, comment: null, code: 2 });
  });
});

describe('streaming', () => {
  it('produces the same result regardless of chunk boundaries', () => {
    const source = '/* block\n * doc\n */\nconst s = "// x";\n\nlet y = 2; // t\n';
    const whole = countLines(source, syntaxFor('JavaScript'));

    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      const counter = new LineCounter(syntaxFor('JavaScript'));
      for (let i = 0; i < source.length; i += size) {
        counter.push(source.slice(i, i + size));
      }
      expect(counter.finish(), `chunk size ${size}`).toEqual(whole);
    }
  });

  it('is idempotent when finish is called twice', () => {
    const counter = new LineCounter(syntaxFor('Go'));
    counter.push('package main\n');
    expect(counter.finish()).toEqual(counter.finish());
  });
});
