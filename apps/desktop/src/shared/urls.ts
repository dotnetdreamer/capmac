/** URL checks shared by the main process and tests. */

/**
 * Whether two URLs are the same site (scheme, host and port). Compared field by
 * field: Node gives app:, file: and data: URLs the opaque origin "null", so
 * comparing URL.origin would match them all.
 */
export function sameOrigin(url: string, base: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(base);
    return a.protocol === b.protocol && a.host === b.host && a.host !== '';
  } catch {
    return false;
  }
}
