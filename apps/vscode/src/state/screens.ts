/** Which screen the screen tab streams (no VS Code in here: unit-tested on its own). */
import type { Target } from '../../../desktop/src/shared/contract.js';

/**
 * What the screen tab streams: on a Mac, a simulator, a plugged-in iPhone or the project's app
 * window; at this PC (no Mac), the iPhone mirroring to it, or its picture over the cable.
 */
export type ScreenSource =
  | { backend: 'mac'; mac: string; udid: string; projectPath?: string; device?: { name: string }; name: string }
  | { backend: 'wsl'; udid: string; projectPath: string; name: string };

/** An iPhone mirroring to this PC over Wi-Fi while none is plugged in or paired: its picture, no touch (Studio's MIRROR_TARGET). */
export const MIRROR_UDID = 'wifi-mirror';

/**
 * The screen of an iPhone at this PC: the one the app runs on, else the one picked (or the only
 * one), else whichever mirrors over Wi-Fi (that needs no cable and no pairing). An iPhone that
 * doesn't trust this PC yet has none: it asks to be trusted first.
 */
export function pcScreen(projectPath: string, phone: Target | null): Extract<ScreenSource, { backend: 'wsl' }> | null {
  if (phone?.paired === false) return null;
  return { backend: 'wsl', udid: phone?.udid ?? MIRROR_UDID, projectPath, name: phone?.name ?? 'iPhone' };
}

/**
 * Whether two screens are one stream. Every screen at this PC is: the iPhone that mirrors sends one
 * keyframe per session and none on request, so the tab keeps its stream and only moves touch to
 * the other iPhone or app.
 */
export function sameStream(a: ScreenSource, b: ScreenSource): boolean {
  if (a.backend === 'wsl' || b.backend === 'wsl') return a.backend === b.backend;
  return a.mac === b.mac && a.udid === b.udid && (a.projectPath ?? '') === (b.projectPath ?? '');
}
