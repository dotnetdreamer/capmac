// The updater's words and small parsing, kept apart from Electron so they can be tested.
import { t } from '../shared/i18n/index.js';

/** The feed URL in an app-update.yml (generic provider). */
export function feedUrl(yaml: string): string | null {
  return /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yaml)?.[1] ?? null;
}

/** The release notes link for a version, from the build's template ("…/v{version}"), or null. */
export function notesUrl(template: string, version: string): string | null {
  return template ? template.replaceAll('{version}', version) : null;
}

/** What the update error means for someone who just wants the latest version. */
export function describeUpdateError(err: unknown): string {
  const message = String((err as Error)?.message ?? err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_/i.test(message)) return t.updates.unreachable;
  if (/404|Cannot find .*latest\.yml|latest\.yml/i.test(message)) return t.updates.noRelease;
  if (/sha512 checksum mismatch|checksum/i.test(message)) return t.updates.damaged;
  if (/not signed|publisherName|signature/i.test(message)) return t.updates.unsigned;
  return t.updates.checkFailed(message.split('\n')[0]!.replace(/(?<!\.)\.$/, ''));
}
