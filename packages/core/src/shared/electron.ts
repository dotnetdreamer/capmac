/**
 * Electron apps on the Mac: what the engine, the agent and CapMac's module
 * inside the app (the hook, see src/electron-hook) share.
 *
 * The agent launches the app with the hook preloaded (NODE_OPTIONS=--require).
 * The hook reports on the app's own stdout, with marked lines, and serves the
 * app's windows (frames, input, screenshots) on a Unix socket.
 *
 * No Node.js APIs here: the renderer uses the key mapping and the types.
 */
import type { ProjectRef } from './protocol.js';

/** How the app is put together: decides how CapMac builds, launches and reloads it. */
export type ElectronFlavor = 'capacitor' | 'electron-vite' | 'forge' | 'plain';

/** Set by the agent: where the hook serves the app's windows. Its presence turns the hook on. */
export const ENV_SOCKET = 'CAPMAC_ELECTRON_SOCKET';
/** Capacitor live reload: the dev server URL (through the tunnel) the app loads instead of its bundled assets. */
export const ENV_LIVE_URL = 'CAPMAC_LIVE_URL';
/** Capacitor live reload: the custom URL scheme the bundled assets are served on ("capacitor-electron"). */
export const ENV_LIVE_SCHEME = 'CAPMAC_LIVE_SCHEME';
/** The project's folder on the Mac (offered as a place in file dialogs). */
export const ENV_PROJECT = 'CAPMAC_PROJECT_DIR';
/** Where the app's sound plays when it starts (see SoundMode). */
export const ENV_SOUND = 'CAPMAC_SOUND';

/**
 * Where an Electron app's sound plays: nowhere (the default: someone may be
 * working at the Mac), on the Mac's speakers, or on this PC, in the window
 * pane or the viewer that shows the app (CapMac mutes it on the Mac then).
 */
export type SoundMode = 'off' | 'mac' | 'pc';
export const SOUND_MODES: readonly SoundMode[] = ['off', 'mac', 'pc'];
export const isSoundMode = (value: unknown): value is SoundMode => typeof value === 'string' && (SOUND_MODES as readonly string[]).includes(value);

/** The app's sound on its way to this PC: Opus, 48 kHz stereo (WebCodecs' AudioDecoder plays it). */
export const APP_AUDIO = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 } as const;

/**
 * How a window's pictures travel: 'h264' is the smooth stream, video encoded
 * on the Mac (VideoToolbox) in the simulator stream's format (shared/stream.ts);
 * 'jpeg' is the compatible stream, one picture per repaint.
 */
export type AppCodec = 'h264' | 'jpeg';

/**
 * Next to the socket: "1" while the app is the Mac's active app (someone is
 * using it there), so a live-reload restart brings it back in front. A new
 * launch starts without it: the app opens behind whatever the Mac shows.
 */
export function frontFile(socket: string): string {
  return `${socket.replace(/\.sock$/, '')}.front`;
}

/** Starts a line the hook wrote about the app (JSON follows). Invisible characters: harmless in any terminal. */
export const HOOK_MARK = '⁣e⁣';
/** Starts a line the app's main process printed (console.log in main). */
export const MAIN_MARK = '⁣m⁣';

/** One of the app's windows, as the hook sees it. Sizes are in points. */
export interface AppWindowInfo {
  id: number;
  title: string;
  /** The content (the web page), in points. */
  width: number;
  height: number;
  /** Points to pixels on the window's display (2 on Retina). */
  scale: number;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  /** Height of the native title bar above the content, in points; 0 when the content runs under it (hidden title bar, frameless). */
  titleBar: number;
  /** Where the traffic lights sit over the content when the app moved them (null: the default place). */
  buttons: { x: number; y: number } | null;
  url: string;
  /** The Mac shows apps in dark mode (the title bar CapMac draws follows it). */
  dark?: boolean;
}

/** What the hook says about the app when it loads. */
export interface HookAppInfo {
  pid: number;
  name: string;
  electron: string;
  chrome: string;
  node: string;
  /** The socket the hook listens on, or null when it could not. */
  socket: string | null;
  /** The socket for the app's dialogs (see AppDialog), or null when CapMac cannot show them. */
  dialogs?: string | null;
  /** Where the app's sound plays now. */
  sound?: SoundMode;
  /** The app's sound can be sent to the PC (this Electron can capture it). */
  soundToPc?: boolean;
  /** The windows can come as H.264 video (this Electron can capture them; see AppCodec). */
  h264?: boolean;
}

/** Next to the app's socket: where its dialogs are served (by a thread of their own, so a dialog that blocks the app still answers). */
export function dialogSocket(socket: string): string {
  return `${socket.replace(/\.sock$/, '')}.dlg`;
}

// ─── Native dialogs ───────────────────────────────────────────────────────
//
// While the app is in the background on the Mac, a message box or file
// picker would come to the front there and take the keyboard of whoever is
// working on the Mac. CapMac's module keeps it off the Mac's screen and shows
// it in CapMac Studio, the CLI's viewer and the terminal instead, where it is
// answered. Someone who switches to the app on the Mac gets it there.

interface AppDialogBase {
  id: number;
  /** The window it belongs to (a sheet on the Mac), or null for the app's own. */
  window: number | null;
  /** The app does nothing else until it is answered (a `…Sync` dialog). */
  blocking: boolean;
  /** The app's name, for "Ludo Wala asks". */
  app: string;
  title: string;
  message: string;
}

export interface AppMessageDialog extends AppDialogBase {
  kind: 'message';
  type: 'none' | 'info' | 'error' | 'question' | 'warning';
  detail: string;
  buttons: string[];
  /** The button Return presses. */
  defaultId: number;
  /** The button Escape presses (the answer when the dialog is cancelled). */
  cancelId: number;
  checkboxLabel: string;
  checkboxChecked: boolean;
}

export interface AppFileDialog extends AppDialogBase {
  kind: 'open' | 'save';
  /** Where the dialog starts: a folder, or (saving) a file name in one. */
  defaultPath: string;
  buttonLabel: string;
  filters: Array<{ name: string; extensions: string[] }>;
  /** Electron's options: openFile, openDirectory, multiSelections, showHiddenFiles, createDirectory, … */
  properties: string[];
  /** Saving: the label of the name field. */
  nameFieldLabel: string;
  /** The Mac's home folder. */
  home: string;
  /** The project's folder on the Mac (synced from the PC), a handy place to pick from. */
  project: string | null;
}

export type AppDialog = AppMessageDialog | AppFileDialog;

/** How a dialog was answered. Files: no paths is a cancel. */
export type AppDialogAnswer =
  | { kind: 'message'; response: number; checkboxChecked?: boolean }
  | { kind: 'files'; paths: string[] };

/** Why a dialog went away: answered in CapMac, moved to the Mac (someone switched to the app there), or closed by the app. */
export type AppDialogClosed = 'answered' | 'mac' | 'app';

/** A folder on the Mac, for answering a file dialog. */
export interface MacFolder {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; dir: boolean; size: number; modified: number; hidden: boolean }>;
  /** Folders to jump to (Home, Desktop, Documents, Downloads, the project…). */
  places: Array<{ name: string; path: string }>;
  /** More entries than were sent. */
  truncated: boolean;
}

/** The answer a message box gives when it is cancelled (Escape, or the app closed it). */
export function cancelledMessage(dialog: AppMessageDialog): AppDialogAnswer {
  return { kind: 'message', response: dialog.cancelId, checkboxChecked: dialog.checkboxChecked };
}

/** Checks an answer against its dialog; null when it does not fit (a button that is not there, a relative path). */
export function checkAnswer(dialog: AppDialog, answer: unknown): AppDialogAnswer | null {
  const a = answer as Partial<{ kind: string; response: unknown; checkboxChecked: unknown; paths: unknown }>;
  if (!a || typeof a !== 'object') return null;
  if (dialog.kind === 'message') {
    if (a.kind !== 'message' || typeof a.response !== 'number' || !Number.isInteger(a.response)) return null;
    // A message box with no buttons has one OK button.
    const count = Math.max(1, dialog.buttons.length);
    if (a.response < 0 || a.response >= count) return null;
    return { kind: 'message', response: a.response, checkboxChecked: typeof a.checkboxChecked === 'boolean' ? a.checkboxChecked : dialog.checkboxChecked };
  }
  if (a.kind !== 'files' || !Array.isArray(a.paths)) return null;
  const paths = a.paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/') && !p.includes('\0'));
  if (paths.length !== a.paths.length) return null;
  if (dialog.kind === 'save' && paths.length > 1) return null;
  if (dialog.kind === 'open' && paths.length > 1 && !dialog.properties.includes('multiSelections')) return null;
  return { kind: 'files', paths };
}

/** Lines the hook writes on the app's stdout (after HOOK_MARK). */
export type HookEvent =
  | ({ e: 'hello' } & HookAppInfo)
  | { e: 'window'; window: AppWindowInfo }
  | { e: 'window-closed'; id: number }
  | { e: 'console'; level: 'debug' | 'info' | 'warning' | 'error'; text: string; source?: string; line?: number; window?: number }
  | { e: 'load-failed'; window: number; code: number; description: string; url: string }
  | { e: 'crashed'; window: number; reason: string }
  | { e: 'unresponsive'; window: number }
  | { e: 'error'; message: string }
  /** Something CapMac did for the app that is worth knowing (shown as information). */
  | { e: 'note'; message: string }
  /** The app's dialogs waiting for an answer in CapMac changed (relayed by the agent from the dialog socket). */
  | { e: 'dialogs'; dialogs: AppDialog[]; closed?: { id: number; how: AppDialogClosed } };

/** Requests to the hook, on its socket (JSON frames, see shared/frames.ts). */
export type HookRequest =
  | { t: 'hello'; role: 'screen' | 'control' }
  /**
   * Frames of a window (null: follow the focused one), at most `fps` a second, longest side `maxSize` pixels;
   * `audio`: the app's sound too, when it plays on the PC. `codec` 'h264' asks for video (JPEG when that cannot
   * work, see the `codec` message), starting at `bitrate` bits a second.
   */
  | { t: 'watch'; window: number | null; maxSize: number; fps: number; quality: number; audio?: boolean; codec?: AppCodec; bitrate?: number }
  /** Where the app's sound plays from now on. */
  | { t: 'sound'; id: number; mode: SoundMode }
  | { t: 'unwatch' }
  /** A frame was sent on: the hook keeps at most two in flight. */
  | { t: 'ack' }
  /** Video: the next frame is a keyframe (a decoder starts over, frames were dropped). */
  | { t: 'keyframe' }
  /** Video: encode at this many bits a second from now on (adaptive bitrate). */
  | { t: 'bitrate'; bitrate: number }
  /** Video gave up (the `codec` message said why): try it again. */
  | { t: 'retry-video' }
  | { t: 'input'; event: AppInputEvent }
  | { t: 'screenshot'; id: number; window?: number }
  | { t: 'reload'; id: number }
  /** The files loaded in the main process (to tell a reload from a restart). */
  | { t: 'modules'; id: number }
  | { t: 'window-action'; window: number; action: 'close' | 'minimize' | 'zoom' }
  | { t: 'ping'; id: number }
  // On the dialog socket (after `hello`):
  /** Answers dialog `dialog`. */
  | { t: 'dialog-answer'; id: number; dialog: number; answer: AppDialogAnswer }
  /** Lists a folder on the Mac ("~" is the home folder). */
  | { t: 'dialog-list'; id: number; path: string; hidden?: boolean }
  /** Makes a folder on the Mac (a file dialog's New Folder). */
  | { t: 'dialog-mkdir'; id: number; path: string };

/** Messages from the hook, on its socket. */
export type HookMessage =
  | { t: 'hello'; app: HookAppInfo; windows: AppWindowInfo[] }
  /** The windows changed; `watched` is the one whose frames are coming. */
  | { t: 'windows'; windows: AppWindowInfo[]; watched: number | null }
  /** One JPEG of `window` follows as a binary frame. */
  | { t: 'frame'; window: number; seq: number }
  /** One message of the video follows as a binary frame: a config or a frame, header and all (shared/stream.ts). */
  | { t: 'video' }
  /** How the watched window's pictures come from now on; `reason` says why it is JPEG when video was asked for. */
  | { t: 'codec'; codec: AppCodec; reason?: string }
  /** The cursor over the watched window (Electron's cursor type). */
  | { t: 'cursor'; cursor: string }
  /** Text copied in the app, for the PC's clipboard. */
  | { t: 'clipboard'; text: string }
  /** Where the app's sound plays (sent on `watch` and when it changes). */
  | { t: 'sound'; mode: SoundMode; toPc: boolean }
  /** The app's sound, for a client watching with `audio`: Opus packets (base64), in order (see APP_AUDIO). */
  | { t: 'audio'; packets: string[] }
  /** A PNG follows as a binary frame. */
  | { t: 'screenshot'; id: number; width: number; height: number }
  | { t: 'result'; id: number; ok: boolean; data?: unknown; error?: string }
  | { t: 'pong'; id: number }
  /** On the dialog socket: the dialogs waiting for an answer (sent on `hello` and whenever they change). */
  | { t: 'dialogs'; dialogs: AppDialog[]; closed?: { id: number; how: AppDialogClosed } };

/** Modifier bits on app input (the same bits as shared/hid.ts). On the Mac, GUI is ⌘. */
export const KEY_SHIFT = 1;
export const KEY_CONTROL = 2;
export const KEY_ALT = 4;
export const KEY_META = 8;

/**
 * Input for an app window. Points are 0 to 1 across the window's content,
 * from its top left corner; wheel deltas are in points, positive down and right.
 */
export type AppInputEvent =
  | { kind: 'mouse'; phase: 'down' | 'up' | 'move' | 'leave'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number; buttons?: number; modifiers?: number }
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number; modifiers?: number }
  /** A key, as the PC's keyboard reported it (DOM `key` and `code`). */
  | { kind: 'keyboard'; phase: 'down' | 'up'; key: string; code: string; modifiers?: number; repeat?: boolean }
  /** `paste` goes through the app's clipboard (⌘V); `type` inserts the text. */
  | { kind: 'text'; text: string; via?: 'type' | 'paste' };

/**
 * A PC's modifier keys as the Mac's: Ctrl is ⌘ (Command), so Windows
 * shortcuts work as their Mac ones (Ctrl+C → ⌘C); the Windows key is ⌃ (Control).
 */
export function macModifiers(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
  return (e.shiftKey ? KEY_SHIFT : 0) | (e.metaKey ? KEY_CONTROL : 0) | (e.altKey ? KEY_ALT : 0) | (e.ctrlKey ? KEY_META : 0);
}

/** Electron's cursor types, as CSS cursors (Electron's "pointer" is the arrow; its "hand" is CSS's pointer). */
export const CSS_CURSORS: Record<string, string> = {
  pointer: 'default',
  default: 'default',
  hand: 'pointer',
  text: 'text',
  'vertical-text': 'vertical-text',
  wait: 'wait',
  progress: 'progress',
  help: 'help',
  crosshair: 'crosshair',
  move: 'move',
  cell: 'cell',
  'context-menu': 'context-menu',
  alias: 'alias',
  copy: 'copy',
  'no-drop': 'no-drop',
  nodrop: 'no-drop',
  'not-allowed': 'not-allowed',
  grab: 'grab',
  grabbing: 'grabbing',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  none: 'none',
  'all-scroll': 'all-scroll',
  'col-resize': 'col-resize',
  'row-resize': 'row-resize',
  'e-resize': 'e-resize',
  'w-resize': 'w-resize',
  'n-resize': 'n-resize',
  's-resize': 's-resize',
  'ne-resize': 'ne-resize',
  'nw-resize': 'nw-resize',
  'se-resize': 'se-resize',
  'sw-resize': 'sw-resize',
  'ns-resize': 'ns-resize',
  'ew-resize': 'ew-resize',
  'nesw-resize': 'nesw-resize',
  'nwse-resize': 'nwse-resize',
};

/** The modifier names Electron's sendInputEvent takes for these bits. */
export function electronModifiers(bits = 0): string[] {
  const out: string[] = [];
  if (bits & KEY_SHIFT) out.push('shift');
  if (bits & KEY_CONTROL) out.push('control');
  if (bits & KEY_ALT) out.push('alt');
  if (bits & KEY_META) out.push('meta');
  return out;
}

const NAMED_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen',
  Shift: 'Shift',
  Control: 'Control',
  Alt: 'Alt',
  Meta: 'Meta',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  MediaPlayPause: 'MediaPlayPause',
  MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
};

/**
 * The key code Electron's sendInputEvent takes for a DOM key, or null for keys
 * it cannot type (dead keys, IME composition: their text comes as `text`).
 */
export function electronKeyCode(key: string, code: string): string | null {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key]!;
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  if (key === ' ') return 'Space';
  if (key === '+') return 'Plus';
  if ([...key].length === 1) return key;
  // Keys the layout gives no character for: fall back to the physical key.
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter.toLowerCase();
  const digit = code.match(/^Digit(\d)$/)?.[1];
  if (digit) return digit;
  return null;
}

/** The text a key types (for Electron's `char` event), or null when it types none. */
export function typedText(key: string, modifiers = 0): string | null {
  // ⌘ and Control shortcuts type nothing.
  if (modifiers & (KEY_META | KEY_CONTROL)) return null;
  if (key === 'Enter') return '\r';
  if ([...key].length === 1) return key;
  return null;
}

// ─── Menu shortcuts (macOS key equivalents) ───────────────────────────────

export interface Accelerator {
  /** Lower-case character ("c", ",", "+") or a named key ("enter", "f5", "up"). */
  key: string;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  control: boolean;
}

const ACCELERATOR_KEYS: Record<string, string> = {
  plus: '+',
  space: ' ',
  return: 'enter',
  enter: 'enter',
  esc: 'escape',
  escape: 'escape',
  backspace: 'backspace',
  delete: 'delete',
  tab: 'tab',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  insert: 'insert',
};

/** Parses an Electron accelerator ("CmdOrCtrl+Shift+Z") as the Mac reads it, or null. */
export function parseAccelerator(accelerator: string): Accelerator | null {
  // "CmdOrCtrl++" is CmdOrCtrl and Plus.
  const parts = accelerator.replace(/\+\+$/, '+Plus').split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const out: Accelerator = { key: '', meta: false, shift: false, alt: false, control: false };
  for (const [i, raw] of parts.entries()) {
    const part = raw.toLowerCase();
    const last = i === parts.length - 1;
    if (['command', 'cmd', 'commandorcontrol', 'cmdorctrl', 'super', 'meta'].includes(part)) out.meta = true;
    else if (['control', 'ctrl'].includes(part)) out.control = true;
    else if (['alt', 'option'].includes(part)) out.alt = true;
    else if (part === 'shift') out.shift = true;
    else if (part === 'altgr') return null;
    else if (last) out.key = ACCELERATOR_KEYS[part] ?? part;
    else return null;
  }
  return out.key ? out : null;
}

/** The key of a keyboard event, named the way parseAccelerator names keys. */
export function acceleratorKey(key: string, code: string): string {
  // The letter the PC's layout types (AZERTY's A sits where QWERTY has Q); the key's place for other scripts.
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter.toLowerCase();
  const digit = code.match(/^Digit(\d)$/)?.[1];
  if (digit) return digit;
  const named = NAMED_KEYS[key];
  if (named) return named.toLowerCase();
  if (/^F\d{1,2}$/.test(key)) return key.toLowerCase();
  if (key === ' ') return ' ';
  // Shift+= types "+": Cmd+Plus (zoom in) matches either.
  return key.toLowerCase();
}

/** Whether a key press (`key`, `code`, modifier bits) is this accelerator. */
export function matchesAccelerator(accelerator: Accelerator, key: string, code: string, modifiers = 0): boolean {
  const pressed = acceleratorKey(key, code);
  const plusKey = accelerator.key === '+' && (pressed === '+' || pressed === '=');
  if (!plusKey && pressed !== accelerator.key) return false;
  const shift = Boolean(modifiers & KEY_SHIFT);
  return (
    accelerator.meta === Boolean(modifiers & KEY_META) &&
    accelerator.control === Boolean(modifiers & KEY_CONTROL) &&
    accelerator.alt === Boolean(modifiers & KEY_ALT) &&
    // Shifted characters ("+", "?") carry Shift that the accelerator leaves implicit.
    (accelerator.shift === shift || (!accelerator.shift && plusKey))
  );
}

/** The shortcut a menu role has on macOS when the app gives it none (Electron's defaults). */
export const ROLE_ACCELERATORS: Record<string, string> = {
  undo: 'Command+Z',
  redo: 'Shift+Command+Z',
  cut: 'Command+X',
  copy: 'Command+C',
  paste: 'Command+V',
  pasteandmatchstyle: 'Shift+Option+Command+V',
  selectall: 'Command+A',
  reload: 'Command+R',
  forcereload: 'Shift+Command+R',
  toggledevtools: 'Alt+Command+I',
  resetzoom: 'Command+0',
  zoomin: 'Command+Plus',
  zoomout: 'Command+-',
  togglefullscreen: 'Control+Command+F',
  close: 'Command+W',
  minimize: 'Command+M',
  quit: 'Command+Q',
  hide: 'Command+H',
  hideothers: 'Alt+Command+H',
};

const STYLE_PROPERTY = /^(color|background(-color|-image)?|font(-weight|-size|-style|-family)?|padding(-(top|right|bottom|left))?|margin(-(top|right|bottom|left))?|border(-(radius|color|width|style|left|right|top|bottom))?|text-(decoration|shadow|transform|align)|line-height|display|letter-spacing|opacity|white-space|outline)$/i;
const STYLE_VALUE_WORD = /^(-?[\d.]+(px|em|rem|%|pt|vh|vw)?|#[0-9a-f]{3,8}|solid|dashed|dotted|double|none|bold|bolder|normal|italic|inherit|transparent|auto|inline-block|block|underline|uppercase|center)[;]?$/i;

/**
 * A page's console line without its styling: Electron hands over
 * `console.log('%cHi', 'color: red')` as "%cHi color: red", the format and
 * its arguments joined. Drops each `%c` and the CSS that goes with it.
 */
export function withoutConsoleStyles(text: string): string {
  const count = text.split('%c').length - 1;
  if (count === 0) return text;
  const words = text.replace(/%c/g, '').split(/(\s+)/);
  let removed = 0;
  for (let i = 0; i < words.length && removed < count; i++) {
    const property = /^([a-z-]+):/i.exec(words[i]!)?.[1];
    if (!property || !STYLE_PROPERTY.test(property)) continue;
    // One CSS argument: declarations ("color: red; font-weight: bold"), the last one without its ";" too.
    let end = i;
    for (;;) {
      const word = words[end]!;
      const name = /^([a-z-]+):(.*)$/i.exec(word);
      // "color:" alone: its value is the next word.
      let last = end;
      if (name && STYLE_PROPERTY.test(name[1]!) && name[2] === '' && words[end + 2] !== undefined) last = end + 2;
      // Values in more than one word ("2px 4px", "1px solid #ccc").
      while (!words[last]!.endsWith(';') && words[last + 2] !== undefined && STYLE_VALUE_WORD.test(words[last + 2]!)) last += 2;
      end = last;
      const next = words[end + 2];
      const nextName = next ? /^([a-z-]+):/i.exec(next)?.[1] : undefined;
      if (words[end]!.endsWith(';') && nextName && STYLE_PROPERTY.test(nextName)) {
        end += 2;
        continue;
      }
      break;
    }
    // The CSS and the space after it (or before it, at the end of the line).
    const from = i > 0 && end + 1 >= words.length ? i - 1 : i;
    words.splice(from, end - from + 2);
    removed += 1;
    i = from - 1;
  }
  return words.join('').trim();
}

// ─── A page's console, as the DevTools protocol reports it ────────────────

/** The part of a DevTools protocol RemoteObject (with its preview) the console line needs. */
export interface ConsoleValue {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: ConsolePreview;
}
interface ConsolePreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: Array<{ name: string; type: string; subtype?: string; value?: string; valuePreview?: ConsolePreview }>;
  entries?: Array<{ key?: ConsolePreview; value: ConsolePreview }>;
}

const quoted = (text: string) => `'${text}'`;

/** A property's value inside an object preview ("1", "'text'", "{…}", "Array(3)"). */
function previewValue(type: string, subtype: string | undefined, value: string | undefined, nested?: ConsolePreview): string {
  if (type === 'string') return quoted(value ?? '');
  if (type === 'function') return 'ƒ';
  if (type === 'object') {
    if (subtype === 'null') return 'null';
    if (nested && (subtype === 'array' || !subtype)) return formatPreview(nested, 1);
    if (subtype === 'array') return value ?? 'Array';
    if (subtype && subtype !== 'array') return value ?? subtype;
    return value && value !== 'Object' ? value : '{…}';
  }
  return value ?? type;
}

function formatPreview(preview: ConsolePreview, depth = 0): string {
  const more = preview.overflow ? ', …' : '';
  if (preview.entries) {
    const entries = preview.entries.map((e) => (e.key ? `${formatPreview(e.key, depth + 1)} => ${formatPreview(e.value, depth + 1)}` : formatPreview(e.value, depth + 1)));
    return `${preview.description ?? preview.subtype ?? ''} {${entries.join(', ')}${more}}`.trim();
  }
  if (preview.type !== 'object') return previewValue(preview.type, preview.subtype, preview.description);
  if (depth > 1 && preview.subtype !== 'array') return '{…}';
  const props = preview.properties ?? [];
  if (preview.subtype === 'array') {
    const items = props.filter((p) => /^\d+$/.test(p.name)).map((p) => previewValue(p.type, p.subtype, p.value, p.valuePreview));
    const named = props.filter((p) => !/^\d+$/.test(p.name)).map((p) => `${p.name}: ${previewValue(p.type, p.subtype, p.value, p.valuePreview)}`);
    return `[${[...items, ...named].join(', ')}${more}]`;
  }
  const body = props.map((p) => `${p.name}: ${previewValue(p.type, p.subtype, p.value, p.valuePreview)}`).join(', ');
  // A class instance says what it is ("Foo {a: 1}"); a plain object does not.
  const name = preview.description && preview.description !== 'Object' ? `${preview.description} ` : '';
  return `${name}{${body}${more}}`;
}

/** One console argument as DevTools shows it in a line. */
export function formatConsoleValue(v: ConsoleValue): string {
  switch (v.type) {
    case 'string':
      return String(v.value ?? '');
    case 'number':
    case 'bigint':
      return v.unserializableValue ?? v.description ?? String(v.value);
    case 'boolean':
      return String(v.value);
    case 'undefined':
      return 'undefined';
    case 'symbol':
      return v.description ?? 'Symbol()';
    case 'function':
      return (v.description ?? 'ƒ').split('\n')[0]!.slice(0, 200);
    case 'object':
      if (v.subtype === 'null') return 'null';
      // An error with its stack, a date, a regexp, a DOM node: their own description.
      if (v.subtype === 'error' || v.subtype === 'date' || v.subtype === 'regexp' || v.subtype === 'node') return v.description ?? v.className ?? 'Object';
      if (v.preview) return formatPreview(v.preview);
      return v.description ?? v.className ?? 'Object';
    default:
      return v.description ?? String(v.value ?? v.type);
  }
}

/**
 * A console call's arguments as one line, the way DevTools prints them:
 * the format string's %s %d %i %f %o %O filled in, %c styling dropped, the
 * rest joined with spaces.
 */
export function formatConsoleArgs(args: ConsoleValue[]): string {
  const rest = [...args];
  const out: string[] = [];
  const first = rest[0];
  if (first?.type === 'string' && typeof first.value === 'string' && first.value.includes('%')) {
    rest.shift();
    out.push(
      first.value.replace(/%([sdifoOc%])/g, (match, code: string) => {
        if (code === '%') return '%';
        if (code === 'c') {
          rest.shift();
          return '';
        }
        const next = rest.shift();
        if (!next) return match;
        if (code === 'd' || code === 'i') return next.type === 'number' ? String(Math.trunc(Number(next.value ?? next.description))) : 'NaN';
        if (code === 'f') return next.type === 'number' ? String(Number(next.value ?? next.description)) : 'NaN';
        return formatConsoleValue(next);
      }),
    );
  }
  for (const value of rest) out.push(formatConsoleValue(value));
  return out.join(' ');
}

/** A line Chromium (inside Electron) logged itself: "[1234:1015/094709.123:ERROR:gpu_init.cc(123)] …". */
export const CHROMIUM_LOG = /^\[\d+:\d+\/\d+\.\d+:(VERBOSE\d*|INFO|WARNING|ERROR|FATAL):[^\]]*\]\s?/;

/** Splits a line of the app's output into what the hook marked it as. */
export function parseAppLine(line: string): { kind: 'hook'; event: HookEvent } | { kind: 'main'; text: string } | { kind: 'other'; text: string } {
  const hook = line.indexOf(HOOK_MARK);
  if (hook >= 0) {
    try {
      const event = JSON.parse(line.slice(hook + HOOK_MARK.length)) as HookEvent;
      if (event && typeof event.e === 'string') return { kind: 'hook', event };
    } catch {
      // not ours after all
    }
  }
  const main = line.indexOf(MAIN_MARK);
  if (main >= 0) return { kind: 'main', text: line.slice(main + MAIN_MARK.length) };
  return { kind: 'other', text: line };
}

// ─── Agent operations (engine → agent) ────────────────────────────────────

/** How CapMac builds, launches and live-reloads an Electron app on the Mac (worked out on the PC). */
export interface ElectronPlan {
  flavor: ElectronFlavor;
  /** POSIX path from the project folder to the Electron app ('' when it is the project itself, "electron" for Capacitor). */
  appRel: string;
  /** Builds the app on the Mac before it launches (run in its folder), or null. */
  build: string | null;
  /** How the app starts: Electron itself with these arguments, or a command (in the app's folder). */
  launch: { electron: string[] } | { command: string };
  /** Live reload: the command that runs the app and reloads it (a dev server), or null when CapMac reloads it. */
  dev: { command: string; restartInput?: string } | null;
  /** Capacitor: the web assets folder, relative to the project. */
  webDir?: string;
}

export interface ElectronPrepareParams extends ProjectRef {
  plan: ElectronPlan;
  /** Live reload: the app loads a dev server, so Capacitor's web assets are not copied. */
  live?: boolean;
  /** Reinstall dependencies and build again. */
  full?: boolean;
}

export interface ElectronPrepareResult {
  /** Folders whose dependencies were installed (POSIX, from the synced root; '' for the root). */
  installed: string[];
  /** The Electron version in the project, once installed. */
  electron: string | null;
  /** Electron was downloaded for the Mac just now (false: it was there already). */
  downloaded: boolean;
  /** `npx cap copy @capacitor-community/electron` ran. */
  capCopied: boolean;
  /** The build ran (false: nothing changed since the last one, or nothing to build). */
  built: boolean;
  /** The Mac's macOS version ("26.6.1"). */
  macos: string | null;
}

export interface ElectronLaunchParams extends ProjectRef {
  plan: ElectronPlan;
  mode: 'run' | 'live';
  /** Where the app's sound plays when it starts (default off). */
  sound?: SoundMode;
  /** Capacitor live reload: the dev server, as the Mac reaches it (through the tunnel). */
  liveUrl?: string | null;
  /** A live-reload restart: an app someone was using on the Mac comes back in front (see frontFile). */
  restart?: boolean;
}

export interface ElectronLaunchResult {
  reason: 'exited' | 'cancelled';
  exitCode: number | null;
}

/** Requests the engine sends to a running `electron-launch` (answered with `control-result`). */
export type ElectronControl =
  | { t: 'control'; id: number; action: 'reload' }
  | { t: 'control'; id: number; action: 'modules' }
  /** Text for the dev command's input (Electron Forge restarts the app on "rs"). */
  | { t: 'control'; id: number; action: 'input'; text: string }
  /** Where the app's sound plays from now on. */
  | { t: 'control'; id: number; action: 'sound'; mode: SoundMode };

export interface ElectronScreenParams {
  projectId: string;
  /** Longest side of the frames in pixels. */
  maxSize?: number;
  fps?: number;
  /** JPEG quality 30-95. */
  quality?: number;
  /** The window to show (null: follow the focused one). */
  window?: number | null;
  /** Send the app's sound too, when it plays on the PC. */
  audio?: boolean;
  /** 'h264': the smooth stream when the app can send it (default 'jpeg'). */
  codec?: AppCodec;
  /** Video: the bitrate to start at; adaptive bitrate moves it between minBitrate and maxBitrate. */
  bitrate?: number;
  minBitrate?: number;
  maxBitrate?: number;
}
