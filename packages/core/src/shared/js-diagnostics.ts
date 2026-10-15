/**
 * Compiler errors in JavaScript build output (TypeScript, esbuild and Vite,
 * and anything that prints `file:line:col: error: message`), as diagnostics
 * with absolute paths, so the engine can map them to the PC's files.
 */
import path from 'node:path';
import type { Diagnostic } from './protocol.js';

// src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
const TSC_PLAIN = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
// src/index.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;
// ✘ [ERROR] Could not resolve "./missing"     (esbuild; the location follows a few lines later)
const ESBUILD_HEAD = /^\s*(?:✘|X|▲)\s+\[(ERROR|WARNING)\]\s+(.*)$/;
//     src/main.ts:3:19:
const ESBUILD_LOCATION = /^\s+(.+?):(\d+):(\d+):\s*$/;
// file:line:col: error: message
const GENERIC = /^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Turns build output into diagnostics, line by line. Paths are resolved against `cwd` (the folder the tool ran in, on the Mac). */
export class JsDiagnosticParser {
  private esbuild: { severity: 'error' | 'warning'; message: string; lines: number } | null = null;

  constructor(private readonly cwd: string, private readonly projectRoot: string = cwd) {}

  private located(file: string, line: string, column: string, severity: 'error' | 'warning', message: string): Diagnostic {
    const abs = path.posix.isAbsolute(file) ? path.posix.normalize(file) : path.posix.join(this.cwd, file);
    const own = (abs === this.projectRoot || abs.startsWith(`${this.projectRoot}/`)) && !abs.split('/').includes('node_modules');
    return { severity, message: message.trim(), file: abs, line: Number(line), column: Number(column), own };
  }

  /** The diagnostic this line completes, if any. */
  push(raw: string): Diagnostic | null {
    const line = raw.replace(ANSI, '').replace(/\r$/, '');
    if (this.esbuild) {
      const location = line.match(ESBUILD_LOCATION);
      if (location) {
        const pending = this.esbuild;
        this.esbuild = null;
        return this.located(location[1]!, location[2]!, location[3]!, pending.severity, pending.message);
      }
      // The location comes within a few lines, or the error has none.
      if (++this.esbuild.lines > 4) {
        const pending = this.esbuild;
        this.esbuild = null;
        return { severity: pending.severity, message: pending.message, own: true };
      }
      return null;
    }
    const tsc = line.match(TSC_PLAIN) ?? line.match(TSC_PRETTY);
    if (tsc) return this.located(tsc[1]!, tsc[2]!, tsc[3]!, tsc[4] as 'error' | 'warning', `${tsc[6]} (${tsc[5]})`);
    const head = line.match(ESBUILD_HEAD);
    if (head) {
      this.esbuild = { severity: head[1] === 'ERROR' ? 'error' : 'warning', message: head[2]!, lines: 0 };
      return null;
    }
    const generic = line.match(GENERIC);
    if (generic && !/^https?$/.test(generic[1]!)) return this.located(generic[1]!, generic[2]!, generic[3]!, generic[4] as 'error' | 'warning', generic[5]!);
    return null;
  }
}
