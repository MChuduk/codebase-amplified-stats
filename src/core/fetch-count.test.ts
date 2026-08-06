import { afterEach, describe, expect, it, vi } from 'vitest';
import { countBytes, countFile } from './fetch-count';
import type { CountableFile, RepoRef } from './types';

/**
 * The two counting paths have to agree.
 *
 * `countFile` streams from the network; `countBytes` takes a file already unpacked from
 * the repository archive. They are chosen per run by a size heuristic, so any difference
 * between them would show up as the same repository reporting two different numbers.
 */

const encoder = new TextEncoder();
const repo: RepoRef = { owner: 'octocat', repo: 'hello' };

function fileOf(path: string, language: string): CountableFile {
  return { path, sha: `sha-${path}`, size: 0, language, category: 'code' };
}

/** Serves `bytes` in fixed-size chunks, so the streaming decoder meets real boundaries. */
function serve(bytes: Uint8Array, chunkSize = bytes.length || 1): void {
  vi.stubGlobal('fetch', async () => {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
    return new Response(body);
  });
}

async function bothWays(file: CountableFile, bytes: Uint8Array, chunkSize?: number) {
  serve(bytes, chunkSize);
  return {
    streamed: await countFile(file, { repo, commitSha: 'commit' }),
    unpacked: countBytes(file, bytes),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('countBytes matches countFile', () => {
  it('agrees on code, comments and blank lines', async () => {
    const source = [
      '// a leading comment',
      'const a = 1;',
      '',
      '/* block',
      '   comment */',
      'export default a;',
      '',
    ].join('\n');

    const { streamed, unpacked } = await bothWays(
      fileOf('src/a.ts', 'TypeScript'),
      encoder.encode(source),
    );

    expect(streamed).toEqual(unpacked);
    expect(streamed?.stats.code).toBe(2);
  });

  it('agrees when the bytes arrive in awkward chunks', async () => {
    // Multibyte characters land across chunk boundaries, which the streaming decoder has
    // to stitch back together and the one-shot decode never sees.
    const source = `${'const привет = "日本語"; // комментарий\n'.repeat(400)}`;
    const bytes = encoder.encode(source);

    const { streamed, unpacked } = await bothWays(fileOf('src/b.ts', 'TypeScript'), bytes, 7);

    expect(streamed).toEqual(unpacked);
    expect(streamed?.stats.total).toBe(400);
  });

  it('agrees that a NUL byte early on means binary', async () => {
    const bytes = encoder.encode('PK\u0000\u0000not really typescript');
    const { streamed, unpacked } = await bothWays(fileOf('src/c.ts', 'TypeScript'), bytes);

    expect(streamed).toBeNull();
    expect(unpacked).toBeNull();
  });

  it('agrees that a NUL byte past the scan window does not', async () => {
    // Where the stream happens to break must not decide this, so the file is served in
    // one chunk that spans the window and the NUL alike.
    const bytes = encoder.encode(`${'x = 1;\n'.repeat(2000)}\u0000tail`);
    const { streamed, unpacked } = await bothWays(fileOf('src/d.ts', 'TypeScript'), bytes);

    expect(streamed).toEqual(unpacked);
    expect(streamed).not.toBeNull();
  });

  it('agrees on an empty file', async () => {
    const { streamed, unpacked } = await bothWays(fileOf('src/e.ts', 'TypeScript'), new Uint8Array(0));
    expect(streamed).toEqual(unpacked);
  });

  it('agrees on a language with no comment syntax', async () => {
    const bytes = encoder.encode('one\n\ntwo\n');
    const { streamed, unpacked } = await bothWays(fileOf('data.unknown', 'Nonexistent'), bytes);

    expect(streamed).toEqual(unpacked);
  });
});

describe('countFile', () => {
  it('throws with the status for a failed request', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));

    await expect(
      countFile(fileOf('src/gone.ts', 'TypeScript'), { repo, commitSha: 'commit' }),
    ).rejects.toThrow('HTTP 404');
  });
});
