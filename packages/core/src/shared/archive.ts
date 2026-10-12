/**
 * Streaming file archive used for project sync (Windows -> Mac) and pulls
 * (Mac -> Windows). It is a gzip stream of entries:
 *
 *   file entry: u8 type=1 | u16 pathLength | path (UTF-8, POSIX, relative)
 *               | u32 mode | u32 sizeHigh | u32 sizeLow | data
 *   end entry:  u8 type=0
 *
 * Paths are validated on extraction so an archive can never write outside
 * its destination root.
 */
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

const ENTRY_END = 0;
const ENTRY_FILE = 1;
const READ_CHUNK = 256 * 1024;
const SMALL_FILE = 1024 * 1024;

export interface ArchiveFile {
  /** POSIX path relative to the archive root. */
  rel: string;
  /** Absolute path to read the file from. */
  abs: string;
  /** Unix permission bits (0o644, 0o755, ...). */
  mode: number;
  /** Convert CRLF to LF while packing (shell scripts checked out on Windows). */
  toLf?: boolean;
}

export interface PackOptions {
  level?: number;
  onFile?: (rel: string, bytes: number) => void;
  /** Called for files that vanished or could not be opened; they are left out. */
  onSkip?: (rel: string, error: Error) => void;
}

export interface UnpackOptions {
  root: string;
  onFile?: (rel: string, bytes: number) => void;
  /** Max concurrent small-file writes. */
  concurrency?: number;
}

export interface UnpackResult {
  files: number;
  bytes: number;
}

/** Throws unless `rel` is a clean relative POSIX path. */
export function assertSafeRelPath(rel: string): void {
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`Unsafe path in archive: ${JSON.stringify(rel)}`);
  }
  for (const part of rel.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new Error(`Unsafe path in archive: ${JSON.stringify(rel)}`);
    }
  }
}

export function crlfToLf(data: Buffer): Buffer {
  if (!data.includes(13)) return data;
  return Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

function entryHeader(rel: string, mode: number, size: number): Buffer {
  const pathBytes = Buffer.from(rel, 'utf8');
  if (pathBytes.length > 0xffff) throw new Error(`Path too long: ${rel}`);
  const h = Buffer.allocUnsafe(1 + 2 + pathBytes.length + 12);
  let o = 0;
  h.writeUInt8(ENTRY_FILE, o); o += 1;
  h.writeUInt16BE(pathBytes.length, o); o += 2;
  pathBytes.copy(h, o); o += pathBytes.length;
  h.writeUInt32BE(mode & 0o7777, o); o += 4;
  h.writeUInt32BE(Math.floor(size / 0x100000000), o); o += 4;
  h.writeUInt32BE(size % 0x100000000, o);
  return h;
}

async function* rawEntries(files: Iterable<ArchiveFile>, onFile?: PackOptions['onFile'], onSkip?: PackOptions['onSkip']): AsyncGenerator<Buffer> {
  for (const file of files) {
    assertSafeRelPath(file.rel);
    let fh: FileHandle;
    try {
      fh = await fs.open(file.abs, 'r');
    } catch (err: any) {
      if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES', 'EISDIR'].includes(err?.code)) {
        onSkip?.(file.rel, err);
        continue;
      }
      throw err;
    }
    try {
      const { size } = await fh.stat();
      if (file.toLf || size <= SMALL_FILE) {
        let data: Buffer = await fh.readFile();
        if (file.toLf) data = crlfToLf(data);
        yield entryHeader(file.rel, file.mode, data.length);
        if (data.length > 0) yield data;
        onFile?.(file.rel, data.length);
        continue;
      }
      // Large file: stream exactly `size` bytes. If it shrinks while we read,
      // pad with zeros so the stream stays well-formed (next sync fixes it).
      yield entryHeader(file.rel, file.mode, size);
      let position = 0;
      while (position < size) {
        const want = Math.min(READ_CHUNK, size - position);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, position);
        if (bytesRead === 0) {
          yield Buffer.alloc(size - position);
          position = size;
          break;
        }
        yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
        position += bytesRead;
      }
      onFile?.(file.rel, size);
    } finally {
      await fh.close();
    }
  }
  yield Buffer.from([ENTRY_END]);
}

/** Packs files into a gzip-compressed archive stream. */
export async function* packArchive(files: Iterable<ArchiveFile>, options: PackOptions = {}): AsyncGenerator<Buffer> {
  const gzip = zlib.createGzip({ level: options.level ?? 4 });
  const source = Readable.from(rawEntries(files, options.onFile, options.onSkip), { objectMode: false });
  source.on('error', (err) => gzip.destroy(err));
  source.pipe(gzip);
  try {
    for await (const chunk of gzip) yield chunk as Buffer;
  } finally {
    source.destroy();
  }
}

class ByteReader {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly it: AsyncIterator<Buffer>) {}

  private async more(): Promise<void> {
    const next = await this.it.next();
    if (next.done) throw new Error('Archive ended unexpectedly');
    const chunk = next.value as Buffer;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async *stream(n: number): AsyncGenerator<Buffer> {
    let remaining = n;
    while (remaining > 0) {
      if (this.buf.length === 0) await this.more();
      const take = Math.min(remaining, this.buf.length);
      yield this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      remaining -= take;
    }
  }
}

async function prepareParent(root: string, rel: string): Promise<void> {
  const dir = path.dirname(path.join(root, ...rel.split('/')));
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err: any) {
    if (err?.code !== 'EEXIST' && err?.code !== 'ENOTDIR') throw err;
    // A path component that used to be a file is now a directory.
    const parts = rel.split('/').slice(0, -1);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      const st = await fs.lstat(current).catch(() => null);
      if (st && !st.isDirectory()) await fs.rm(current, { force: true });
    }
    await fs.mkdir(dir, { recursive: true });
  }
}

async function placeFile(tmp: string, dest: string, mode: number): Promise<void> {
  await fs.chmod(tmp, mode).catch(() => undefined);
  try {
    await fs.rename(tmp, dest);
  } catch (err: any) {
    // A directory now has to become a file.
    const st = await fs.lstat(dest).catch(() => null);
    if (st?.isDirectory()) {
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(tmp, dest);
    } else {
      throw err;
    }
  }
}

/** Extracts an archive produced by packArchive into `options.root`. */
export async function unpackArchive(chunks: AsyncIterable<Buffer>, options: UnpackOptions): Promise<UnpackResult> {
  const root = path.resolve(options.root);
  await fs.mkdir(root, { recursive: true });
  const gunzip = zlib.createGunzip();
  const feeding = (async () => {
    for await (const chunk of chunks) {
      if (!gunzip.write(chunk)) await once(gunzip, 'drain');
    }
    gunzip.end();
  })().catch((err) => gunzip.destroy(err));

  const reader = new ByteReader(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  const limit = Math.max(1, options.concurrency ?? 16);
  const inflight = new Set<Promise<void>>();
  let firstError: unknown;
  let files = 0;
  let bytes = 0;

  const track = (p: Promise<void>) => {
    const tracked = p.catch((err) => {
      firstError ??= err;
    }).finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  };

  for (;;) {
    if (firstError) break;
    const [type] = await reader.read(1);
    if (type === ENTRY_END) break;
    if (type !== ENTRY_FILE) throw new Error(`Corrupt archive (entry type ${type})`);
    const pathLength = (await reader.read(2)).readUInt16BE(0);
    const rel = (await reader.read(pathLength)).toString('utf8');
    const meta = await reader.read(12);
    const mode = meta.readUInt32BE(0) || 0o644;
    const size = meta.readUInt32BE(4) * 0x100000000 + meta.readUInt32BE(8);
    assertSafeRelPath(rel);
    const dest = path.join(root, ...rel.split('/'));
    const tmp = `${dest}.capmac-part`;

    if (size <= SMALL_FILE) {
      const data = size > 0 ? Buffer.from(await reader.read(size)) : Buffer.alloc(0);
      while (inflight.size >= limit) await Promise.race(inflight);
      track((async () => {
        await prepareParent(root, rel);
        await fs.writeFile(tmp, data);
        await placeFile(tmp, dest, mode);
        options.onFile?.(rel, size);
      })());
    } else {
      await prepareParent(root, rel);
      const fh = await fs.open(tmp, 'w');
      try {
        for await (const piece of reader.stream(size)) await fh.write(piece);
      } finally {
        await fh.close();
      }
      await placeFile(tmp, dest, mode);
      options.onFile?.(rel, size);
    }
    files += 1;
    bytes += size;
  }

  await Promise.all(inflight);
  if (firstError) throw firstError;
  await feeding;
  return { files, bytes };
}
