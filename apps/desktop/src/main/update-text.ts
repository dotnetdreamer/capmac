// The updater's words and small parsing, kept apart from Electron so they can be tested.

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
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_/i.test(message)) return 'The update server could not be reached. CapMac Studio tries again later.';
  if (/404|Cannot find .*latest\.yml|latest\.yml/i.test(message)) return 'The update server has no CapMac Studio release yet.';
  if (/sha512 checksum mismatch|checksum/i.test(message)) return 'The downloaded update was damaged. CapMac Studio downloads it again later.';
  if (/not signed|publisherName|signature/i.test(message)) return 'The update is not signed by the CapMac Studio publisher, so it was not installed.';
  return `The update check failed: ${message.split('\n')[0]}`;
}
