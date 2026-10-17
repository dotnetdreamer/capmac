/**
 * A React Native app's own lines. React Native writes its logs (RCTLog) as
 * `2026-10-16 22:00:00.123 [info][tid:com.facebook.react.JavaScript] text`:
 * the JavaScript thread's are the app's console.log, the others native notes.
 * While Metro serves the app it hands over the console itself (with the
 * objects already formatted), so those copies are left out then.
 */
import type { AppLogLevel } from '../../shared/app-log.js';
import type { AppLogEntry } from '../events.js';
import { AppLogClassifier } from '../translate.js';

const RCT_LOG = /^(?:\d{4}-\d{2}-\d{2}[ T][\d:.]+\s+)?(?:\S+\[\d+:\d+\]\s+)?\[(trace|info|warn|error|fatal)\]\[tid:([^\]]+)\](?:\[[^\]]*\])?\s?([\s\S]*)$/;

/** One RCTLog line as a console entry; null when it is not one. */
export function rctLogEntry(raw: string, stream: 'stdout' | 'stderr', jsFromMetro: boolean): AppLogEntry | null | undefined {
  const match = RCT_LOG.exec(raw.replace(/\r$/, '').trim());
  if (!match) return undefined;
  const js = /JavaScript/i.test(match[2]!);
  if (js && jsFromMetro) return null;
  const text = match[3]!.trim();
  if (!text) return null;
  const level: AppLogLevel = match[1] === 'warn' ? 'warn' : match[1] === 'error' || match[1] === 'fatal' ? 'error' : match[1] === 'trace' ? 'debug' : js ? 'log' : 'info';
  return { kind: js ? 'console' : 'native', level, text, stream, ts: Date.now() };
}

/** glog's lines from React Native's C++ ("W1016 23:06:22.697645 1842884608 ReactInstance.cpp:256] text"). */
const GLOG = /^([IWEF])\d{4} [\d:.]+\s+\d+\s+[\w.+-]+:\d+\]\s?(.*)$/;
/** glog's own notice when an app never set it up: always there, never useful. */
const GLOG_NOTICE = /^WARNING: Logging before InitGoogleLogging\(\) is written to STDERR$/;
/**
 * Routine notes, kept dim: UIKit's, by the hundred as a React Native app starts (its screens appear at once),
 * and React Native's own as a reload takes its old instance apart ("UIManager::~UIManager() was called (address: 0x…)").
 */
const UIKIT_CHATTER = /Unbalanced calls to begin\/end appearance transitions|^\w+::~\w+\(\) was called \(address: 0x[0-9a-f]+\)\.?$/;

/** App lines as the console shows them: React Native's logs read, everything else as native output. */
export class ReactNativeLogClassifier extends AppLogClassifier {
  /** `jsFromMetro`: Metro hands over the console (a debug build); its copies in the app's output are left out. */
  constructor(private readonly jsFromMetro: boolean) {
    super();
  }

  override classify(raw: string, stream: 'stdout' | 'stderr' = 'stdout'): AppLogEntry | null {
    const entry = rctLogEntry(raw, stream, this.jsFromMetro);
    if (entry !== undefined) return entry;
    const line = raw.replace(/\r$/, '').trim();
    if (GLOG_NOTICE.test(line)) return null;
    const glog = GLOG.exec(line);
    // React Native's C++ notes its routine steps at warning level: only its errors are errors.
    if (glog) return { kind: 'native', level: glog[1] === 'E' || glog[1] === 'F' ? 'error' : 'debug', text: glog[2]!, stream, ts: Date.now() };
    const native = super.classify(raw, stream);
    return native && UIKIT_CHATTER.test(native.text) ? { ...native, level: 'debug' } : native;
  }
}
