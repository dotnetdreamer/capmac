import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDialog } from '../../packages/core/src/shared/electron.js';

// The terminal's questions, answered by the test.
const replies: Array<string | null> = [];
const asked: string[] = [];
vi.mock('../../packages/cli/src/ui.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../packages/cli/src/ui.js')>();
  return {
    ...real,
    canPrompt: () => true,
    askUnless: (question: string, signal: AbortSignal) => {
      asked.push(question);
      const reply = replies.shift();
      if (reply !== undefined) return Promise.resolve(reply);
      // No reply yet: wait until the dialog goes away.
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
    },
  };
});

const { TerminalReporter } = await import('../../packages/cli/src/terminal.js');

const base = { window: null, blocking: false, app: 'Hello', title: '' };
const question: AppDialog = { ...base, id: 1, kind: 'message', type: 'question', message: 'Keep?', detail: '', buttons: ['Keep', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2, checkboxLabel: 'Always', checkboxChecked: false };
const save: AppDialog = { ...base, id: 2, kind: 'save', message: '', defaultPath: '/Users/me/Documents/a.txt', buttonLabel: '', filters: [], properties: [], nameFieldLabel: '', home: '/Users/me', project: null };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => {
  replies.length = 0;
  asked.length = 0;
});

describe('an Electron app’s dialogs in the terminal', () => {
  it('asks, and answers with the button picked (+ ticks the checkbox)', async () => {
    const reporter = new TerminalReporter({ mode: 'run', platform: 'electron' });
    const answers: unknown[] = [];
    reporter.onDialogAnswer = async (dialog, answer) => void answers.push([dialog.id, answer]);
    replies.push('9', '2+');
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [question] });
    await tick();
    // A number that is not a button asks again.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('Answer 1-3 (Enter: Keep');
    expect(answers).toEqual([[1, { kind: 'message', response: 1, checkboxChecked: true }]]);
  });

  it('saves to the suggested path on Enter, and reads typed paths on the Mac', async () => {
    const reporter = new TerminalReporter({ mode: 'run', platform: 'electron' });
    const answers: unknown[] = [];
    reporter.onDialogAnswer = async (_dialog, answer) => void answers.push(answer);
    replies.push('');
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [save] });
    await tick();
    replies.push('notes/b.txt');
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [] });
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [{ ...save, id: 3 }] });
    await tick();
    replies.push('-');
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [] });
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [{ ...save, id: 4 }] });
    await tick();
    expect(asked[0]).toContain('Enter: ~/Documents/a.txt');
    expect(answers).toEqual([
      { kind: 'files', paths: ['/Users/me/Documents/a.txt'] },
      { kind: 'files', paths: ['/Users/me/Documents/notes/b.txt'] },
      { kind: 'files', paths: [] },
    ]);
  });

  it('takes the question back when the dialog is answered elsewhere', async () => {
    const reporter = new TerminalReporter({ mode: 'dev', platform: 'electron' });
    const answers: unknown[] = [];
    reporter.onDialogAnswer = async (_dialog, answer) => void answers.push(answer);
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [question] });
    await tick();
    expect(asked).toHaveLength(1);
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [], closed: { id: 1, how: 'answered' } });
    await tick();
    expect(answers).toEqual([]);
    // The next dialog is asked about.
    replies.push('');
    reporter.handle({ type: 'app-dialogs', projectId: 'p', dialogs: [{ ...question, id: 5 }] });
    await tick();
    expect(answers).toEqual([{ kind: 'message', response: 0, checkboxChecked: false }]);
  });
});

describe('capmac dialog', async () => {
  const { answerFor } = await import('../../packages/cli/src/commands/dialog.js');
  const saveTxt: AppDialog = { ...save, filters: [{ name: 'Text', extensions: ['txt'] }] };

  it('reads a button by number or label, a cancel, and the checkbox', () => {
    expect(answerFor(question, '2', {})).toEqual({ kind: 'message', response: 1, checkboxChecked: false });
    expect(answerFor(question, 'discard', { check: true })).toEqual({ kind: 'message', response: 1, checkboxChecked: true });
    expect(answerFor(question, undefined, { cancel: true })).toEqual({ kind: 'message', response: 2, checkboxChecked: false });
    expect(answerFor(question, undefined, { check: true })).toEqual({ kind: 'message', response: 0, checkboxChecked: true });
    expect(() => answerFor(question, 'Maybe', {})).toThrow(/not one of the buttons/);
  });

  it('reads paths on the Mac, adds the file type’s extension when saving, and refuses PC paths', () => {
    expect(answerFor(saveTxt, '//tmp/note', {})).toEqual({ kind: 'files', paths: ['/tmp/note.txt'] });
    expect(answerFor(saveTxt, 'b', {})).toEqual({ kind: 'files', paths: ['/Users/me/Documents/b.txt'] });
    expect(answerFor(saveTxt, 'b.md', {})).toEqual({ kind: 'files', paths: ['/Users/me/Documents/b.md'] });
    expect(answerFor(saveTxt, undefined, {})).toEqual({ kind: 'files', paths: ['/Users/me/Documents/a.txt'] });
    expect(answerFor(saveTxt, undefined, { cancel: true })).toEqual({ kind: 'files', paths: [] });
    expect(() => answerFor(saveTxt, 'C:/Users/me/AppData/Local/Temp/x', {})).toThrow(/path on this PC/);
  });
});
