/** Small decisions with no VS Code in them (unit-tested on their own). */
import path from 'node:path';
import { JsDiagnosticParser } from '@capmac/core/shared/js-diagnostics';
import type { AppLogEntry, Diagnostic, Target, TargetsResult, WslStatus } from '../../../desktop/src/shared/contract.js';

/** Whether this build's engine opens React Native DevTools (`sessions.devtools`, scripts/build.mjs reads contract.ts). */
declare const __CAPMAC_HAS_DEVTOOLS__: boolean | undefined;
export const HAS_DEVTOOLS = typeof __CAPMAC_HAS_DEVTOOLS__ === 'boolean' && __CAPMAC_HAS_DEVTOOLS__;

/** A path as a map key: Windows paths compare without case and trailing slashes. */
export const keyOf = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** Whether `dir` is `folder` or in it (a folder "app" doesn't hold its neighbour "app-admin"). */
export function isWithin(dir: string, folder: string): boolean {
  const inner = keyOf(dir);
  const outer = keyOf(folder);
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);
}

/** The simulator CapMac picks when none is: a booted iPhone, else "iPhone N", else any iPhone (Studio's automaticTarget). */
export function automaticTarget(targets: TargetsResult | null | undefined): Target | null {
  if (!targets) return null;
  const sims = targets.simulators.filter((t) => t.available);
  return sims.find((t) => t.state === 'Booted' && /iPhone/.test(t.name)) ?? sims.find((t) => /^iPhone \d+$/.test(t.name)) ?? sims.find((t) => /iPhone/.test(t.name)) ?? sims[0] ?? null;
}

/** This PC can build the app: tools and SDK in place, and signing when inside an app (Studio's pcReady). */
export function pcReady(status: WslStatus | null | undefined): boolean {
  return Boolean(status && status.tools && status.sdk && (status.signing || !status.inApp));
}

/** "ik@my-mac.local:2222" → its parts. */
export function parseAddress(text: string): { host: string; port: number; user?: string } | null {
  const m = text.trim().match(/^(?:([^@\s]+)@)?([A-Za-z0-9.\-_[\]:]+?)(?::(\d{1,5}))?$/);
  if (!m || !m[2]) return null;
  const port = m[3] ? Number(m[3]) : 22;
  if (port < 1 || port > 65535) return null;
  return { host: m[2], port, user: m[1] };
}

/** Where a console call came from, when it is a file on this PC ("C:\app\src\main.ts:12"); URLs stay text. */
export function sourceOf(entry: Pick<AppLogEntry, 'source'>): { path: string; line: number } | null {
  const m = entry.source?.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (!m || /^[a-z][a-z0-9+.-]*:\/\//i.test(m[1]!)) return null;
  return { path: m[1]!, line: Number(m[2]) };
}

/** `C:\app\src\a.ts` → `/C:/app/src/a.ts`, so core's parser (POSIX joins) keeps a Windows path whole. */
const posixPaths = (text: string): string =>
  text.replace(/\\/g, '/').replace(/(^|[\s("'`])([A-Za-z]):\//g, (_, before: string, drive: string) => `${before}/${drive.toUpperCase()}:/`);

/**
 * The compiler errors (TypeScript, esbuild, Vite) in the output of the web
 * build this PC runs in `projectDir`, as diagnostics with Windows paths: core's
 * parser, one per run (an esbuild error takes a few lines).
 */
export class WebBuildDiagnostics {
  private readonly parser: JsDiagnosticParser;
  /** `c:\app\`: what the project's own files start with, without case. */
  private readonly own: string;

  constructor(projectDir: string) {
    const root = posixPaths(projectDir).replace(/\/+$/, '');
    this.parser = new JsDiagnosticParser(root, root);
    this.own = `${projectDir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()}\\`;
  }

  push(text: string): Diagnostic[] {
    const found: Diagnostic[] = [];
    for (const line of text.split(/\r?\n/)) {
      const diagnostic = this.parser.push(posixPaths(line));
      if (!diagnostic) continue;
      if (diagnostic.file && /^\/[A-Z]:\//.test(diagnostic.file)) {
        diagnostic.file = diagnostic.file.slice(1).replace(/\//g, '\\');
        const file = diagnostic.file.toLowerCase();
        diagnostic.own = file.startsWith(this.own) && !file.split('\\').includes('node_modules');
      }
      found.push(diagnostic);
    }
    return found;
  }
}
