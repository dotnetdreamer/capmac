/**
 * Compiler errors in JavaScript build output (TypeScript, esbuild, Vite and
 * Rolldown, and anything that prints `file:line:col: error: message`), as diagnostics
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
// [UNRESOLVED_IMPORT] Could not resolve './missing.js' in src/main.ts     (Rolldown, Vite 8; the location is on the next line)
const ROLLDOWN_HEAD = /^\[([A-Z][A-Z0-9_]*)\]\s+(.*)$/;
//    ╭─[ src/main.ts:1:8 ]
const ROLLDOWN_LOCATION = /^\s*╭─\[\s*(.+?):(\d+):(\d+)\s*\]\s*$/;
// Vite's "error during build:", Rolldown's "Build failed with 1 error:": Rolldown's errors look like its warnings, but follow this.
const BUILD_FAILED = /^(?:error during build:|Build failed with \d+ errors?:)/;
// file:line:col: error: message     (Vite 7 prints esbuild's as "file:line:col: ERROR: message")
const GENERIC = /^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/i;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Turns build output into diagnostics, line by line. Paths are resolved against `cwd` (the folder the tool ran in, on the Mac). */
export class JsDiagnosticParser {
  private esbuild: { severity: 'error' | 'warning'; message: string; lines: number } | null = null;
  private rolldown: { message: string } | null = null;
  private failed = false;

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
    if (this.rolldown) {
      const location = line.match(ROLLDOWN_LOCATION);
      if (location) {
        const pending = this.rolldown;
        this.rolldown = null;
        return this.located(location[1]!, location[2]!, location[3]!, this.failed ? 'error' : 'warning', pending.message);
      }
      // One without a location right after (a note about the build itself) is not about the code.
      this.rolldown = null;
    }
    if (BUILD_FAILED.test(line)) {
      this.failed = true;
      return null;
    }
    const tsc = line.match(TSC_PLAIN) ?? line.match(TSC_PRETTY);
    if (tsc) return this.located(tsc[1]!, tsc[2]!, tsc[3]!, tsc[4] as 'error' | 'warning', `${tsc[6]} (${tsc[5]})`);
    const head = line.match(ESBUILD_HEAD);
    if (head) {
      this.esbuild = { severity: head[1] === 'ERROR' ? 'error' : 'warning', message: head[2]!, lines: 0 };
      return null;
    }
    const rolldown = line.match(ROLLDOWN_HEAD);
    if (rolldown) {
      this.rolldown = { message: rolldown[2]! };
      return null;
    }
    const generic = line.match(GENERIC);
    if (generic && !/^https?$/i.test(generic[1]!)) return this.located(generic[1]!, generic[2]!, generic[3]!, generic[4]!.toLowerCase() as 'error' | 'warning', generic[5]!);
    return null;
  }
}
