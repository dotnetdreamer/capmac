// The takeover preload's decision, kept free of side effects so it can be tested.
import { isTakeoverCommand, parseCapArgs } from './cap-args.js';

export { PRELOAD_FILE, STATE_FILE, type TakeoverState } from '@capmac/core/shared/takeover';

/** True when `script` (process.argv[1]) is @capacitor/cli's executable, installed by npm, pnpm or yarn. */
export function isCapacitorCli(script: string | undefined): boolean {
  return Boolean(script && /[\\/]@capacitor[\\/]cli[\\/]bin[\\/]capacitor(\.js)?$/i.test(script));
}

/** The capmac arguments to run instead of this process, or null to let it run as usual. */
export function takeoverArgs(argv: readonly string[], platform: string, env: Record<string, string | undefined>): string[] | null {
  if (platform === 'darwin') return null;
  if (env.CAPMAC_TAKEOVER === '0' || env.CAPMAC_TAKEOVER === 'off') return null;
  if (!isCapacitorCli(argv[1])) return null;
  const args = argv.slice(2);
  return isTakeoverCommand(parseCapArgs(args)) ? ['cap', ...args] : null;
}
