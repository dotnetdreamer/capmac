/** Starts and talks to the engine host (an Electron utility process). Restarts it if it crashes. */
import { utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import type { CallResult, EngineMethod, EngineStatus, Envelope, PromptRequest, PromptResponse } from '../shared/contract.js';
import type { HostInit, HostSettings, HostToMain, MainToHost } from '../shared/host-protocol.js';
import { t } from '../shared/i18n/index.js';

export interface EngineHandlers {
  onEvents(batch: Envelope[]): void;
  onPrompt(prompt: PromptRequest): void;
  onStatus(status: EngineStatus): void;
}

const crashed = (message: string): CallResult<never> => ({
  ok: false,
  error: { message, hint: t.engine.restartedHint, expected: true, code: 'ENGINE_CRASHED' },
});

export class EngineProcess {
  private child: UtilityProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (result: CallResult<unknown>) => void>();
  private readyPromise: Promise<void> = Promise.resolve();
  private stopping = false;
  private restarts: number[] = [];
  private visible = true;
  private shutdownResolve: (() => void) | null = null;

  constructor(private readonly modulePath: string, private readonly init: () => HostInit, private readonly handlers: EngineHandlers) {}

  start(): void {
    this.handlers.onStatus({ state: 'starting' });
    const child = utilityProcess.fork(this.modulePath, [], { serviceName: 'CapMac engine', stdio: 'pipe' });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[engine] ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[engine] ${d}`));
    let markReady!: () => void;
    this.readyPromise = new Promise((resolve) => (markReady = resolve));
    child.on('message', (message: HostToMain) => {
      switch (message.kind) {
        case 'ready':
          markReady();
          if (!this.visible) this.post({ kind: 'visibility', visible: false });
          this.handlers.onStatus({ state: 'ready' });
          break;
        case 'result': {
          const resolve = this.pending.get(message.id);
          this.pending.delete(message.id);
          resolve?.(message.result);
          break;
        }
        case 'events':
          this.handlers.onEvents(message.batch);
          break;
        case 'prompt':
          this.handlers.onPrompt(message.prompt);
          break;
        case 'log':
          (message.level === 'error' ? console.error : console.log)(`[engine] ${message.message}`);
          break;
        case 'shutdown-done':
          this.shutdownResolve?.();
          break;
      }
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      for (const resolve of this.pending.values()) resolve(crashed(t.engine.stopped));
      this.pending.clear();
      this.shutdownResolve?.();
      if (this.stopping) return;
      const now = Date.now();
      this.restarts = this.restarts.filter((at) => now - at < 60_000);
      const restarting = this.restarts.length < 5;
      console.error(`[engine] exited with code ${code}${restarting ? '; restarting' : ''}`);
      this.handlers.onStatus({ state: 'crashed', restarting });
      if (restarting) {
        this.restarts.push(now);
        setTimeout(() => this.start(), 500);
      }
    });
    child.postMessage({ kind: 'init', init: this.init() } satisfies MainToHost);
  }

  private post(message: MainToHost, transfer?: MessagePortMain[]): void {
    this.child?.postMessage(message, transfer);
  }

  async call(method: EngineMethod, params: unknown): Promise<CallResult<unknown>> {
    await this.readyPromise;
    if (!this.child) return crashed(t.engine.notRunning);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.post({ kind: 'call', id, method, params });
    });
  }

  respondPrompt(response: PromptResponse): void {
    this.post({ kind: 'prompt-response', response });
  }

  openScreen(streamId: string, mac: string, udid: string, port: MessagePortMain, options: { prefer: 'smooth' | 'compatible'; maxSize?: number; projectPath?: string }): void {
    void this.readyPromise.then(() => this.post({ kind: 'screen-open', streamId, mac, udid, ...options }, [port]));
  }

  setSettings(settings: HostSettings): void {
    this.post({ kind: 'settings', settings });
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.post({ kind: 'visibility', visible });
  }

  /** Stops sessions (and the apps they run) cleanly, then the process. */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.shutdownResolve = resolve;
        this.post({ kind: 'shutdown' });
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    child.kill();
  }
}
