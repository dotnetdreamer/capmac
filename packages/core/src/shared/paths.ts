/**
 * Maps paths inside the Mac's mirror of the project back to the original
 * Windows paths, so compiler errors are clickable in the Windows terminal.
 */
import path from 'node:path';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class PathMapper {
  private readonly remoteRoot: string;
  private readonly pattern: RegExp;

  constructor(remoteRoot: string, private readonly localRoot: string, private readonly localPath: typeof path.win32 | typeof path.posix = path.win32) {
    this.remoteRoot = remoteRoot.replace(/\/+$/, '');
    this.pattern = new RegExp(`${escapeRegExp(this.remoteRoot)}((?:/[^\\s:'"\`(),;]*)?)`, 'g');
  }

  /** Converts one remote absolute path; returns it unchanged if it is outside the mirror. */
  toLocal(remotePath: string): string {
    if (remotePath !== this.remoteRoot && !remotePath.startsWith(`${this.remoteRoot}/`)) return remotePath;
    const rest = remotePath.slice(this.remoteRoot.length).split('/').filter(Boolean);
    return rest.length ? this.localPath.join(this.localRoot, ...rest) : this.localRoot;
  }

  /** Rewrites every mirror path that appears in a line of text. */
  mapText(text: string): string {
    if (!text.includes(this.remoteRoot)) return text;
    return text.replace(this.pattern, (_match, rest: string) => this.toLocal(`${this.remoteRoot}${rest}`));
  }
}

/** Converts a local path relative to `root` into a POSIX relative path. */
export function toPosixRel(root: string, abs: string, localPath: typeof path.win32 | typeof path.posix = path): string {
  return localPath.relative(root, abs).split(localPath.sep).join('/');
}
