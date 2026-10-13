import { en } from './en.js';

export type { Strings } from './en.js';

/** The words CapMac Studio shows. English is the only language so far. */
export const t = en;

/**
 * Text from the shared engine (also the CLI's) ends sentences with a period;
 * the app shows it without one, like its own text.
 */
export function tidy(text: string): string;
export function tidy(text: string | null | undefined): string | undefined;
export function tidy(text: string | null | undefined): string | undefined {
  return text ? text.trim().replace(/(?<!\.)\.$/, '') : undefined;
}
