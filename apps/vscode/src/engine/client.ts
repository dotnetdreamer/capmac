/**
 * Starts and talks to the engine process (see main.ts), the way CapMac
 * Studio's main process talks to its engine host: typed calls, batched
 * events, prompts, and a channel per screen. Restarts it if it crashes.
 */
import { fork, type ChildProcess } from 'node:child_process';
import type {
  CallResult,
  EngineMethod,
  EngineStatus,
  Envelope,
  ErrorInfo,
  MethodParams,
  MethodResults,
  PromptRequest,
  PromptResponse,
  ScreenPortCommand,
  ScreenPortMessage,
} from '../../../desktop/src/shared/contract.js';
import type { HostInit, HostSettings } from '../../../desktop/src/shared/host-protocol.js';
import type { FromEngine, ToEngine } from './wire.js';

export interface EngineHandlers {
  onEvents(batch: Envelope[]): void;
  onPrompt(prompt: PromptRequest): void;
  onPromptWithdraw(id: string): void;
  onStatus(status: EngineStatus): void;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

/** What `screen-open` takes besides the stream id (see host-protocol.ts). */
export interface ScreenOpenOptions {
  mac: string;
  udid: string;
  prefer: 'smooth' | 'compatible';
  maxSize?: number;
  projectPath?: string;
  device?: { name: string };
}

/** One screen's two-way channel (a MessagePort in CapMac Studio). */
export interface ScreenChannel {
  readonly streamId: string;
  post(command: ScreenPortCommand): void;
  close(): void;
}

interface ScreenListener {
  onMessage(message: ScreenPortMessage): void;
  onClose(): void;
}

/** A failed call, with the engine's hint and details kept. */
export class EngineError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message);
    this.name = 'EngineError';
  }

  get cancelled(): boolean {
    return Boolean(this.info.cancelled);
  }
}

const crashed = (message: string): CallResult<never> => ({
  ok: false,
  error: { message, hint: 'CapMac restarted its engine. Try again', expected: true, code: 'ENGINE_CRASHED' },
});

export class EngineClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private nextStream = 1;
  private readonly pending = new Map<number, (result: CallResult<unknown>) => void>();
  private readonly screens = new Map<string, ScreenListener>();
  private readyPromise: Promise<void> = Promise.resolve();
  private stopping = false;
  private restarts: number[] = [];
  private visible = true;
  private shutdownResolve: (() => void) | null = null;

  constructor(
    private readonly modulePath: string,
    private readonly init: () => HostInit,
    private readonly handlers: EngineHandlers,
  ) {}

  start(): void {
    this.handlers.onStatus({ state: 'starting' });
    const child = fork(this.modulePath, [], {
      // VS Code's own runtime, as Node.js: nothing to install.
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // Structured clone: screen frames arrive as ArrayBuffers, not JSON.
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding('utf8').on('data', (d: string) => this.handlers.onLog('info', d.trimEnd()));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => this.handlers.onLog('error', d.trimEnd()));
    let markReady!: () => void;
    this.readyPromise = new Promise((resolve) => (markReady = resolve));
    child.on('message', (message: FromEngine) => {
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
        case 'prompt-withdraw':
          this.handlers.onPromptWithdraw(message.id);
          break;
        case 'log':
          this.handlers.onLog(message.level, message.message);
          break;
        case 'shutdown-done':
          this.shutdownResolve?.();
          break;
        case 'port-message':
          this.screens.get(message.streamId)?.onMessage(message.message);
          break;
        case 'port-closed': {
          const screen = this.screens.get(message.streamId);
          this.screens.delete(message.streamId);
          screen?.onClose();
          break;
        }
      }
    });
    child.on('error', (err) => this.handlers.onLog('error', `engine: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      // Calls waiting for this process to be ready hear that it is gone (a restart is another process).
      markReady();
      for (const resolve of this.pending.values()) resolve(crashed('The CapMac engine stopped'));
      this.pending.clear();
      for (const screen of this.screens.values()) screen.onClose();
      this.screens.clear();
      this.shutdownResolve?.();
      if (this.stopping) return;
      const now = Date.now();
      this.restarts = this.restarts.filter((at) => now - at < 60_000);
      const restarting = this.restarts.length < 5;
      this.handlers.onLog('error', `engine exited (${signal ?? code})${restarting ? ', restarting' : ''}`);
      this.handlers.onStatus({ state: 'crashed', restarting });
      if (restarting) {
        this.restarts.push(now);
        // Not when the extension stops meanwhile.
        setTimeout(() => !this.stopping && this.start(), 500);
      }
    });
    this.post({ kind: 'init', init: this.init() });
  }

  private post(message: ToEngine): void {
    const child = this.child;
    if (!child?.connected) return;
    try {
      child.send(message);
    } catch (err) {
      this.handlers.onLog('error', `engine: ${(err as Error).message}`);
    }
  }

  get running(): boolean {
    return this.child !== null;
  }

  async call<M extends EngineMethod>(method: M, params: MethodParams<M>): Promise<CallResult<MethodResults[M]>> {
    await this.readyPromise;
    if (!this.child) return crashed('The CapMac engine is not running');
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (result: CallResult<unknown>) => void);
      this.post({ kind: 'call', id, method, params });
    });
  }

  /** Like `call`, but throws an EngineError when the engine says no. */
  async invoke<M extends EngineMethod>(method: M, params: MethodParams<M>): Promise<MethodResults[M]> {
    const result = await this.call(method, params);
    if (!result.ok) throw new EngineError(result.error);
    return result.value;
  }

  respondPrompt(response: PromptResponse): void {
    this.post({ kind: 'prompt-response', response });
  }

  /** Opens a screen; frames and state come to `listener` until either side closes. */
  openScreen(options: ScreenOpenOptions, listener: ScreenListener): ScreenChannel {
    const streamId = `vs-${Date.now().toString(36)}-${(this.nextStream++).toString(36)}`;
    this.screens.set(streamId, listener);
    // The engine hears of the stream once it is ready; what the screen sends waits behind that, in order.
    const opened = this.readyPromise.then(() => this.post({ kind: 'screen-open', streamId, ...options }));
    return {
      streamId,
      post: (command) => void opened.then(() => this.post({ kind: 'port-message', streamId, message: command })),
      close: () => {
        if (!this.screens.delete(streamId)) return;
        void opened.then(() => this.post({ kind: 'port-close', streamId }));
      },
    };
  }

  setSettings(settings: HostSettings): void {
    this.post({ kind: 'settings', settings });
  }

  /** Nobody is looking: the engine stops polling Macs for device changes. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.post({ kind: 'visibility', visible });
  }

  /** Stops sessions (and the apps they run) cleanly, then the process. */
  async shutdown(timeoutMs = 4500): Promise<void> {
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
