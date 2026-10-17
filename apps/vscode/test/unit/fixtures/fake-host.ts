/**
 * A stand-in for CapMac Studio's engine host, behind the same parent port:
 * it answers calls, sends events and prompts, and echoes screen port
 * messages, so the extension's bridge can be tested without the engine.
 */
import '../../../src/engine/parent-port.js';

interface PortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

const parent = (process as unknown as { parentPort: { on(e: 'message', l: (e: { data: any; ports: PortLike[] }) => void): void; postMessage(m: unknown): void } }).parentPort;
let asking: number | null = null;

parent.on('message', (e) => {
  const m = e.data;
  switch (m.kind) {
    case 'init':
      // An engine that dies while it starts (a native module that won't load).
      if (process.env.FAKE_HOST_DIES) process.exit(4);
      parent.postMessage({ kind: 'ready' });
      break;
    case 'call':
      if (m.method === 'echo') {
        parent.postMessage({ kind: 'events', batch: [{ scope: { sessionId: 's-1' }, event: { type: 'log', level: 'info', message: 'before the result' } }] });
        parent.postMessage({ kind: 'result', id: m.id, result: { ok: true, value: m.params } });
      } else if (m.method === 'ask') {
        asking = m.id;
        parent.postMessage({ kind: 'prompt', prompt: { id: 'p-1', kind: 'confirm', message: 'Go on?' } });
      } else if (m.method === 'withdraw') {
        parent.postMessage({ kind: 'prompt', prompt: { id: 'p-2', kind: 'confirm', message: 'Waiting', waiting: 'Sign in in the browser' } });
        parent.postMessage({ kind: 'prompt-withdraw', id: 'p-2' });
        parent.postMessage({ kind: 'result', id: m.id, result: { ok: true, value: null } });
      } else if (m.method === 'crash') {
        process.exit(3);
      } else {
        parent.postMessage({ kind: 'result', id: m.id, result: { ok: false, error: { message: `Unknown request "${m.method}".`, expected: true } } });
      }
      break;
    case 'prompt-response':
      if (asking !== null) parent.postMessage({ kind: 'result', id: asking, result: { ok: true, value: m.response } });
      asking = null;
      break;
    case 'screen-open': {
      const port = e.ports[0]!;
      const listen = () => {
        port.on('message', (pe) => {
          const command = pe.data as { type: string };
          if (command.type === 'close-from-host') port.close();
          else port.postMessage({ type: 'echo', got: command, data: new Uint8Array([1, 2, 3]).buffer });
        });
        port.on('close', () => parent.postMessage({ kind: 'log', level: 'info', message: `port closed ${m.streamId}` }));
        port.start();
        port.postMessage({ type: 'state', state: 'streaming' });
      };
      // An app window's screen: the host listens once it has loaded the project.
      if (m.udid === 'slow') setTimeout(listen, 300);
      else listen();
      break;
    }
    case 'shutdown':
      parent.postMessage({ kind: 'shutdown-done' });
      break;
  }
});
