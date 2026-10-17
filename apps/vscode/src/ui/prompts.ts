/**
 * The engine's questions, asked with VS Code's own inputs: a password box, a
 * yes/no dialog, a pick list, a text box. Questions come one at a time; one
 * the engine no longer needs (a browser sign-in that finished) is withdrawn.
 */
import * as vscode from 'vscode';
import type { PromptRequest, PromptResponse } from '../../../desktop/src/shared/contract.js';
import { s, studio, tidy } from '../i18n.js';

type Answer = Omit<PromptResponse, 'id'>;

interface Open {
  close(): void;
}

export class Prompts implements vscode.Disposable {
  private readonly queue: PromptRequest[] = [];
  private busy = false;
  /** The question on screen. */
  private current: PromptRequest | null = null;
  private readonly open = new Map<string, Open>();
  private readonly withdrawn = new Set<string>();

  constructor(private readonly respond: (response: PromptResponse) => void) {}

  ask(prompt: PromptRequest): void {
    this.queue.push(prompt);
    void this.next();
  }

  withdraw(id: string): void {
    const index = this.queue.findIndex((p) => p.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
      return;
    }
    this.withdrawn.add(id);
    this.open.get(id)?.close();
  }

  /** The engine that asked stopped: none of its questions can be answered any more (a modal dialog stays up, its answer goes nowhere). */
  reset(): void {
    this.queue.length = 0;
    if (this.current) this.withdraw(this.current.id);
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    const prompt = this.queue.shift();
    if (!prompt) return;
    this.busy = true;
    this.current = prompt;
    try {
      const answer = await this.show(prompt);
      // A withdrawn question was answered by the engine already.
      if (!this.withdrawn.delete(prompt.id)) this.respond({ id: prompt.id, ...answer });
    } catch {
      if (!this.withdrawn.delete(prompt.id)) this.respond({ id: prompt.id, ok: false });
    } finally {
      this.open.delete(prompt.id);
      this.current = null;
      this.busy = false;
      void this.next();
    }
  }

  private show(prompt: PromptRequest): Promise<Answer> {
    switch (prompt.kind) {
      case 'password':
        return this.password(prompt);
      case 'confirm':
        return prompt.waiting ? this.waiting(prompt) : this.confirm(prompt);
      case 'choose':
        return this.choose(prompt);
      case 'text':
        return this.text(prompt);
    }
  }

  private input(id: string, setup: (box: vscode.InputBox) => void, validate?: (value: string) => string | undefined): Promise<Answer> {
    return new Promise((resolve) => {
      const box = vscode.window.createInputBox();
      box.ignoreFocusOut = true;
      setup(box);
      let done = false;
      const finish = (answer: Answer) => {
        if (done) return;
        done = true;
        resolve(answer);
        box.dispose();
      };
      box.onDidChangeValue((value) => (box.validationMessage = validate?.(value)));
      box.onDidAccept(() => {
        const problem = validate?.(box.value);
        if (problem) {
          box.validationMessage = problem;
          return;
        }
        finish({ ok: true, value: box.value });
      });
      box.onDidHide(() => finish({ ok: false }));
      this.open.set(id, { close: () => finish({ ok: false }) });
      box.show();
    });
  }

  private password(prompt: Extract<PromptRequest, { kind: 'password' }>): Promise<Answer> {
    const mac = prompt.mac ?? studio.common.theMac;
    const [title, why] = ({
      pair: [studio.prompts.signIn(mac), studio.prompts.signInWhy],
      keychain: [studio.prompts.keychain(mac), studio.prompts.keychainWhy],
      sudo: [studio.prompts.admin(mac), studio.prompts.adminWhy],
      signing: [studio.prompts.signing, studio.prompts.signingWhy],
      apple: [studio.prompts.apple, studio.prompts.appleWhy],
    } as const)[prompt.purpose];
    // A signing certificate may have no password: an empty answer is one.
    const optional = prompt.purpose === 'signing';
    return this.input(prompt.id, (box) => {
      box.title = title;
      box.password = true;
      // The engine's wording ends with a colon or a period ("Mac login password for ik:").
      box.prompt = `${tidy(prompt.message).replace(/[:.]\s*$/, '')}. ${why}`;
      box.placeholder = prompt.user ? studio.prompts.passwordFor(prompt.user) : studio.prompts.password;
    }, (value) => (optional || value ? undefined : studio.prompts.password));
  }

  private text(prompt: Extract<PromptRequest, { kind: 'text' }>): Promise<Answer> {
    const email = prompt.purpose === 'apple-email';
    const code = prompt.purpose === 'apple-code';
    return this.input(prompt.id, (box) => {
      box.title = email ? studio.prompts.appleEmail : code ? studio.prompts.appleCode : s.prompts.title;
      box.prompt = email ? `${tidy(prompt.message)}. ${studio.prompts.appleEmailWhy}` : tidy(prompt.message);
      box.value = prompt.defaultValue ?? '';
      box.placeholder = prompt.placeholder ?? (email ? studio.prompts.appleEmailLabel : code ? studio.prompts.appleCodeLabel : '');
    }, (value) => {
      if (email && value && !/^\S+@\S+$/.test(value.trim())) return studio.prompts.appleEmailLabel;
      if (code && !/^\d{4,8}$/.test(value.trim())) return studio.prompts.appleCodeLabel;
      return undefined;
    });
  }

  private async confirm(prompt: Extract<PromptRequest, { kind: 'confirm' }>): Promise<Answer> {
    const yes: vscode.MessageItem = { title: prompt.confirmLabel ?? s.prompts.yes };
    const no: vscode.MessageItem = { title: prompt.cancelLabel ?? studio.common.cancel, isCloseAffordance: true };
    const link: vscode.MessageItem | null = prompt.link ? { title: prompt.link.label } : null;
    const show = prompt.danger ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const detail = prompt.detail ? tidy(prompt.detail) : undefined;
    // A link (Apple's page for a manual step) opens and asks again.
    for (;;) {
      const items = link ? [yes, link, no] : [yes, no];
      const picked = await show(tidy(prompt.message), { modal: true, detail }, ...items);
      if (picked === link && prompt.link) {
        await vscode.env.openExternal(vscode.Uri.parse(prompt.link.url));
        continue;
      }
      return { ok: true, value: picked === yes };
    }
  }

  /** A question that waits on something else (a sign-in in the browser): a notification with progress and Cancel. */
  private waiting(prompt: Extract<PromptRequest, { kind: 'confirm' }>): Promise<Answer> {
    return new Promise((resolve) => {
      let done = false;
      let release!: () => void;
      const finish = (answer: Answer) => {
        if (done) return;
        done = true;
        resolve(answer);
        release();
      };
      this.open.set(prompt.id, { close: () => finish({ ok: true, value: false }) });
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tidy(prompt.message), cancellable: true }, (progress, token) => {
        progress.report({ message: tidy(prompt.waiting ?? prompt.detail ?? '') });
        token.onCancellationRequested(() => finish({ ok: true, value: false }));
        return new Promise<void>((r) => (release = r));
      });
    });
  }

  private choose(prompt: Extract<PromptRequest, { kind: 'choose' }>): Promise<Answer> {
    return new Promise((resolve) => {
      const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { index: number }>();
      pick.title = tidy(prompt.message);
      pick.placeholder = prompt.detail ? tidy(prompt.detail) : undefined;
      pick.ignoreFocusOut = true;
      pick.matchOnDetail = true;
      pick.items = prompt.items.map((item, index) => ({ label: item.label, detail: item.hint ? tidy(item.hint) : undefined, index }));
      let done = false;
      const finish = (answer: Answer) => {
        if (done) return;
        done = true;
        resolve(answer);
        pick.dispose();
      };
      pick.onDidAccept(() => {
        const item = pick.selectedItems[0];
        if (item) finish({ ok: true, value: item.index });
      });
      pick.onDidHide(() => finish({ ok: false }));
      this.open.set(prompt.id, { close: () => finish({ ok: false }) });
      pick.show();
    });
  }

  dispose(): void {
    for (const open of this.open.values()) open.close();
    this.queue.length = 0;
  }
}
