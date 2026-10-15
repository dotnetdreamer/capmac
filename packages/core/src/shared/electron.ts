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
  | { e: 'note'; message: string };

/** Requests to the hook, on its socket (JSON frames, see shared/frames.ts). */
export type HookRequest =
  | { t: 'hello'; role: 'screen' | 'control' }
  /** Frames of a window (null: follow the focused one), at most `fps` a second, longest side `maxSize` pixels. */
  | { t: 'watch'; window: number | null; maxSize: number; fps: number; quality: number }
  | { t: 'unwatch' }
  /** A frame was sent on: the hook keeps at most two in flight. */
  | { t: 'ack' }
  | { t: 'input'; event: AppInputEvent }
  | { t: 'screenshot'; id: number; window?: number }
  | { t: 'reload'; id: number }
  /** The files loaded in the main process (to tell a reload from a restart). */
  | { t: 'modules'; id: number }
  | { t: 'window-action'; window: number; action: 'close' | 'minimize' | 'zoom' }
  | { t: 'ping'; id: number };

/** Messages from the hook, on its socket. */
export type HookMessage =
  | { t: 'hello'; app: HookAppInfo; windows: AppWindowInfo[] }
  /** The windows changed; `watched` is the one whose frames are coming. */
  | { t: 'windows'; windows: AppWindowInfo[]; watched: number | null }
  /** One JPEG of `window` follows as a binary frame. */
  | { t: 'frame'; window: number; seq: number }
  /** The cursor over the watched window (Electron's cursor type). */
  | { t: 'cursor'; cursor: string }
  /** Text copied in the app, for the PC's clipboard. */
  | { t: 'clipboard'; text: string }
  /** A PNG follows as a binary frame. */
  | { t: 'screenshot'; id: number; width: number; height: number }
  | { t: 'result'; id: number; ok: boolean; data?: unknown; error?: string }
  | { t: 'pong'; id: number };

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
  | { t: 'control'; id: number; action: 'input'; text: string };

export interface ElectronScreenParams {
  projectId: string;
  /** Longest side of the frames in pixels. */
  maxSize?: number;
  fps?: number;
  /** JPEG quality 30-95. */
  quality?: number;
  /** The window to show (null: follow the focused one). */
  window?: number | null;
}
