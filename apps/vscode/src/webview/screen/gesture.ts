/**
 * Gestures mode (AXe on a simulator, WebDriverAgent on an iPhone at this PC): a finger's whole tap
 * or swipe once it lifts, as CapMac Studio's Screen pane makes it (Simulator.tsx). Where the finger
 * last rested and when it moved count too, so a long press before a drag, and a hold at its end
 * (swipe up and hold for the app switcher), come through. Positions are 0..1, times in ms.
 */
import type { InputEvent } from '../../../../desktop/src/shared/contract.js';

export interface GestureFinger {
  x: number;
  y: number;
  t: number;
  restX: number;
  restY: number;
  movedAt: number | null;
  lastMoveAt: number;
}

/** How far a finger goes before it counts as moving, and how far before its tap is a swipe. */
const MOVES = 0.008;
const TAP = 0.015;

export function fingerDown(x: number, y: number, t: number): GestureFinger {
  return { x, y, t, restX: x, restY: y, movedAt: null, lastMoveAt: t };
}

/** The finger moved to x, y: it rests from here unless it goes on. */
export function fingerMoved(finger: GestureFinger, x: number, y: number, now: number): void {
  if (Math.hypot(x - finger.restX, y - finger.restY) <= MOVES) return;
  finger.movedAt ??= now;
  finger.lastMoveAt = now;
  finger.restX = x;
  finger.restY = y;
}

/** What the finger did, now that it lifted at x, y: a tap, a long press (a swipe that stays), or a swipe. */
export function fingerUp(finger: GestureFinger, x: number, y: number, now: number): InputEvent {
  const dt = now - finger.t;
  if (Math.hypot(x - finger.x, y - finger.y) < TAP) {
    return dt > 500 ? { kind: 'swipe', x1: finger.x, y1: finger.y, x2: x, y2: y, durationMs: Math.round(Math.min(dt, 2000)) } : { kind: 'tap', x, y };
  }
  // Held still before moving (a long press, then a drag), or at the end (swipe up and hold).
  const movedAt = finger.movedAt ?? finger.t;
  const pressMs = movedAt - finger.t > 350 ? Math.round(Math.min(movedAt - finger.t, 3000)) : 0;
  const holdMs = now - finger.lastMoveAt > 300 ? Math.round(Math.min(now - finger.lastMoveAt, 3000)) : 0;
  const moving = (holdMs ? finger.lastMoveAt : now) - (pressMs ? movedAt : finger.t);
  return {
    kind: 'swipe', x1: finger.x, y1: finger.y, x2: x, y2: y, durationMs: Math.round(Math.max(80, Math.min(moving, 1500))),
    ...(pressMs ? { pressMs } : {}), ...(holdMs ? { holdMs } : {}),
  };
}
