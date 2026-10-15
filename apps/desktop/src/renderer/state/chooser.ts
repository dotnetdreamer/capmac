/** The app chooser: which app to work on, when a folder has more than one. One question at a time. */
import { create } from 'zustand';
import type { AppSearch, RunnableApp } from '../../shared/contract';

export interface AppChoice {
  /** The project folder the app is in. */
  dir: string;
  app: RunnableApp;
}

interface ChooserState {
  request: { id: number; search: AppSearch; resolve: (choice: AppChoice | null) => void } | null;
  /** Asks; resolves with the app picked, or null when the question was dismissed. */
  ask(search: AppSearch): Promise<AppChoice | null>;
  answer(choice: AppChoice | null): void;
}

let nextId = 1;

export const useChooser = create<ChooserState>((set, get) => ({
  request: null,
  ask: (search) =>
    new Promise((resolve) => {
      // A newer question replaces one still open (it was about an older folder).
      get().request?.resolve(null);
      set({ request: { id: nextId++, search, resolve } });
    }),
  answer: (choice) => {
    const request = get().request;
    if (!request) return;
    set({ request: null });
    request.resolve(choice);
  },
}));
