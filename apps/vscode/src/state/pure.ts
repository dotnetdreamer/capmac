/** Small decisions with no VS Code in them (unit-tested on their own). */
import path from 'node:path';
import { JsDiagnosticParser } from '@capmac/core/shared/js-diagnostics';
import type { SkillPlanEntry } from '@capmac/core/shared/skills';
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

/** Why CapMac takes an AI agent to be used: it is this editor, its extension is in it, the project has its files, this PC its settings. */
export type AgentReason = 'editor' | 'extension' | 'project' | 'pc';

/** Editors that are an agent themselves, by their name or URL scheme (core's agent ids). */
const AGENT_EDITORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/cursor/i, 'cursor'],
  [/windsurf|devin/i, 'windsurf'],
  [/antigravity/i, 'antigravity'],
];

/** The agents' own extensions (lowercase ids), as core's agent ids. */
const AGENT_EXTENSIONS: Readonly<Record<string, string>> = {
  'anthropic.claude-code': 'claude-code',
  'openai.chatgpt': 'codex',
  'github.copilot-chat': 'copilot',
  'google.geminicodeassist': 'gemini',
  'google.gemini-cli-vscode-ide-companion': 'gemini',
  'saoudrizwan.claude-dev': 'cline',
  'kilocode.kilo-code': 'kilo',
  'augment.vscode-augment': 'augment',
  'sourcegraph.amp': 'amp',
  'sst-dev.opencode': 'opencode',
};

/** The agents this editor shows: itself (Cursor, Windsurf, Antigravity) and the agents' extensions it has. */
export function editorAgents(appName: string, uriScheme: string, extensionIds: readonly string[]): Map<string, AgentReason[]> {
  const found = new Map<string, AgentReason[]>();
  const add = (id: string, reason: AgentReason) => {
    const reasons = found.get(id) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    found.set(id, reasons);
  };
  for (const [pattern, id] of AGENT_EDITORS) if (pattern.test(`${appName} ${uriScheme}`)) add(id, 'editor');
  for (const extension of extensionIds) {
    const id = AGENT_EXTENSIONS[extension.toLowerCase()];
    if (id) add(id, 'extension');
  }
  return found;
}

/**
 * What adding the CapMac skill by itself does in one place (a project, or the
 * user profile). `wanted`: the folders of the agents CapMac found that don't
 * see a CapMac skill yet; `every`: every agent's folder there. The first time,
 * it writes the missing copies and asks before it replaces someone else's
 * "capmac" skill; with each new CapMac version, it offers to update its older
 * copies. A copy the user removed, or changed, is left as it is.
 */
export function skillSteps(first: boolean, wanted: readonly SkillPlanEntry[], every: readonly SkillPlanEntry[]): { write: SkillPlanEntry[]; replace: SkillPlanEntry[]; update: SkillPlanEntry[] } {
  return {
    write: first ? wanted.filter((e) => e.state === 'missing') : [],
    replace: first ? wanted.filter((e) => e.state === 'foreign') : [],
    update: every.filter((e) => e.state === 'older'),
  };
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
