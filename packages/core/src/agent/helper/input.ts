/**
 * Turns capmac's input events into the helper's stdin commands (see
 * simstream.m): fingers, the scroll wheel, keys and hardware buttons. Whole
 * gestures (tap, swipe) from the AXe-era clients become finger sequences.
 * Events run one at a time, in order; a gesture's own timing is kept.
 */
import { keystrokesFor, MOD_GUI, MODIFIER_USAGES, NAMED_KEYS, type Keystroke } from '../../shared/hid.js';
import type { InputEvent } from '../../shared/protocol.js';

export interface HelperInputTarget {
  /** Writes one command line to the helper. */
  send(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Puts text on the simulator's pasteboard (`simctl pbcopy`). */
  setPasteboard(text: string): Promise<void>;
}

/** Text longer than this is pasted rather than typed key by key. */
export const TYPE_LIMIT = 200;

const BUTTONS: Record<string, string> = { home: 'home', lock: 'lock', side: 'side', siri: 'siri', 'apple-pay': 'applepay' };

function n(v: number): string {
  const c = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return String(Math.round(c * 100000) / 100000);
}

function pts(v: number): string {
  const c = Number.isFinite(v) ? Math.min(2000, Math.max(-2000, v)) : 0;
  return String(Math.round(c * 100) / 100);
}

/** The command lines for one keystroke: modifiers down, the key, modifiers up. */
export function keystrokeLines(stroke: Keystroke): string[] {
  const mods = MODIFIER_USAGES.filter(([bit]) => stroke.modifiers & bit).map(([, usage]) => usage);
  return [...mods.map((u) => `K ${u} d`), `K ${stroke.usage} d`, `K ${stroke.usage} u`, ...mods.reverse().map((u) => `K ${u} u`)];
}

/** Commands that need no timing, or null for events that do (gestures, text, button presses). */
export function immediateLines(event: InputEvent): string[] | null {
  switch (event.kind) {
    case 'touch':
      if (event.phase === 'cancel') return ['c'];
      return [`t ${event.phase[0]} ${n(event.x)} ${n(event.y)}`];
    case 'touch2':
      return [`T ${event.phase[0]} ${n(event.x1)} ${n(event.y1)} ${n(event.x2)} ${n(event.y2)}`];
    case 'scroll':
      return [`w ${n(event.x)} ${n(event.y)} ${pts(event.dx)} ${pts(event.dy)}`];
    case 'keypress':
      if (!Number.isInteger(event.usage) || event.usage <= 0 || event.usage > 0xffff) return [];
      return keystrokeLines({ usage: event.usage, modifiers: (event.modifiers ?? 0) & 15 });
    case 'key': {
      const usage = NAMED_KEYS[event.key];
      return usage ? keystrokeLines({ usage, modifiers: 0 }) : [];
    }
    case 'button': {
      const name = BUTTONS[event.button];
      if (!name) return [];
      return event.phase ? [`b ${name} ${event.phase[0]}`] : null;
    }
    default:
      return null;
  }
}

export class HelperInput {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly target: HelperInputTarget, private readonly onError: (message: string) => void = () => undefined) {}

  /** Queues an event; it runs after the ones before it. */
  push(event: InputEvent): Promise<void> {
    this.chain = this.chain.then(() => this.run(event)).catch((err) => this.onError(String(err?.message ?? err)));
    return this.chain;
  }

  private async run(event: InputEvent): Promise<void> {
    const t = this.target;
    const lines = immediateLines(event);
    if (lines) {
      for (const line of lines) t.send(line);
      return;
    }
    switch (event.kind) {
      case 'tap':
        t.send(`t d ${n(event.x)} ${n(event.y)}`);
        await t.sleep(60);
        t.send(`t u ${n(event.x)} ${n(event.y)}`);
        return;
      case 'swipe': {
        const duration = Math.min(5000, Math.max(50, event.durationMs));
        const steps = Math.max(2, Math.round(duration / 16));
        t.send(`t d ${n(event.x1)} ${n(event.y1)}`);
        for (let i = 1; i <= steps; i++) {
          await t.sleep(duration / steps);
          const f = i / steps;
          t.send(`t m ${n(event.x1 + (event.x2 - event.x1) * f)} ${n(event.y1 + (event.y2 - event.y1) * f)}`);
        }
        t.send(`t u ${n(event.x2)} ${n(event.y2)}`);
        return;
      }
      case 'button': {
        const name = BUTTONS[event.button]!;
        t.send(`b ${name} d`);
        await t.sleep(100);
        t.send(`b ${name} u`);
        return;
      }
      case 'text': {
        const text = event.text;
        if (!text) return;
        const strokes = event.via === 'paste' || text.length > TYPE_LIMIT ? null : keystrokesFor(text);
        if (strokes) {
          for (const stroke of strokes) {
            for (const line of keystrokeLines(stroke)) t.send(line);
            await t.sleep(4);
          }
          return;
        }
        // Characters no US key types (é, emoji, …), long text and pastes: the simulator's pasteboard, then ⌘V.
        await t.setPasteboard(text);
        await t.sleep(50);
        for (const line of keystrokeLines({ usage: 0x19, modifiers: MOD_GUI })) t.send(line);
        return;
      }
      default:
        return;
    }
  }
}
