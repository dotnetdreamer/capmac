/**
 * Reads pubspec.yaml: the subset of YAML that pubspecs use (block maps and
 * lists, plain and quoted scalars, comments, `{}`/`[]`, simple flow lists,
 * `|`/`>` blocks). Nothing here runs Flutter, so finding a project stays
 * quick and works on a PC without Flutter.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
type YamlMap = { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

/** The line without its comment (a `#` at the start or after a space, outside quotes). */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote && !(quote === '"' && line[i - 1] === '\\')) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === '{}') return {};
  if (text === '[]') return [];
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\(["\\/bfnrt])/g, (_, c: string) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] ?? c);
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean).map(scalar);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  // Version numbers ("1.0", "3.10") stay text: they are not numbers to pub either.
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/** Where a mapping key ends: the first `:` followed by a space or the end, outside quotes. */
function keyEnd(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) quote = c;
    else if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

class Parser {
  private index = 0;
  constructor(private readonly lines: Line[]) {}

  private peek(): Line | undefined {
    return this.lines[this.index];
  }

  /** A block (map or list) whose lines are indented by more than `parent`. */
  parseBlock(parent: number): YamlValue {
    const first = this.peek();
    if (!first || first.indent <= parent) return null;
    return first.text.startsWith('- ') || first.text === '-' ? this.parseList(first.indent) : this.parseMap(first.indent);
  }

  private parseMap(indent: number): YamlMap {
    const map: YamlMap = {};
    for (let line = this.peek(); line && line.indent === indent && !line.text.startsWith('- '); line = this.peek()) {
      const end = keyEnd(line.text);
      this.index += 1;
      if (end < 0) continue;
      const key = String(scalar(line.text.slice(0, end)) ?? '');
      map[key] = this.valueAfter(line.text.slice(end + 1).trim(), indent);
    }
    return map;
  }

  private parseList(indent: number): YamlValue[] {
    const list: YamlValue[] = [];
    for (let line = this.peek(); line && line.indent === indent && (line.text.startsWith('- ') || line.text === '-'); line = this.peek()) {
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      this.index += 1;
      if (!rest) {
        list.push(this.parseBlock(indent));
        continue;
      }
      const end = keyEnd(rest);
      if (end < 0) {
        list.push(scalar(rest));
        continue;
      }
      // "- key: value": a map whose first key sits on the dash's line, the others below it.
      const itemIndent = indent + 2;
      const item: YamlMap = { [String(scalar(rest.slice(0, end)) ?? '')]: this.valueAfter(rest.slice(end + 1).trim(), itemIndent) };
      const more = this.peek();
      if (more && more.indent === itemIndent && !more.text.startsWith('- ')) Object.assign(item, this.parseMap(itemIndent));
      list.push(item);
    }
    return list;
  }

  /** The value after `key:`: on the same line, a `|`/`>` block, or a nested block. */
  private valueAfter(rest: string, indent: number): YamlValue {
    if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const parts: string[] = [];
      for (let line = this.peek(); line && line.indent > indent; line = this.peek()) {
        parts.push(line.text);
        this.index += 1;
      }
      return parts.join(rest.startsWith('|') ? '\n' : ' ');
    }
    if (rest !== '') return scalar(rest);
    // A list may sit at its key's own indent ("assets:" then "- images/").
    const next = this.peek();
    if (next && next.indent === indent && (next.text.startsWith('- ') || next.text === '-')) return this.parseList(indent);
    return this.parseBlock(indent);
  }
}

/** Parses YAML text in the subset pubspecs use; unreadable lines are skipped, never thrown on. */
export function parseYaml(text: string): YamlValue {
  const lines: Line[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) continue;
    const stripped = stripComment(raw.replace(/\t/g, '  ')).trimEnd();
    if (!stripped.trim()) continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  return new Parser(lines).parseBlock(-1);
}

/** A dependency as pubspec.yaml writes it. */
export interface PubDependency {
  version?: string;
  sdk?: string;
  path?: string;
  git?: string;
  hosted?: string;
}

export interface Pubspec {
  name: string | null;
  description: string | null;
  /** "1.0.0+1": the build name, then the build number. */
  version: string | null;
  /** environment.sdk and environment.flutter constraints. */
  environment: { sdk?: string; flutter?: string };
  dependencies: Record<string, PubDependency>;
  devDependencies: Record<string, PubDependency>;
  /** dependency_overrides (also what pubspec_overrides.yaml holds). */
  dependencyOverrides: Record<string, PubDependency>;
  /** A pub workspace's root lists its packages (Dart 3.6+). */
  workspace: string[];
  /** A workspace member says so. */
  resolution: string | null;
  /** The `flutter:` section is there (an app or a plugin; a plain Dart package has none). */
  hasFlutterSection: boolean;
  /** `flutter: plugin:`: this package is a plugin, not an app. */
  isPlugin: boolean;
  /** `flutter: config: enable-swift-package-manager` / `disable-swift-package-manager`, when set. */
  swiftPackageManager: boolean | null;
}

const asMap = (value: YamlValue | undefined): YamlMap => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asString = (value: YamlValue | undefined): string | null => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null);

function dependencies(value: YamlValue | undefined): Record<string, PubDependency> {
  const out: Record<string, PubDependency> = {};
  for (const [name, spec] of Object.entries(asMap(value))) {
    if (typeof spec === 'string' || typeof spec === 'number') {
      out[name] = { version: String(spec) };
      continue;
    }
    const map = asMap(spec);
    const git = map.git;
    out[name] = {
      ...(asString(map.version) ? { version: asString(map.version)! } : {}),
      ...(asString(map.sdk) ? { sdk: asString(map.sdk)! } : {}),
      ...(asString(map.path) ? { path: asString(map.path)! } : {}),
      ...(typeof git === 'string' ? { git } : asString(asMap(git).url) ? { git: asString(asMap(git).url)! } : {}),
      ...(asString(map.hosted) ? { hosted: asString(map.hosted)! } : asString(asMap(map.hosted).url) ? { hosted: asString(asMap(map.hosted).url)! } : {}),
    };
  }
  return out;
}

export function readPubspec(text: string): Pubspec {
  const root = asMap(parseYaml(text));
  const flutter = root.flutter;
  const flutterMap = asMap(flutter);
  const config = asMap(flutterMap.config);
  const spm = config['enable-swift-package-manager'] ?? (config['disable-swift-package-manager'] === true ? false : undefined);
  const environment = asMap(root.environment);
  return {
    name: asString(root.name),
    description: asString(root.description),
    version: asString(root.version),
    environment: {
      ...(asString(environment.sdk) ? { sdk: asString(environment.sdk)! } : {}),
      ...(asString(environment.flutter) ? { flutter: asString(environment.flutter)! } : {}),
    },
    dependencies: dependencies(root.dependencies),
    devDependencies: dependencies(root.dev_dependencies),
    dependencyOverrides: dependencies(root.dependency_overrides),
    workspace: Array.isArray(root.workspace) ? root.workspace.map((item) => String(item)) : [],
    resolution: asString(root.resolution),
    hasFlutterSection: 'flutter' in root,
    isPlugin: 'plugin' in flutterMap,
    swiftPackageManager: typeof spm === 'boolean' ? spm : null,
  };
}

/** Whether a pubspec is a Flutter app's: it depends on the Flutter SDK and is not a plugin. */
export function isFlutterApp(pubspec: Pubspec): boolean {
  return pubspec.dependencies.flutter?.sdk === 'flutter' && !pubspec.isPlugin;
}
