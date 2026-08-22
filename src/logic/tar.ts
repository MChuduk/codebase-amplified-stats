/**
 * Streaming reader for repository archives, the extension's only source of file
 * contents. Nothing is buffered beyond the file currently being handed out, which keeps a
 * multi-gigabyte repository a question of time rather than of memory.
 *
 * The tar format is simple enough that a parser is smaller than a dependency: 512-byte
 * headers, each followed by the file's bytes padded up to the next 512-byte boundary.
 */

const BLOCK = 512;

/** Where the fields we need live inside a header block. */
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

export interface TarEntry {
  /** Path within the repository, with the archive's top-level directory removed. */
  path: string;
  size: number;
}

/**
 * Called for every regular file in the archive.
 *
 * Returning `false` skips the body without ever assembling it — that is what makes
 * pulling a whole archive affordable when only a fraction of it is worth counting.
 * The callback may take as long as it likes; the stream is not read while it runs, which
 * is the backpressure that keeps memory flat on a large repository.
 */
export type TarHandler = (
  entry: TarEntry,
  read: () => Promise<Uint8Array>,
) => Promise<boolean | void> | boolean | void;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

/**
 * Reads a gzipped tar from a byte stream, handing each regular file to `onEntry`.
 *
 * Hosts wrap everything in a single top-level directory — `{repo}-{sha}/` on GitHub,
 * `{repo}-{sha}-{sha}/` on GitLab — so that leading component is stripped and paths line
 * up with the ones from the tree listing.
 */
export async function readTarball(
  stream: ReadableStream<Uint8Array>,
  onEntry: TarHandler,
  signal?: AbortSignal,
): Promise<void> {
  // The DOM types declare the gzip stream's writable side as taking any `BufferSource`,
  // which `pipeThrough` will not reconcile with a stream of `Uint8Array` on its own.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;

  const reader = stream.pipeThrough(gunzip).getReader();
  const bytes = new ByteQueue(reader, signal);

  /** GNU stores over-long names in a preceding `L` record rather than in the header. */
  let pendingLongName: string | null = null;
  /** PAX stores them in a preceding `x` record, as `length key=value\n` runs. */
  let pendingPaxPath: string | null = null;
  let emptyBlocks = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');

      const header = await bytes.take(BLOCK);
      if (!header) break;

      // Two consecutive zero blocks mark the end of the archive.
      if (isZero(header)) {
        if (++emptyBlocks >= 2) break;
        continue;
      }
      emptyBlocks = 0;

      const size = parseOctal(header, SIZE_OFFSET, SIZE_LENGTH);
      const typeflag = String.fromCharCode(header[TYPEFLAG_OFFSET] || 0x30);
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      if (typeflag === 'L') {
        pendingLongName = trimNul(decodeAscii(await bytes.exactly(padded, size)));
        continue;
      }

      if (typeflag === 'x' || typeflag === 'g') {
        const path = paxPath(decodeAscii(await bytes.exactly(padded, size)));
        // A global (`g`) record without a path carries settings we do not care about.
        if (path) pendingPaxPath = path;
        continue;
      }

      const name = pendingPaxPath ?? pendingLongName ?? headerName(header);
      pendingPaxPath = null;
      pendingLongName = null;

      // '0' and '\0' are regular files; directories, links and the rest have no body we
      // want, and their sizes are zero anyway.
      if (typeflag !== '0' && typeflag !== '\0') {
        await bytes.skip(padded);
        continue;
      }

      const path = stripTopLevel(name);
      let consumed = false;

      const wanted = await onEntry({ path, size }, async () => {
        consumed = true;
        return bytes.exactly(padded, size);
      });

      if (!consumed) {
        if (wanted === true) throw new TarError(`entry ${path} was accepted but never read`);
        await bytes.skip(padded);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Drops the single directory every host wraps its archive in, whatever it is named. */
function stripTopLevel(name: string): string {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

function headerName(header: Uint8Array): string {
  const name = trimNul(decodeAscii(header.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH)));
  const prefix = trimNul(
    decodeAscii(header.subarray(PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_LENGTH)),
  );
  return prefix ? `${prefix}/${name}` : name;
}

/** Pulls `path` out of a PAX extended header's `length key=value\n` records. */
function paxPath(text: string): string | null {
  let offset = 0;

  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;

    const length = Number(text.slice(offset, space));
    if (!Number.isFinite(length) || length <= 0) break;

    const record = text.slice(space + 1, offset + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') return record.slice(equals + 1);

    offset += length;
  }

  return null;
}

function parseOctal(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);

  // GNU switches to base-256 for sizes that will not fit in the octal field.
  if ((field[0] ?? 0) & 0x80) {
    let value = (field[0] ?? 0) & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + (field[i] ?? 0);
    return value;
  }

  const text = trimNul(decodeAscii(field)).trim();
  if (!text) return 0;

  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) throw new TarError(`bad size field "${text}"`);
  return value;
}

function isZero(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

const ASCII = new TextDecoder('utf-8', { fatal: false });
const decodeAscii = (bytes: Uint8Array) => ASCII.decode(bytes);
const trimNul = (text: string) => {
  const end = text.indexOf('\u0000');
  return end === -1 ? text : text.slice(0, end);
};

/**
 * Buffers a byte stream so the parser can ask for exact runs of bytes.
 *
 * Chunks arrive at whatever size the decompressor produces, which never lines up with
 * tar's 512-byte blocks; this keeps the leftovers and stitches them together, and pulls
 * from the stream only when what it holds is not enough.
 */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private held = 0;
  private ended = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly signal?: AbortSignal,
  ) {}

  /** Exactly `count` bytes, or null at a clean end of stream. */
  async take(count: number): Promise<Uint8Array | null> {
    if (!(await this.fill(count))) return null;
    return this.pull(count);
  }

  /**
   * Reads `padded` bytes and returns the first `size` of them, dropping the padding.
   *
   * The copy is deliberate: what comes back is handed to a worker as a transferable, and
   * transferring a view into a shared chunk would detach bytes the queue still needs.
   */
  async exactly(padded: number, size: number): Promise<Uint8Array> {
    const block = await this.take(padded);
    if (!block) throw new TarError('archive ended in the middle of a file');
    return block.slice(0, size);
  }

  async skip(count: number): Promise<void> {
    let left = count;

    while (left > 0) {
      if (this.held === 0 && !(await this.pump())) {
        throw new TarError('archive ended in the middle of a file');
      }

      const chunk = this.chunks[0]!;
      if (chunk.length <= left) {
        left -= chunk.length;
        this.held -= chunk.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(left);
        this.held -= left;
        left = 0;
      }
    }
  }

  /** True once at least `count` bytes are held, false if the stream ended first. */
  private async fill(count: number): Promise<boolean> {
    while (this.held < count) {
      if (!(await this.pump())) return false;
    }
    return true;
  }

  private async pump(): Promise<boolean> {
    if (this.ended) return false;
    if (this.signal?.aborted) throw new Error('aborted');

    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return false;
    }
    if (!value?.length) return this.pump();

    this.chunks.push(value);
    this.held += value.length;
    return true;
  }

  /** Removes `count` held bytes, copying only when they span more than one chunk. */
  private pull(count: number): Uint8Array {
    const first = this.chunks[0]!;

    if (first.length === count) {
      this.chunks.shift();
      this.held -= count;
      return first;
    }

    if (first.length > count) {
      this.chunks[0] = first.subarray(count);
      this.held -= count;
      return first.subarray(0, count);
    }

    const joined = new Uint8Array(count);
    let offset = 0;

    while (offset < count) {
      const chunk = this.chunks[0]!;
      const take = Math.min(chunk.length, count - offset);
      joined.set(chunk.subarray(0, take), offset);

      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);

      offset += take;
      this.held -= take;
    }

    return joined;
  }
}
