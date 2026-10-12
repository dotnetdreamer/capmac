import readline from 'node:readline';
import { isPrompting, setKeyMode } from './ui.js';

export type KeyHandlers = Record<string, () => void>;

/**
 * Single-key shortcuts (like Vite's `r`/`o`/`q`). In raw mode Ctrl+C arrives
 * as a key, so the 'ctrl+c' handler is responsible for quitting.
 */
export function listenForKeys(handlers: KeyHandlers): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => undefined;
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  setKeyMode(true);
  const listener = (str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined) => {
    if (isPrompting()) return;
    if (key?.ctrl && key.name === 'c') {
      handlers['ctrl+c']?.();
      return;
    }
    if (str && handlers[str]) handlers[str]!();
  };
  stdin.on('keypress', listener);
  return () => {
    setKeyMode(false);
    stdin.off('keypress', listener);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
}
