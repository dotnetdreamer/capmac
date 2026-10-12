import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeRelPath, crlfToLf, packArchive, unpackArchive, type ArchiveFile } from '../../src/shared/archive.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'capmac-archive-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

async function* replay(chunks: Buffer[], chunkSize = 7): AsyncGenerator<Buffer> {
  const all = Buffer.concat(chunks);
  for (let i = 0; i < all.length; i += chunkSize) yield all.subarray(i, i + chunkSize);
}

describe('archive', () => {
  it('round-trips small, empty, unicode, nested and large files', async () => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    await fs.mkdir(path.join(src, 'a', 'b'), { recursive: true });
    const large = Buffer.alloc(2 * 1024 * 1024 + 123);
    for (let i = 0; i < large.length; i++) large[i] = (i * 31) % 251;
    const files: Record<string, Buffer> = {
      'empty.txt': Buffer.alloc(0),
      'a/b/hello.swift': Buffer.from('print("hi")\n'),
      'ünï cødé/файл.json': Buffer.from('{"ok":true}'),
      'big/blob.bin': large,
    };
    const list: ArchiveFile[] = [];
    for (const [rel, data] of Object.entries(files)) {
      const abs = path.join(src, ...rel.split('/'));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, data);
      list.push({ rel, abs, mode: 0o644 });
    }
    const chunks = await collect(packArchive(list));
    const written: string[] = [];
    const result = await unpackArchive(replay(chunks, 997), { root: dest, onFile: (rel) => written.push(rel) });
    expect(result.files).toBe(4);
    for (const [rel, data] of Object.entries(files)) {
      const got = await fs.readFile(path.join(dest, ...rel.split('/')));
      expect(got.equals(data)).toBe(true);
    }
    expect(written.sort()).toEqual(Object.keys(files).sort());
  });

  it('converts CRLF to LF for scripts and keeps the exec bit', async () => {
    const abs = path.join(tmp, 'run.sh');
    await fs.writeFile(abs, '#!/bin/sh\r\necho hi\r\n');
    const chunks = await collect(packArchive([{ rel: 'run.sh', abs, mode: 0o755, toLf: true }]));
    const dest = path.join(tmp, 'out');
    await unpackArchive(replay(chunks), { root: dest });
    expect(await fs.readFile(path.join(dest, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    if (process.platform !== 'win32') {
      const st = await fs.stat(path.join(dest, 'run.sh'));
      expect(st.mode & 0o777).toBe(0o755);
    }
  });

  it('replaces a file with a directory and vice versa', async () => {
    const dest = path.join(tmp, 'out');
    await fs.mkdir(path.join(dest, 'x'), { recursive: true });
    await fs.writeFile(path.join(dest, 'x', 'inner.txt'), 'old');
    await fs.writeFile(path.join(dest, 'y'), 'was a file');
    const a = path.join(tmp, 'a.txt');
    await fs.writeFile(a, 'new');
    const chunks = await collect(packArchive([
      { rel: 'x', abs: a, mode: 0o644 },
      { rel: 'y/z.txt', abs: a, mode: 0o644 },
    ]));
    await unpackArchive(replay(chunks), { root: dest });
    expect(await fs.readFile(path.join(dest, 'x'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(dest, 'y', 'z.txt'), 'utf8')).toBe('new');
  });

  it('skips files that vanish while packing', async () => {
    const present = path.join(tmp, 'present.txt');
    await fs.writeFile(present, 'here');
    const skipped: string[] = [];
    const chunks = await collect(packArchive([
      { rel: 'gone.txt', abs: path.join(tmp, 'gone.txt'), mode: 0o644 },
      { rel: 'present.txt', abs: present, mode: 0o644 },
    ], { onSkip: (rel) => skipped.push(rel) }));
    const result = await unpackArchive(replay(chunks), { root: path.join(tmp, 'out') });
    expect(skipped).toEqual(['gone.txt']);
    expect(result.files).toBe(1);
  });

  it('refuses unsafe paths', () => {
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a/./b', 'C:/x', 'a\\b', 'a\0b']) {
      expect(() => assertSafeRelPath(bad), bad).toThrow(/Unsafe/);
    }
    expect(() => assertSafeRelPath('ios/App/App/AppDelegate.swift')).not.toThrow();
    expect(() => assertSafeRelPath('.hidden/..dots/file..ext')).not.toThrow();
  });

  it('converts only CRLF pairs', () => {
    expect(crlfToLf(Buffer.from('a\r\nb\rc\n')).toString()).toBe('a\nb\rc\n');
  });
});
