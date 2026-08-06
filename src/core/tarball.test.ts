import { describe, expect, it } from 'vitest';
import { readTarball, shouldUseTarball, tarballUrl, type TarEntry } from './tarball';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Entry {
  name: string;
  data?: string | Uint8Array;
  typeflag?: string;
  prefix?: string;
}

function writeAscii(block: Uint8Array, offset: number, text: string, length: number): void {
  block.set(encoder.encode(text).subarray(0, length), offset);
}

/** A POSIX ustar header block, checksum and all, so the parser sees the real thing. */
function header(name: string, size: number, typeflag: string, prefix: string): Uint8Array {
  const block = new Uint8Array(512);

  writeAscii(block, 0, name, 100);
  writeAscii(block, 100, '0000644\u0000', 8);
  writeAscii(block, 108, '0000000\u0000', 8);
  writeAscii(block, 116, '0000000\u0000', 8);
  writeAscii(block, 124, `${size.toString(8).padStart(11, '0')}\u0000`, 12);
  writeAscii(block, 136, '00000000000\u0000', 12);
  writeAscii(block, 148, '        ', 8); // checksum is computed over spaces here
  block[156] = typeflag.charCodeAt(0);
  writeAscii(block, 257, 'ustar\u0000', 6);
  writeAscii(block, 263, '00', 2);
  writeAscii(block, 345, prefix, 155);

  let sum = 0;
  for (const byte of block) sum += byte;
  writeAscii(block, 148, `${sum.toString(8).padStart(6, '0')}\u0000 `, 8);

  return block;
}

function buildTar(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];

  for (const entry of entries) {
    const data =
      typeof entry.data === 'string' ? encoder.encode(entry.data) : (entry.data ?? new Uint8Array(0));

    parts.push(header(entry.name, data.length, entry.typeflag ?? '0', entry.prefix ?? ''));

    if (data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      parts.push(padded);
    }
  }

  parts.push(new Uint8Array(1024)); // the two zero blocks that end an archive

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return tar;
}

/** Gzips in odd-sized chunks, so decompressed chunks never line up with tar's blocks. */
function gzipStream(bytes: Uint8Array, chunkSize = 333): ReadableStream<Uint8Array> {
  let offset = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  const gzip = new CompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return source.pipeThrough(gzip);
}

/** Reads an archive, taking the bodies of the paths in `want` and skipping the rest. */
async function collect(
  entries: Entry[],
  want?: string[],
): Promise<{ seen: TarEntry[]; bodies: Map<string, string> }> {
  const seen: TarEntry[] = [];
  const bodies = new Map<string, string>();

  await readTarball(gzipStream(buildTar(entries)), async (entry, read) => {
    seen.push(entry);
    if (want && !want.includes(entry.path)) return false;
    bodies.set(entry.path, decoder.decode(await read()));
    return true;
  });

  return { seen, bodies };
}

/**
 * A PAX record: `length key=value\n`, where `length` counts its own digits too — so the
 * figure has to settle on itself.
 */
function paxRecord(key: string, value: string): string {
  const tail = ` ${key}=${value}\n`;
  let length = tail.length + 1;
  for (;;) {
    const next = String(length).length + tail.length;
    if (next === length) break;
    length = next;
  }
  return `${length}${tail}`;
}

describe('tarballUrl', () => {
  it('points at codeload for the exact commit', () => {
    expect(tarballUrl({ owner: 'facebook', repo: 'react' }, 'abc123')).toBe(
      'https://codeload.github.com/facebook/react/tar.gz/abc123',
    );
  });
});

describe('shouldUseTarball', () => {
  const cold = { toDownload: 5000, totalFiles: 6000, sizeKb: 40_000 };

  it('takes the archive for a large cold repository', () => {
    expect(shouldUseTarball(cold)).toBe(true);
  });

  it('leaves small repositories on the per-file path', () => {
    expect(shouldUseTarball({ ...cold, toDownload: 399, totalFiles: 399 })).toBe(false);
    expect(shouldUseTarball({ ...cold, toDownload: 400, totalFiles: 400 })).toBe(true);
  });

  it('leaves a warm repository alone when most files are already counted', () => {
    // A new commit touched 500 files out of 6000 — worth 500 requests, not a whole archive.
    expect(shouldUseTarball({ ...cold, toDownload: 500 })).toBe(false);
  });

  it('refuses repositories too big to pull down in one go', () => {
    expect(shouldUseTarball({ ...cold, sizeKb: 500_001 })).toBe(false);
    expect(shouldUseTarball({ ...cold, sizeKb: 500_000 })).toBe(true);
  });
});

describe('readTarball', () => {
  it('strips the archive top-level directory from every path', async () => {
    const { seen } = await collect([
      { name: 'react-abc123/', typeflag: '5' },
      { name: 'react-abc123/package.json', data: '{}' },
      { name: 'react-abc123/src/index.ts', data: 'export {};' },
    ]);

    expect(seen.map((entry) => entry.path)).toEqual(['package.json', 'src/index.ts']);
  });

  it('reads bodies whose length is not a multiple of the block size', async () => {
    const long = 'x'.repeat(1500);
    const { bodies } = await collect([
      { name: 'repo-sha/a.txt', data: 'hello' },
      { name: 'repo-sha/b.txt', data: long },
      { name: 'repo-sha/c.txt', data: 'tail' },
    ]);

    expect(bodies.get('a.txt')).toBe('hello');
    expect(bodies.get('b.txt')).toBe(long);
    expect(bodies.get('c.txt')).toBe('tail');
  });

  it('lands on the next header after a body it was told to skip', async () => {
    const { seen, bodies } = await collect(
      [
        { name: 'repo-sha/skip.bin', data: 'y'.repeat(2000) },
        { name: 'repo-sha/keep.ts', data: 'const a = 1;' },
      ],
      ['keep.ts'],
    );

    expect(seen.map((entry) => entry.path)).toEqual(['skip.bin', 'keep.ts']);
    expect(bodies.get('keep.ts')).toBe('const a = 1;');
    expect(bodies.has('skip.bin')).toBe(false);
  });

  it('reports the size from the header even when the body is skipped', async () => {
    const { seen } = await collect([{ name: 'repo-sha/big.txt', data: 'z'.repeat(700) }], []);
    expect(seen).toEqual([{ path: 'big.txt', size: 700 }]);
  });

  it('resolves GNU long names from the preceding L record', async () => {
    const long = `repo-sha/${'deep/'.repeat(30)}file.ts`;
    const { seen, bodies } = await collect([
      { name: '././@LongLink', typeflag: 'L', data: `${long}\u0000` },
      { name: 'repo-sha/truncated-placeholder', data: 'value' },
    ]);

    expect(seen.map((entry) => entry.path)).toEqual([`${'deep/'.repeat(30)}file.ts`]);
    expect(bodies.get(`${'deep/'.repeat(30)}file.ts`)).toBe('value');
  });

  it('resolves PAX paths from the preceding x record', async () => {
    const expected = `${'nested/'.repeat(20)}component.tsx`;

    const { seen } = await collect([
      { name: 'PaxHeaders/0', typeflag: 'x', data: paxRecord('path', `repo-sha/${expected}`) },
      { name: 'repo-sha/placeholder', data: 'x' },
    ]);

    expect(seen.map((entry) => entry.path)).toEqual([expected]);
  });

  it('skips directories, symlinks and submodules', async () => {
    const { seen } = await collect([
      { name: 'repo-sha/src/', typeflag: '5' },
      { name: 'repo-sha/link.ts', typeflag: '2' },
      { name: 'repo-sha/real.ts', data: 'ok' },
    ]);

    expect(seen.map((entry) => entry.path)).toEqual(['real.ts']);
  });

  it('joins the ustar prefix field back onto the name', async () => {
    const { seen } = await collect([
      { name: 'index.ts', prefix: 'repo-sha/packages/core/src', data: 'ok' },
    ]);

    expect(seen.map((entry) => entry.path)).toEqual(['packages/core/src/index.ts']);
  });

  it('stops at the end-of-archive blocks and ignores nothing before them', async () => {
    const { seen } = await collect([
      { name: 'repo-sha/one.ts', data: 'a' },
      { name: 'repo-sha/two.ts', data: 'b' },
      { name: 'repo-sha/three.ts', data: 'c' },
    ]);

    expect(seen).toHaveLength(3);
  });
});
