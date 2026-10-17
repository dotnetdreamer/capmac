/** Import only the Apple resources needed for Linux cross-compilation. */
import { CancelledError, UserError } from '../errors.js';
import type { WslExecutor, WslRunOptions } from './toolchain.js';
import { IMPORT_XCODE_SDK } from './sdk-runtime.js';

export interface ImportedXcodeSdk {
  sdkPath: string;
  swiftResourcePath: string;
  xcodeVersion: string;
  swiftVersion?: string;
}

export interface SdkImportHooks extends Pick<WslRunOptions, 'signal' | 'onOutput'> {
  /** How much of the archive is read, 0 to 1. The importer's progress lines then don't go to `onOutput`. */
  onProgress?: (fraction: number) => void;
}

const READING = /^Reading Xcode archive: (\d{1,3})%$/;

/** The archive stays on the user's computer; no Apple resources are redistributed. */
export async function setupSDKFromXcode(executor: WslExecutor, hostXipPath: string, hooks: SdkImportHooks = {}): Promise<ImportedXcodeSdk> {
  if (hooks.signal?.aborted) throw new CancelledError();
  if (!hostXipPath || /[\0\r\n]/.test(hostXipPath)) throw new UserError('Provide the absolute path to the Xcode .xip downloaded from Apple.');
  const { onProgress, ...run } = hooks;
  const onOutput: WslRunOptions['onOutput'] = onProgress ? (text, stream) => {
    const rest = text.split(/(?<=\n)/).filter((line) => {
      const reading = READING.exec(line.trim());
      if (reading) onProgress(Math.min(Number(reading[1]), 100) / 100);
      return !reading;
    }).join('');
    if (rest) run.onOutput?.(rest, stream);
  } : run.onOutput;
  const archive = await executor.path(hostXipPath, hooks.signal);
  const result = await executor.run(['python3', '-c', IMPORT_XCODE_SDK, archive], { ...run, onOutput, timeoutMs: 3_600_000, allowFailure: true });
  if (result.code !== 0) throw new UserError('Could not import the iPhoneOS SDK from Xcode.', 'Use a completed official Xcode .xip download and check the available disk space in WSL.', (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-20));
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { throw new UserError('The Xcode SDK importer returned invalid output.'); }
  if (!parsed || typeof parsed !== 'object') throw new UserError('The Xcode SDK importer returned invalid output.');
  const value = parsed as Partial<ImportedXcodeSdk>;
  if ([value.sdkPath, value.swiftResourcePath].some((item) => typeof item !== 'string' || !item.startsWith('/') || /[\0\r\n]/.test(item)) || typeof value.xcodeVersion !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(value.xcodeVersion) || (value.swiftVersion !== undefined && (typeof value.swiftVersion !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(value.swiftVersion)))) throw new UserError('The Xcode SDK importer returned invalid resource paths or version metadata.');
  return value as ImportedXcodeSdk;
}

export { IMPORT_XCODE_SDK } from './sdk-runtime.js';
