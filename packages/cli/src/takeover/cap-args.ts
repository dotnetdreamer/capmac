// Reads a Capacitor CLI command line (`cap run ios --target X`) the way
// @capacitor/cli's own option definitions do. Dependency-free: it is bundled
// into the takeover preload, which runs inside every Node.js process.

/** Capacitor options that take a value, so the value is not mistaken for the platform. */
const VALUE_OPTIONS = new Set([
  // run
  'scheme', 'flavor', 'target', 'target-name', 'target-name-sdk-version', 'forwardPorts', 'host', 'port', 'configuration',
  // build
  'keystorepath', 'keystorepass', 'keystorealias', 'keystorealiaspass', 'androidreleasetype', 'signing-type',
  'xcode-team-id', 'xcode-export-method', 'xcode-signing-style', 'xcode-signing-certificate', 'xcode-provisioning-profile',
  // init, add, migrate
  'web-dir', 'packagemanager',
]);

const SHORT: Record<string, string> = { l: 'live-reload', h: 'help', V: 'version' };

export type CapOptionValue = string | boolean;

export interface CapInvocation {
  command?: string;
  platform?: string;
  /** `--no-sync` is stored as `sync: false`, like commander does. */
  options: Record<string, CapOptionValue>;
}

export function parseCapArgs(args: readonly string[]): CapInvocation {
  const positional: string[] = [];
  const options: Record<string, CapOptionValue> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) options[name] = arg.slice(eq + 1);
      else if (VALUE_OPTIONS.has(name)) options[name] = args[++i] ?? '';
      else if (name.startsWith('no-')) options[name.slice(3)] = false;
      else options[name] = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) options[SHORT[ch] ?? ch] = true;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], platform: positional[1], options };
}

/** The Capacitor commands capmac runs on the Mac instead; everything else stays local. */
export const TAKEOVER_COMMANDS: readonly string[] = ['run', 'open', 'build'];

export function isTakeoverCommand(inv: CapInvocation): boolean {
  return inv.platform === 'ios'
    && inv.command !== undefined
    && TAKEOVER_COMMANDS.includes(inv.command)
    && !inv.options.help
    && !inv.options.version;
}

/** A string option's value, or undefined when it was not given (or given without a value). */
export function stringOption(inv: CapInvocation, name: string): string | undefined {
  const value = inv.options[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
