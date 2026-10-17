/**
 * Lets CapMac Studio's engine host (apps/desktop/src/engine/host.ts) run in a
 * plain Node.js child process of the extension. The host talks to Electron's
 * `process.parentPort` and gets each screen's MessagePort in `e.ports`; here
 * both go over Node's IPC channel to the extension, a screen's messages tagged
 * with its stream id. The host itself is used as is, so every engine method
 * CapMac Studio has, the extension has too.
 *
 * Imported before the host (see main.ts), so `process.parentPort` exists when
 * the host's module body reads it.
 */
import { EventEmitter } from 'node:events';
import type { ScreenPortMessage } from '../../../desktop/src/shared/contract.js';
import type { ToEngine, FromEngine } from './wire.js';

// The engine was started as Node.js (ELECTRON_RUN_AS_NODE). The tools it
// starts in turn (npm, flutter, Electron apps) must not inherit that.
delete process.env.ELECTRON_RUN_AS_NODE;

function send(message: FromEngine): void {
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {
    // The extension went away mid-send: 'disconnect' below shuts down.
  }
}

/**
 * One screen's port, as the host sees it (a MessagePortMain stand-in). Like
 * Electron's, it keeps what arrives until `start()`: the host listens only
 * once it has loaded the project (an app window's screen).
 */
class ScreenPort extends EventEmitter {
  private closed = false;
  /** What came before `start()`; null once started. */
  private queued: Array<() => void> | null = [];

  constructor(private readonly streamId: string) {
    super();
  }

  postMessage(message: ScreenPortMessage): void {
    if (!this.closed) send({ kind: 'port-message', streamId: this.streamId, message });
  }

  start(): void {
    const queued = this.queued ?? [];
    this.queued = null;
    for (const deliver of queued) deliver();
  }

  /** A message from the extension's end. */
  deliver(data: unknown): void {
    if (this.closed) return;
    if (this.queued) this.queued.push(() => this.emit('message', { data }));
    else this.emit('message', { data });
  }

  /** The host closed it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    ports.delete(this.streamId);
    send({ kind: 'port-closed', streamId: this.streamId });
  }

  /** The extension's end closed: tell the host, as Electron does (after what came before it). */
  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    ports.delete(this.streamId);
    if (this.queued) this.queued.push(() => this.emit('close'));
    else this.emit('close');
  }
}

const ports = new Map<string, ScreenPort>();

class ParentPort extends EventEmitter {
  postMessage(message: FromEngine): void {
    send(message);
    // The host finished stopping sessions after the extension went away.
    if (message.kind === 'shutdown-done' && !process.connected) process.exit(0);
  }

  start(): void {
    // Messages are delivered as they come.
  }
}

const parentPort = new ParentPort();
Object.defineProperty(process, 'parentPort', { value: parentPort, configurable: true });

process.on('message', (message: ToEngine) => {
  switch (message.kind) {
    case 'port-message':
      ports.get(message.streamId)?.deliver(message.message);
      return;
    case 'port-close':
      ports.get(message.streamId)?.remoteClosed();
      return;
    case 'screen-open': {
      ports.get(message.streamId)?.remoteClosed();
      const port = new ScreenPort(message.streamId);
      ports.set(message.streamId, port);
      parentPort.emit('message', { data: message, ports: [port] });
      return;
    }
    default:
      parentPort.emit('message', { data: message, ports: [] });
  }
});

// VS Code closed (or the extension restarted): stop runs cleanly, then leave.
process.on('disconnect', () => {
  parentPort.emit('message', { data: { kind: 'shutdown' }, ports: [] });
  setTimeout(() => process.exit(0), 6000).unref();
});
