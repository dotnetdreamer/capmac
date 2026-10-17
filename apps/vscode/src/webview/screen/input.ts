/**
 * Mouse, wheel and keyboard on the screen, turned into the engine's input
 * events, exactly as CapMac Studio's panes do (Simulator.tsx, AppWindow.tsx):
 *  - 'touch' (CapMac's helper): fingers stream as they move; Alt+drag pinches;
 *  - 'gestures' (AXe): whole taps and swipes;
 *  - 'mouse' (an app's window on the Mac): pointer, wheel and keys as on a Mac.
 */
import { keystrokeForChar, keystrokeForKey } from '@capmac/core/shared/hid';
import { macModifiers } from '@capmac/core/shared/electron';
import type { InputEvent } from '../../../../desktop/src/shared/contract';

export type InputMode = 'touch' | 'gestures' | 'mouse';

export interface InputOptions {
  host: HTMLElement;
  send(event: InputEvent): void;
  /** The current mode, or null while input is off. */
  mode(): InputMode | null;
  /** The screen's size in points (scrolling is in points). */
  points(): { width: number; height: number } | null;
  /** Touches show a ripple where they land. */
  ripple(x: number, y: number): void;
  /** A click: the page may start playing the app's sound. */
  onPointerDown?(): void;
}

const BUTTONS = ['left', 'middle', 'right'] as const;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function attachInput(o: InputOptions): () => void {
  const { host, send } = o;
  const point = (e: { clientX: number; clientY: number }) => {
    const r = host.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), px: e.clientX - r.left, py: e.clientY - r.top };
  };

  // ─── Touch mode ──────────────────────────────────────────────────────────
  let finger: { id: number; two: boolean; x: number; y: number } | null = null;
  let moveFrame = 0;
  const endTouch = (how: 'up' | 'cancel', at?: { x: number; y: number }) => {
    const f = finger;
    if (!f) return;
    finger = null;
    cancelAnimationFrame(moveFrame);
    const x = at?.x ?? f.x;
    const y = at?.y ?? f.y;
    if (f.two) send({ kind: 'touch2', phase: 'up', x1: x, y1: y, x2: 1 - x, y2: 1 - y });
    else send({ kind: 'touch', phase: how, x, y });
  };

  // ─── Gestures mode ───────────────────────────────────────────────────────
  let down: { x: number; y: number; t: number } | null = null;

  // ─── Mouse mode ──────────────────────────────────────────────────────────
  let pressed = 0;
  let lastMove: { x: number; y: number; buttons: number; modifiers: number } | null = null;
  let mouseFrame = 0;
  const releaseAll = () => {
    const m = lastMove;
    for (const [bit, button] of [[1, 'left'], [2, 'middle'], [4, 'right']] as const) {
      if (pressed & bit) send({ kind: 'mouse', phase: 'up', x: m?.x ?? 0.5, y: m?.y ?? 0.5, button, clicks: 1 });
    }
    pressed = 0;
  };

  const onPointerDown = (e: PointerEvent) => {
    o.onPointerDown?.();
    const mode = o.mode();
    if (!mode) return;
    if (mode === 'mouse') {
      e.preventDefault();
      host.setPointerCapture(e.pointerId);
      host.focus();
      pressed |= 1 << e.button;
      const p = point(e);
      send({ kind: 'mouse', phase: 'down', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left', clicks: clamp(e.detail || 1, 1, 3), modifiers: macModifiers(e) || undefined });
      return;
    }
    if (e.button !== 0) return;
    host.setPointerCapture(e.pointerId);
    host.focus();
    const p = point(e);
    if (mode === 'touch') {
      endTouch('cancel');
      const two = e.altKey;
      finger = { id: e.pointerId, two, x: p.x, y: p.y };
      o.ripple(p.px, p.py);
      if (two) send({ kind: 'touch2', phase: 'down', x1: p.x, y1: p.y, x2: 1 - p.x, y2: 1 - p.y });
      else send({ kind: 'touch', phase: 'down', x: p.x, y: p.y });
    } else {
      down = { x: p.x, y: p.y, t: performance.now() };
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const mode = o.mode();
    if (mode === 'mouse') {
      const p = point(e);
      lastMove = { x: p.x, y: p.y, buttons: e.buttons, modifiers: macModifiers(e) };
      if (mouseFrame) return;
      mouseFrame = requestAnimationFrame(() => {
        mouseFrame = 0;
        const m = lastMove;
        if (m) send({ kind: 'mouse', phase: 'move', x: m.x, y: m.y, buttons: m.buttons || undefined, modifiers: m.modifiers || undefined });
      });
      return;
    }
    const f = finger;
    if (!f || f.id !== e.pointerId) return;
    const p = point(e);
    f.x = p.x;
    f.y = p.y;
    cancelAnimationFrame(moveFrame);
    moveFrame = requestAnimationFrame(() => {
      const now = finger;
      if (!now) return;
      if (now.two) send({ kind: 'touch2', phase: 'move', x1: now.x, y1: now.y, x2: 1 - now.x, y2: 1 - now.y });
      else send({ kind: 'touch', phase: 'move', x: now.x, y: now.y });
    });
  };

  const onPointerUp = (e: PointerEvent) => {
    const mode = o.mode();
    if (mode === 'mouse') {
      if (!(pressed & (1 << e.button))) return;
      pressed &= ~(1 << e.button);
      const p = point(e);
      send({ kind: 'mouse', phase: 'up', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left', clicks: clamp(e.detail || 1, 1, 3), modifiers: macModifiers(e) || undefined });
      return;
    }
    if (mode === 'touch') {
      if (finger?.id === e.pointerId) endTouch('up', point(e));
      return;
    }
    const start = down;
    down = null;
    if (!start || !mode) return;
    const p = point(e);
    const dt = performance.now() - start.t;
    if (Math.hypot(p.x - start.x, p.y - start.y) < 0.015) {
      o.ripple(p.px, p.py);
      send(dt > 500 ? { kind: 'swipe', x1: start.x, y1: start.y, x2: p.x, y2: p.y, durationMs: Math.round(Math.min(dt, 2000)) } : { kind: 'tap', x: p.x, y: p.y });
    } else {
      send({ kind: 'swipe', x1: start.x, y1: start.y, x2: p.x, y2: p.y, durationMs: Math.round(clamp(dt, 80, 1500)) });
    }
  };

  const onPointerCancel = () => {
    down = null;
    endTouch('cancel');
    releaseAll();
  };

  const onPointerLeave = (e: PointerEvent) => {
    if (o.mode() !== 'mouse' || e.buttons) return;
    const p = point(e);
    send({ kind: 'mouse', phase: 'leave', x: p.x, y: p.y });
  };

  // ─── Wheel ───────────────────────────────────────────────────────────────
  const wheel = { dx: 0, dy: 0, x: 0.5, y: 0.5, modifiers: 0, frame: 0, timer: 0 };
  const onWheel = (e: WheelEvent) => {
    const mode = o.mode();
    if (!mode) return;
    e.preventDefault();
    const p = point(e);
    const r = host.getBoundingClientRect();
    if (mode === 'touch' || mode === 'mouse') {
      // In the screen's points: one display frame's worth at a time.
      const pts = o.points();
      const perPixel = pts ? (mode === 'mouse' ? pts.width / r.width : pts.height / r.height) : 1;
      const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? r.height : 1;
      wheel.dx += e.deltaX * lines * perPixel;
      wheel.dy += e.deltaY * lines * perPixel;
      wheel.x = p.x;
      wheel.y = p.y;
      wheel.modifiers = macModifiers(e);
      if (wheel.frame) return;
      wheel.frame = requestAnimationFrame(() => {
        wheel.frame = 0;
        if (Math.abs(wheel.dx) + Math.abs(wheel.dy) < 0.5) return;
        const dx = clamp(wheel.dx, -2000, 2000);
        const dy = clamp(wheel.dy, -2000, 2000);
        if (mode === 'mouse') send({ kind: 'wheel', x: wheel.x, y: wheel.y, dx, dy, modifiers: wheel.modifiers || undefined });
        else send({ kind: 'scroll', x: wheel.x, y: wheel.y, dx, dy });
        wheel.dx = 0;
        wheel.dy = 0;
      });
      return;
    }
    wheel.dy += e.deltaY;
    wheel.x = p.x;
    wheel.y = p.y;
    window.clearTimeout(wheel.timer);
    wheel.timer = window.setTimeout(() => {
      const dy = clamp(-wheel.dy / 1200, -0.5, 0.5);
      wheel.dy = 0;
      send({ kind: 'swipe', x1: wheel.x, y1: wheel.y, x2: wheel.x, y2: clamp(wheel.y + dy, 0.02, 0.98), durationMs: 180 });
    }, 90);
  };

  // ─── Keys ────────────────────────────────────────────────────────────────
  const buffer = { text: '', timer: 0 };
  const flush = () => {
    window.clearTimeout(buffer.timer);
    if (buffer.text) send({ kind: 'text', text: buffer.text });
    buffer.text = '';
  };
  const onKey = (e: KeyboardEvent, phase: 'down' | 'up') => {
    const mode = o.mode();
    if (!mode) return;
    if (mode === 'mouse') {
      if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return;
      // Ctrl+V arrives as a paste event, with this PC's clipboard; Ctrl+Tab and F5 stay with VS Code.
      if (e.ctrlKey && !e.altKey && e.code === 'KeyV') return;
      if (e.key === 'F5' || (e.ctrlKey && e.key === 'Tab')) return;
      e.preventDefault();
      send({ kind: 'keyboard', phase, key: e.key.slice(0, 32), code: e.code.slice(0, 32), modifiers: macModifiers(e) || undefined, repeat: e.repeat || undefined });
      return;
    }
    if (phase === 'up') return;
    // Simulator.app's shortcuts for the hardware buttons.
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyH' || e.code === 'KeyL')) {
      e.preventDefault();
      send({ kind: 'button', button: e.code === 'KeyH' ? 'home' : 'lock' });
      return;
    }
    if (mode === 'touch') {
      if (e.ctrlKey && !e.altKey && e.code === 'KeyV') return;
      const stroke = keystrokeForKey(e);
      if (stroke) {
        e.preventDefault();
        send({ kind: 'keypress', usage: stroke.usage, modifiers: stroke.modifiers || undefined });
      } else if (!e.ctrlKey && [...e.key].length === 1 && !keystrokeForChar(e.key)) {
        // A character no US key types (é, ß, …): typed through the simulator's pasteboard.
        e.preventDefault();
        send({ kind: 'text', text: e.key });
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const special = ({ Enter: 'return', Backspace: 'delete', Tab: 'tab', Escape: 'escape' } as const)[e.key as 'Enter'];
    if (special) {
      e.preventDefault();
      flush();
      send({ kind: 'key', key: special });
    } else if (e.key.length === 1) {
      e.preventDefault();
      buffer.text += e.key;
      window.clearTimeout(buffer.timer);
      buffer.timer = window.setTimeout(flush, 200);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => onKey(e, 'down');
  const onKeyUp = (e: KeyboardEvent) => onKey(e, 'up');

  const onPaste = (e: ClipboardEvent) => {
    const mode = o.mode();
    if (!mode) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    send({ kind: 'text', text: text.slice(0, 20_000), via: mode === 'gestures' ? 'type' : 'paste' });
  };
  const onCompositionEnd = (e: CompositionEvent) => {
    if (o.mode() === 'mouse' && e.data) send({ kind: 'text', text: e.data });
  };
  const onLostCapture = (e: PointerEvent) => {
    if (finger?.id === e.pointerId) endTouch('cancel');
  };
  const onBlur = () => {
    endTouch('cancel');
    releaseAll();
  };
  const onContextMenu = (e: Event) => {
    if (o.mode() === 'mouse') e.preventDefault();
  };

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerCancel);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('lostpointercapture', onLostCapture);
  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  host.addEventListener('paste', onPaste);
  host.addEventListener('compositionend', onCompositionEnd);
  host.addEventListener('blur', onBlur);
  host.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('blur', onBlur);
  return () => {
    onBlur();
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerCancel);
    host.removeEventListener('pointerleave', onPointerLeave);
    host.removeEventListener('lostpointercapture', onLostCapture);
    host.removeEventListener('wheel', onWheel);
    host.removeEventListener('keydown', onKeyDown);
    host.removeEventListener('keyup', onKeyUp);
    host.removeEventListener('paste', onPaste);
    host.removeEventListener('compositionend', onCompositionEnd);
    host.removeEventListener('blur', onBlur);
    host.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('blur', onBlur);
  };
}
