import { toErrorInfo, type ErrorInfo } from '@capmac/core/engine';
import { clearStatus, isVerbose, log, pc } from './ui.js';

/** Set in the copy of the CLI that capmac Studio ships, where `capmac` may not be on PATH. */
declare const __CAPMAC_IN_STUDIO__: boolean | undefined;
const inStudio = typeof __CAPMAC_IN_STUDIO__ === 'boolean' && __CAPMAC_IN_STUDIO__;

/** Prints an error the way a developer wants to read it: what, why, how to fix. */
export function printErrorInfo(info: ErrorInfo): void {
  clearStatus();
  if (info.cancelled) {
    log.dim('Cancelled.');
    return;
  }
  log.error(info.message);
  if (info.details?.length) {
    log.line(pc.dim('  ┌ last output'));
    for (const line of info.details) log.line(`${pc.dim('  │')} ${line}`);
    log.line(pc.dim('  └'));
  }
  // A failed build points at its log; in the terminal, --verbose shows the whole output as it happens.
  const verboseTip = info.code === 'BUILD_FAILED' && !isVerbose() ? ' (or re-run with --verbose)' : '';
  if (info.hint) log.line(`  ${pc.cyan('→')} ${info.hint}${verboseTip}`);
  if (inStudio && info.hint?.includes('`capmac ')) log.line(`  ${pc.cyan('→')} Or open CapMac Studio: Macs pairs, checks and fixes your Mac, and unlocks its keychain.`);
  if (!info.expected) {
    if (isVerbose() && info.stack) log.dim(info.stack);
    else log.dim('  (run with --verbose for details)');
  }
}

export function reportError(err: unknown): void {
  printErrorInfo(toErrorInfo(err));
}
