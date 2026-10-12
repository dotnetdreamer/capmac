import { create } from 'zustand';
import type { AppInfo, EngineStatus, PromptRequest, Settings, SettingsPatch } from '../../shared/contract';

export type Route =
  | { name: 'home' }
  | { name: 'project'; path: string }
  | { name: 'devices' }
  | { name: 'macs' }
  | { name: 'settings' }
  | { name: 'onboarding' };

interface AppState {
  info: AppInfo | null;
  settings: Settings | null;
  engine: EngineStatus;
  route: Route;
  paletteOpen: boolean;
  /** The command palette opened on a nested picker (e.g. "Choose target…"). */
  paletteMode: string | null;
  navigate(route: Route): void;
  openPalette(mode?: string | null): void;
  closePalette(): void;
  updateSettings(patch: SettingsPatch): Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  info: null,
  settings: null,
  engine: { state: 'starting' },
  route: { name: 'home' },
  paletteOpen: false,
  paletteMode: null,
  navigate: (route) => {
    const current = get().route;
    if (current.name === route.name && (route.name !== 'project' || (current.name === 'project' && current.path === route.path))) return;
    set({ route });
  },
  openPalette: (mode = null) => set({ paletteOpen: true, paletteMode: mode }),
  closePalette: () => set({ paletteOpen: false, paletteMode: null }),
  updateSettings: async (patch) => {
    const current = get().settings;
    if (current) set({ settings: { ...current, ...patch } });
    const next = await window.capmac.invoke('app:set-settings', patch);
    set({ settings: next });
  },
}));

export const settings = () => useApp.getState().settings;

// ─── Toasts ────────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'caution' | 'critical';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  /** ms; 0 keeps it until dismissed. */
  timeout?: number;
}

interface ToastState {
  toasts: Toast[];
  show(toast: Omit<Toast, 'id'>): number;
  dismiss(id: number): void;
}

let nextToast = 1;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show: (toast) => {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (t: Omit<Toast, 'id'>) => useToasts.getState().show(t);

// ─── Engine prompts (password, confirm, …) answered with dialogs ──────────

interface PromptState {
  queue: PromptRequest[];
  push(prompt: PromptRequest): void;
  answer(id: string, ok: boolean, value?: string | boolean | number): void;
}

export const usePrompts = create<PromptState>((set) => ({
  queue: [],
  push: (prompt) => set((s) => (s.queue.some((p) => p.id === prompt.id) ? s : { queue: [...s.queue, prompt] })),
  answer: (id, ok, value) => {
    set((s) => ({ queue: s.queue.filter((p) => p.id !== id) }));
    void window.capmac.invoke('app:prompt-response', { id, ok, value });
  },
}));
