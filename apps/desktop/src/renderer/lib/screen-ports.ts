/**
 * Screen streams arrive as MessagePorts posted by the preload script. A port
 * can arrive before or after the `screen-open` request returns, so ports are
 * kept here until the simulator pane claims them by stream id.
 */
const ports = new Map<string, MessagePort>();
const waiters = new Map<string, (port: MessagePort) => void>();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.data?.type !== 'capmac:screen-port') return;
    const port = e.ports[0];
    const id = String(e.data.streamId);
    if (!port) return;
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      waiter(port);
    } else {
      ports.set(id, port);
    }
  });
}

export function claimScreenPort(streamId: string, timeoutMs = 10_000): Promise<MessagePort> {
  install();
  const ready = ports.get(streamId);
  if (ready) {
    ports.delete(streamId);
    return Promise.resolve(ready);
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      waiters.delete(streamId);
      reject(new Error('The screen stream did not start.'));
    }, timeoutMs);
    waiters.set(streamId, (port) => {
      window.clearTimeout(timer);
      resolve(port);
    });
  });
}

// Listen from the start so no port is ever missed.
install();
