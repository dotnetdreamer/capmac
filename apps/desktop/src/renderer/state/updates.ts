import { create } from 'zustand';
import type { UpdateInfo } from '../../shared/contract';

interface UpdatesState {
  info: UpdateInfo | null;
  /** The ready version whose InfoBar the user closed (it comes back for a newer one). */
  dismissed: string | null;
  dismiss(version: string): void;
  check(): Promise<void>;
  install(): Promise<void>;
}

export const useUpdates = create<UpdatesState>((set) => ({
  info: null,
  dismissed: null,
  dismiss: (version) => set({ dismissed: version }),
  check: async () => {
    set({ info: await window.capmac.invoke('app:update-check') });
  },
  install: () => window.capmac.invoke('app:update-install'),
}));

let started = false;

/** Follows capmac Studio's own update state (pushed by main, plus the state now). */
export function startUpdates(): void {
  if (started) return;
  started = true;
  window.capmac.onUpdate((info) => useUpdates.setState({ info }));
  void window.capmac.invoke('app:update-status').then((info) => useUpdates.setState((s) => ({ info: s.info ?? info })), () => undefined);
}
