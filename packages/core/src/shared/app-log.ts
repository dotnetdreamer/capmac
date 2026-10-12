/**
 * Classifies lines printed by a running Capacitor app (stdout/stderr of the
 * app process). Capacitor prefixes its own lines with "⚡️" and forwards JS
 * console calls as "⚡️  [log] - message".
 */

export type AppLogKind = 'console' | 'bridge' | 'capacitor' | 'native';
export type AppLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface AppLogLine {
  kind: AppLogKind;
  level: AppLogLevel;
  text: string;
}

const BOLT = /^\s*⚡️?\s*/u;
const CONSOLE = /^\[(log|info|warn|warning|error|debug|trace)\]\s*-?\s?([\s\S]*)$/i;
const BRIDGE = /^(To Native|TO JS|To JS)\b/;

export function classifyAppLine(raw: string): AppLogLine {
  const line = raw.replace(/\r$/, '');
  const bolt = line.match(BOLT);
  if (!bolt) {
    const lower = line.toLowerCase();
    const level: AppLogLevel = /\b(fatal error|error|exception|crash)\b/.test(lower) ? 'error' : /\bwarn(ing)?\b/.test(lower) ? 'warn' : 'log';
    return { kind: 'native', level, text: line };
  }
  const rest = line.slice(bolt[0].length);
  const consoleMatch = rest.match(CONSOLE);
  if (consoleMatch) {
    const raw = consoleMatch[1]!.toLowerCase();
    const level: AppLogLevel = raw === 'warning' ? 'warn' : raw === 'trace' ? 'debug' : (raw as AppLogLevel);
    return { kind: 'console', level, text: consoleMatch[2]! };
  }
  if (BRIDGE.test(rest)) return { kind: 'bridge', level: 'debug', text: rest };
  const level: AppLogLevel = /error|failed|unable/i.test(rest) ? 'error' : /warning/i.test(rest) ? 'warn' : 'info';
  return { kind: 'capacitor', level, text: rest };
}
