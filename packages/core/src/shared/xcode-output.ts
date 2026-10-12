/**
 * Turns raw `xcodebuild` output into progress updates and diagnostics.
 * Runs on the Mac so only the interesting parts travel back over SSH.
 */
import type { Diagnostic, Severity } from './protocol.js';

export type XcodeEvent =
  | { kind: 'progress'; text: string; done: number }
  | { kind: 'diag'; diag: Diagnostic };

const DIAG_WITH_LOCATION = /^(\/[^:]+?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning|note):\s+(.*)$/;
const DIAG_FILE_ONLY = /^(\/[^:]+?):\s+(error|warning):\s+(.*)$/;
const DIAG_PLAIN = /^(?:xcodebuild:\s+|ld:\s+|clang:\s+|swift-frontend:\s+)?(error|warning):\s+(.*)$/;
const LINKER_UNDEFINED = /^(Undefined symbols? for architecture .*)$/;
const LINKER_FAILURE = /^(ld: .*not found.*|ld: symbol\(s\) not found.*|ld: library .*|ld: framework .*)$/;
const IN_TARGET = /\(in target '([^']+)' from project '([^']+)'\)/;

const PROGRESS_RULES: Array<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
  { re: /^SwiftCompile \S+ \S+ Compiling\\? (.+?\.swift)/, label: (m) => `Compiling ${unescape(m[1]!)}` },
  { re: /^(?:SwiftCompile|CompileSwift) \S+ \S+ (\/\S+\.swift)/, label: (m) => `Compiling ${basename(m[1]!)}` },
  { re: /^CompileC \S+ (\/\S+\.(?:m|mm|c|cc|cpp))/, label: (m) => `Compiling ${basename(m[1]!)}` },
  { re: /^CompileStoryboard (\/\S+)/, label: (m) => `Compiling ${basename(m[1]!)}` },
  { re: /^CompileAssetCatalog(?:Variant)? \S*\s*(\/\S+)/, label: () => 'Compiling asset catalog' },
  { re: /^Ld (\/\S+)/, label: (m) => `Linking ${basename(m[1]!)}` },
  { re: /^CodeSign (\/\S+)/, label: (m) => `Signing ${basename(m[1]!)}` },
  { re: /^PhaseScriptExecution (.+?) \//, label: (m) => `Running script ${unescape(m[1]!)}` },
  { re: /^ProcessInfoPlistFile /, label: () => 'Processing Info.plist' },
  { re: /^CopySwiftLibs /, label: () => 'Copying Swift libraries' },
  { re: /^(?:Resolve Package Graph|Resolving Package Graph)/, label: () => 'Resolving Swift packages' },
  { re: /^Fetching from (\S+)/, label: (m) => `Fetching ${m[1]}` },
  { re: /^Computing version for (\S+)/, label: (m) => `Resolving ${m[1]}` },
  { re: /^Creating working copy of package/, label: () => 'Checking out Swift packages' },
  { re: /^ComputePackagePrebuildTargetDependencyGraph/, label: () => 'Preparing build graph' },
  { re: /^CreateBuildDescription/, label: () => 'Creating build description' },
];

function unescape(s: string): string {
  return s.replace(/\\ /g, ' ');
}

function basename(p: string): string {
  const clean = unescape(p);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function normalizeSeverity(s: string): Severity {
  if (s === 'warning') return 'warning';
  if (s === 'note') return 'note';
  return 'error';
}

export interface XcodeParserOptions {
  /** Absolute POSIX path of the user's project on the Mac; files under it are "own". */
  ownRoot?: string;
  /** Directories that never count as "own" even when under ownRoot. */
  foreignMarkers?: string[];
}

/**
 * Streaming parser. Feed it one line at a time; it returns zero or more events.
 * Context lines that follow a diagnostic (source excerpts, carets) are
 * attached to that diagnostic, and duplicates are dropped.
 */
export class XcodeOutputParser {
  private seen = new Set<string>();
  private pending: Diagnostic | null = null;
  private compiled = 0;
  private inFailedSummary = false;
  readonly failedCommands: string[] = [];
  errors = 0;
  warnings = 0;
  succeeded: boolean | null = null;

  constructor(private readonly options: XcodeParserOptions = {}) {}

  push(rawLine: string): XcodeEvent[] {
    const line = rawLine.replace(/\r$/, '');
    const events: XcodeEvent[] = [];

    if (this.pending) {
      if (this.isContextLine(line) && (this.pending.context?.length ?? 0) < 14) {
        (this.pending.context ??= []).push(line);
        return events;
      }
      this.flushPending(events);
    }

    if (line.startsWith('** BUILD SUCCEEDED **') || line.startsWith('** ARCHIVE SUCCEEDED **')) {
      this.succeeded = true;
      return events;
    }
    if (line.startsWith('** BUILD FAILED **') || line.startsWith('** ARCHIVE FAILED **')) {
      this.succeeded = false;
      return events;
    }
    if (line.startsWith('The following build commands failed:')) {
      this.inFailedSummary = true;
      return events;
    }
    if (this.inFailedSummary) {
      if (/^\(\d+ failures?\)$/.test(line.trim())) {
        this.inFailedSummary = false;
      } else if (line.trim()) {
        this.failedCommands.push(line.trim());
      }
      return events;
    }

    let m = line.match(DIAG_WITH_LOCATION);
    if (m) {
      this.startDiag({
        severity: normalizeSeverity(m[4]!),
        file: m[1]!,
        line: Number(m[2]),
        column: m[3] ? Number(m[3]) : undefined,
        message: m[5]!.trim(),
      }, events);
      return events;
    }
    m = line.match(DIAG_FILE_ONLY);
    if (m) {
      this.startDiag({ severity: normalizeSeverity(m[2]!), file: m[1]!, message: m[3]!.trim() }, events);
      return events;
    }
    m = line.match(DIAG_PLAIN);
    if (m) {
      this.startDiag({ severity: normalizeSeverity(m[1]!), message: m[2]!.trim() }, events);
      return events;
    }
    m = line.match(LINKER_UNDEFINED) ?? line.match(LINKER_FAILURE);
    if (m) {
      this.startDiag({ severity: 'error', message: m[1]!.trim() }, events);
      return events;
    }

    for (const rule of PROGRESS_RULES) {
      const pm = line.match(rule.re);
      if (pm) {
        if (/^(SwiftCompile|CompileSwift|CompileC) /.test(line)) this.compiled += 1;
        const target = line.match(IN_TARGET)?.[1];
        const label = rule.label(pm);
        events.push({ kind: 'progress', text: target ? `${target} › ${label}` : label, done: this.compiled });
        break;
      }
    }
    return events;
  }

  /** Call at end of output to flush a trailing diagnostic. */
  end(): XcodeEvent[] {
    const events: XcodeEvent[] = [];
    if (this.pending) this.flushPending(events);
    return events;
  }

  private isContextLine(line: string): boolean {
    if (!line.trim()) return false;
    // Swift 5.9+ style: " 12 |     foo()" and "    |     `- error: ..."
    if (/^\s*\d*\s*\|/.test(line)) return true;
    // Classic style: indented source line or caret line.
    if (/^\s+\S/.test(line) && !/^\s+(cd|export|builtin-|\/Applications\/)/.test(line)) return true;
    // Linker undefined-symbol details: '  "_foo", referenced from:'
    return false;
  }

  private isOwn(file: string | undefined): boolean {
    if (!file || !this.options.ownRoot) return false;
    if (!file.startsWith(this.options.ownRoot)) return false;
    const markers = this.options.foreignMarkers ?? ['/node_modules/', '/Pods/', '/SourcePackages/', '/DerivedData/', '/.build/'];
    return !markers.some((marker) => file.includes(marker));
  }

  private startDiag(diag: Diagnostic, events: XcodeEvent[]): void {
    diag.own = this.isOwn(diag.file);
    this.pending = diag;
    // Diagnostics without context still need to be emitted eventually; the
    // next non-context line (or end()) flushes them.
    void events;
  }

  private flushPending(events: XcodeEvent[]): void {
    const diag = this.pending!;
    this.pending = null;
    const key = `${diag.severity}|${diag.file ?? ''}|${diag.line ?? ''}|${diag.column ?? ''}|${diag.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (diag.severity === 'error') this.errors += 1;
    if (diag.severity === 'warning') this.warnings += 1;
    events.push({ kind: 'diag', diag });
  }
}

/** Hints for errors that have a well-known fix. */
export function hintForBuildOutput(text: string): { code?: string; hint: string } | null {
  if (/errSecInternalComponent/.test(text)) {
    return {
      code: 'KEYCHAIN_LOCKED',
      hint: 'Code signing could not use the login keychain over SSH. capmac will offer to unlock it; or run `capmac keychain unlock`.',
    };
  }
  if (/requires a development team|No Account for Team|No signing certificate|No profiles for/i.test(text)) {
    return {
      code: 'SIGNING',
      hint: 'Device builds need signing. Pass --team <TEAM_ID> (or set ios.team in capmac.json), and make sure an Apple ID is signed in under Xcode › Settings › Accounts on the Mac.',
    };
  }
  if (/Unable to find a destination matching/i.test(text)) {
    return { hint: 'The selected simulator or device is not usable with this Xcode. Run `capmac targets` to see what is available.' };
  }
  if (/agree to the Xcode license|license agreements/i.test(text)) {
    return { code: 'XCODE_NOT_READY', hint: 'Accept the Xcode license on the Mac: `sudo xcodebuild -license accept` (or run `capmac doctor --fix`).' };
  }
  if (/Could not resolve package dependencies|Failed to resolve dependencies/i.test(text)) {
    return { hint: 'Swift package resolution failed. Check the Mac has internet access to GitHub, then retry with --clean.' };
  }
  if (/Unable to open base configuration reference file .*Pods/i.test(text) || /The sandbox is not in sync with the Podfile.lock/i.test(text)) {
    return { hint: 'CocoaPods is out of date. Run `capmac run --full` to force `pod install`.' };
  }
  if (/is not available because it is not installed|iOS \d+(\.\d+)? is not installed/i.test(text)) {
    return { hint: 'The iOS platform/runtime is missing. On the Mac run `xcodebuild -downloadPlatform iOS` (or `capmac doctor --fix`).' };
  }
  return null;
}
