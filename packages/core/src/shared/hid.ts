/**
 * Keyboard input for the simulator as USB HID usages (Keyboard/Keypad page,
 * 0x07), which is what capmac's helper sends as a hardware keyboard. The
 * simulator's keyboard layout is US, so printable characters map to the US
 * key that types them (plus Shift); anything else goes through the pasteboard.
 *
 * No Node.js APIs here: the renderer uses it to map key presses.
 */

export const USAGE = {
  enter: 0x28,
  escape: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  capsLock: 0x39,
  f1: 0x3a,
  printScreen: 0x46,
  insert: 0x49,
  home: 0x4a,
  pageUp: 0x4b,
  deleteForward: 0x4c,
  end: 0x4d,
  pageDown: 0x4e,
  right: 0x4f,
  left: 0x50,
  down: 0x51,
  up: 0x52,
  leftControl: 0xe0,
  leftShift: 0xe1,
  leftAlt: 0xe2,
  leftGui: 0xe3,
} as const;

/** Modifier bits for a key press. On iOS, Gui is ⌘ (Command). */
export const MOD_SHIFT = 1;
export const MOD_CONTROL = 2;
export const MOD_ALT = 4;
export const MOD_GUI = 8;

export const MODIFIER_USAGES: Array<[bit: number, usage: number]> = [
  [MOD_CONTROL, USAGE.leftControl],
  [MOD_ALT, USAGE.leftAlt],
  [MOD_GUI, USAGE.leftGui],
  [MOD_SHIFT, USAGE.leftShift],
];

export interface Keystroke {
  usage: number;
  /** Modifier bits (MOD_SHIFT, …). */
  modifiers: number;
}

const PRINTABLE = (() => {
  const table = new Map<string, Keystroke>();
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((ch, i) => {
    table.set(ch, { usage: 0x04 + i, modifiers: 0 });
    table.set(ch.toUpperCase(), { usage: 0x04 + i, modifiers: MOD_SHIFT });
  });
  const digits = [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27];
  '1234567890'.split('').forEach((ch, i) => table.set(ch, { usage: digits[i]!, modifiers: 0 }));
  '!@#$%^&*()'.split('').forEach((ch, i) => table.set(ch, { usage: digits[i]!, modifiers: MOD_SHIFT }));
  const punctuation: Array<[string, string, number]> = [
    ['-', '_', 0x2d], ['=', '+', 0x2e], ['[', '{', 0x2f], [']', '}', 0x30], ['\\', '|', 0x31],
    [';', ':', 0x33], ["'", '"', 0x34], ['`', '~', 0x35], [',', '<', 0x36], ['.', '>', 0x37], ['/', '?', 0x38],
  ];
  for (const [plain, shifted, usage] of punctuation) {
    table.set(plain, { usage, modifiers: 0 });
    table.set(shifted, { usage, modifiers: MOD_SHIFT });
  }
  table.set(' ', { usage: USAGE.space, modifiers: 0 });
  table.set('\n', { usage: USAGE.enter, modifiers: 0 });
  table.set('\t', { usage: USAGE.tab, modifiers: 0 });
  return table;
})();

/** The US-layout key (and Shift) that types `ch`, or null when no key does. */
export function keystrokeForChar(ch: string): Keystroke | null {
  return PRINTABLE.get(ch) ?? null;
}

/**
 * Keystrokes that type `text`, or null when a character has no key on a US
 * keyboard (é, ü, emoji, …): that text goes through the pasteboard instead.
 */
export function keystrokesFor(text: string): Keystroke[] | null {
  const out: Keystroke[] = [];
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const stroke = keystrokeForChar(ch);
    if (!stroke) return null;
    out.push(stroke);
  }
  return out;
}

/** Keys that type no character, by `KeyboardEvent.code` (the key's position, so any layout). */
const CODES: Record<string, number> = {
  Enter: USAGE.enter,
  NumpadEnter: USAGE.enter,
  Escape: USAGE.escape,
  Backspace: USAGE.backspace,
  Tab: USAGE.tab,
  Space: USAGE.space,
  Insert: USAGE.insert,
  Delete: USAGE.deleteForward,
  Home: USAGE.home,
  End: USAGE.end,
  PageUp: USAGE.pageUp,
  PageDown: USAGE.pageDown,
  ArrowRight: USAGE.right,
  ArrowLeft: USAGE.left,
  ArrowDown: USAGE.down,
  ArrowUp: USAGE.up,
};
for (let i = 1; i <= 12; i++) CODES[`F${i}`] = USAGE.f1 + i - 1;

/** The usage of a key that types no character (Enter, arrows, F1…), by `KeyboardEvent.code`. */
export function usageForCode(code: string): number | null {
  return CODES[code] ?? null;
}

/** Legacy named keys (`{ kind: 'key', key }`), as the AXe path and the CLI viewer send them. */
export const NAMED_KEYS: Record<string, number> = {
  return: USAGE.enter,
  enter: USAGE.enter,
  escape: USAGE.escape,
  delete: USAGE.backspace,
  backspace: USAGE.backspace,
  tab: USAGE.tab,
  space: USAGE.space,
};

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Maps a key press on this PC to a keystroke on the simulator, or null when
 * it has none (a lone modifier, a dead key, a character no US key types).
 * Windows shortcuts become their iOS equivalents: Ctrl+A/C/X/Z/Y → ⌘A/C/X/Z/⇧⌘Z.
 */
export function keystrokeForKey(e: KeyLike): Keystroke | null {
  if (e.ctrlKey && !e.altKey) {
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
    if (!letter) return null;
    if (letter === 'y') return { usage: keystrokeForChar('z')!.usage, modifiers: MOD_GUI | MOD_SHIFT };
    if ('acxz'.includes(letter)) return { usage: keystrokeForChar(letter)!.usage, modifiers: MOD_GUI | (e.shiftKey ? MOD_SHIFT : 0) };
    return null;
  }
  const code = usageForCode(e.code);
  if (code !== null) return { usage: code, modifiers: e.shiftKey ? MOD_SHIFT : 0 };
  // AltGr (Ctrl+Alt on Windows) types characters on many layouts: go by the character.
  if ([...e.key].length === 1) return keystrokeForChar(e.key);
  return null;
}
