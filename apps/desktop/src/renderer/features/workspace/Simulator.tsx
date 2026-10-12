import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import type { ErrorInfo, InputEvent, MacSummary, ScreenInfo, Target } from '../../../shared/contract';
import { workspaceBus, type WorkspaceAction } from '../../app/commands';
import { toast, useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { useMacs } from '../../state/macs';
import { claimScreenPort } from '../../lib/screen-ports';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState, Spinner, StatusDot } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Menu, Popover, usePopover } from '../../ui/Popover';
import { Tooltip } from '../../ui/Tooltip';

interface Stats {
  fps: number;
  kbps: number;
}

type StreamState = { kind: 'connecting' } | { kind: 'streaming' } | { kind: 'reconnecting' } | { kind: 'ended'; error?: ErrorInfo };

const PADDING = 11;

async function screenshot(mac: string, udid: string, action: 'save' | 'copy') {
  try {
    const shot = await call('screen.screenshot', { mac, udid });
    if (action === 'copy') {
      await window.capmac.invoke('app:copy-image', { data: shot.png });
      toast({ tone: 'success', title: 'Screenshot copied', body: shot.width ? `${shot.width} × ${shot.height}` : undefined });
    } else {
      const name = `Simulator ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      const saved = await window.capmac.invoke('app:save-image', { data: shot.png, name });
      if (saved) toast({ tone: 'success', title: 'Screenshot saved', body: saved, action: { label: 'Show in folder', run: () => void window.capmac.invoke('app:show-in-folder', { path: saved }) } });
    }
  } catch (err) {
    toast({ tone: 'critical', title: 'Could not take a screenshot', body: errorInfo(err).message });
  }
}

/** The live simulator screen: a canvas fed by a worker that decodes frames off the main thread. */
function Screen({ mac, target, frame }: { mac: string; target: Target; frame: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [state, setState] = useState<StreamState>({ kind: 'connecting' });
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [stats, setStats] = useState<Stats | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [epoch, setEpoch] = useState(0);
  const typePopover = usePopover();
  const shotMenu = usePopover();
  const [typed, setTyped] = useState('');
  const fixAxe = useCallback(async () => {
    try {
      await call('macs.fix', { name: mac, fix: 'install-axe' });
      toast({ tone: 'success', title: 'AXe installed', body: 'Touch and typing work now.' });
      setEpoch((e) => e + 1);
    } catch (err) {
      const e = errorInfo(err);
      if (!e.cancelled) toast({ tone: 'critical', title: 'Could not install AXe', body: e.hint ? `${e.message} ${e.hint}` : e.message });
    }
  }, [mac]);

  // Start the stream: worker + canvas + MessagePort from the engine.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A fresh canvas per stream: control of a canvas can be handed to a worker only once.
    const canvas = document.createElement('canvas');
    canvas.className = 'sim__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    let disposed = false;
    let streamId: string | null = null;
    const worker = new Worker(new URL('../../workers/screen.worker.ts', import.meta.url), { type: 'module', name: 'capmac screen' });
    workerRef.current = worker;
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'canvas', canvas: offscreen }, [offscreen]);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'frame-size') setFrameSize({ width: m.width, height: m.height });
      else if (m.type === 'first-frame') setHasFrame(true);
      else if (m.type === 'stats') setStats({ fps: m.fps, kbps: m.kbps });
      else if (m.type === 'info') setInfo(m.info);
      else if (m.type === 'state') setState(m.state === 'ended' ? { kind: 'ended', error: m.error } : { kind: m.state });
    };
    setState({ kind: 'connecting' });
    setHasFrame(false);
    (async () => {
      try {
        const opened = await window.capmac.invoke('app:screen-open', { mac, udid: target.udid });
        streamId = opened.streamId;
        const port = await claimScreenPort(opened.streamId);
        if (disposed) {
          port.close();
          return;
        }
        worker.postMessage({ type: 'port', port }, [port]);
      } catch (err) {
        if (!disposed) setState({ kind: 'ended', error: errorInfo(err) });
      }
    })();
    return () => {
      disposed = true;
      worker.terminate();
      canvas.remove();
      workerRef.current = null;
      if (streamId) void call('screen.stop', { streamId }).catch(() => undefined);
    };
  }, [mac, target.udid, epoch]);

  // Fit the screen into the pane (exact pixel sizes; the canvas backing store follows the DPR).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Resize in the next frame: resizing the device inside the observer's own callback
    // makes Chromium report a ResizeObserver loop.
    let raf = 0;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBox((b) => (b.width === width && b.height === height ? b : { width, height })));
    });
    observer.observe(stage);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);
  const aspect = frameSize ? frameSize.width / frameSize.height : 0.46;
  const pad = frame ? PADDING : 0;
  const maxH = Math.max(0, box.height - 2 * pad - 8);
  const maxW = Math.max(0, box.width - 2 * pad - 8);
  const screenH = Math.floor(Math.min(maxH, maxW / aspect));
  const screenW = Math.floor(screenH * aspect);
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    workerRef.current?.postMessage({ type: 'size', width: Math.round(screenW * dpr), height: Math.round(screenH * dpr) });
  }, [screenW, screenH, epoch]);

  // Input (needs AXe on the Mac)
  const canInput = Boolean(info?.input);
  const send = useCallback((event: InputEvent) => workerRef.current?.postMessage({ type: 'input', event }), []);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const point = (e: { clientX: number; clientY: number }) => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const ripple = (px: number, py: number) => {
    const id = Date.now() + Math.random();
    setRipples((r) => [...r, { id, x: px, y: py }]);
    window.setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 500);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !canInput) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    down.current = { x: p.x, y: p.y, t: performance.now() };
    e.currentTarget.focus();
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = down.current;
    down.current = null;
    if (!start || !canInput) return;
    const p = point(e);
    const dt = performance.now() - start.t;
    if (Math.hypot(p.x - start.x, p.y - start.y) < 0.015) {
      ripple(p.px, p.py);
      send(dt > 500 ? { kind: 'swipe', x1: start.x, y1: start.y, x2: p.x, y2: p.y, durationMs: Math.round(Math.min(dt, 2000)) } : { kind: 'tap', x: p.x, y: p.y });
    } else {
      send({ kind: 'swipe', x1: start.x, y1: start.y, x2: p.x, y2: p.y, durationMs: Math.round(Math.max(80, Math.min(dt, 1500))) });
    }
  };
  const wheel = useRef({ acc: 0, timer: 0, x: 0.5, y: 0.5 });
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const p = point(e);
    const w = wheel.current;
    w.acc += e.deltaY;
    w.x = p.x;
    w.y = p.y;
    window.clearTimeout(w.timer);
    w.timer = window.setTimeout(() => {
      const dy = Math.max(-0.5, Math.min(0.5, -w.acc / 1200));
      w.acc = 0;
      send({ kind: 'swipe', x1: w.x, y1: w.y, x2: w.x, y2: Math.min(0.98, Math.max(0.02, w.y + dy)), durationMs: 180 });
    }, 90);
  };
  const textBuffer = useRef({ text: '', timer: 0 });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canInput || e.ctrlKey || e.altKey || e.metaKey) return;
    const special = ({ Enter: 'return', Backspace: 'delete', Tab: 'tab', Escape: 'escape' } as const)[e.key as 'Enter'];
    const buffer = textBuffer.current;
    const flush = () => {
      window.clearTimeout(buffer.timer);
      if (buffer.text) send({ kind: 'text', text: buffer.text });
      buffer.text = '';
    };
    if (special) {
      e.preventDefault();
      flush();
      send({ kind: 'key', key: special });
    } else if (e.key.length === 1) {
      e.preventDefault();
      buffer.text += e.key;
      window.clearTimeout(buffer.timer);
      buffer.timer = window.setTimeout(flush, 200);
    }
  };

  // Workspace command: Ctrl+Shift+S
  useEffect(() => {
    const onAction = (e: Event) => {
      if ((e as CustomEvent<WorkspaceAction>).detail === 'screenshot') void screenshot(mac, target.udid, 'save');
    };
    workspaceBus.addEventListener('action', onAction);
    return () => workspaceBus.removeEventListener('action', onAction);
  }, [mac, target.udid]);

  const ended = state.kind === 'ended';
  // The connection dropped: keep the last frame, dimmed, until the stream resumes.
  const reconnecting = state.kind === 'reconnecting';
  return (
    <div className="sim">
      <div ref={stageRef} className="sim__stage">
        <div className={`sim__device${frame ? ' has-frame' : ''}`} style={{ width: screenW + 2 * pad, height: screenH + 2 * pad, padding: pad, borderRadius: frame ? Math.round(screenW * 0.13) + pad : 0 }}>
          <div className="sim__screen" style={{ width: screenW, height: screenH, borderRadius: frame ? Math.round(screenW * 0.13) : 4 }}>
            <div
              ref={hostRef}
              className={`sim__host${canInput ? ' can-input' : ''}`}
              style={{ width: screenW, height: screenH }}
              tabIndex={0}
              role="img"
              aria-label={`${target.name} screen${canInput ? '. Click to tap, drag to swipe, type to enter text.' : ' (view only)'}`}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (down.current = null)}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
            />
            {ripples.map((r) => (
              <span key={r.id} className="sim__ripple" style={{ left: r.x, top: r.y }} />
            ))}
            {(!hasFrame || ended || reconnecting) && (
              <div className={`sim__overlay${reconnecting && hasFrame ? ' is-dimmed' : ''}`}>
                {ended ? (
                  <>
                    <Icon name="plugDisconnected" size={20} />
                    <span>{state.error?.message ?? 'The screen stream stopped.'}</span>
                    {state.error?.hint && <span className="faint">{state.error.hint}</span>}
                    <Button size="sm" onClick={() => setEpoch((e) => e + 1)}>
                      Reconnect
                    </Button>
                  </>
                ) : (
                  <>
                    <Spinner size={20} />
                    <span>{reconnecting ? 'Reconnecting to the Mac…' : `Connecting to ${target.name}…`}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="sim__toolbar" role="toolbar" aria-label="Simulator controls">
        {info && !info.input ? (
          <span className="sim__viewonly">
            <Tooltip content="Touch, swipe and typing need AXe on the Mac">
              <span className="sim__viewonly-label" tabIndex={0}>
                <Icon name="eye" size={14} />
                View only
              </span>
            </Tooltip>
            <Button size="sm" variant="ghost" onClick={() => void fixAxe()}>
              Install AXe…
            </Button>
          </span>
        ) : (
          <>
            <IconButton icon="home" size="sm" label="Home" disabled={!canInput} onClick={() => send({ kind: 'button', button: 'home' })} />
            <IconButton icon="lock" size="sm" label="Lock" disabled={!canInput} onClick={() => send({ kind: 'button', button: 'lock' })} />
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Type text" disabled={!canInput} {...typePopover.triggerProps}>
              <Icon name="keyboard" size={16} />
            </button>
          </>
        )}
        <Popover state={typePopover} placement="top-start" label="Type text on the simulator">
          <form
            className="sim__type"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed) send({ kind: 'text', text: typed });
              setTyped('');
              typePopover.close();
            }}
          >
            <div className="input">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Text to type on the simulator" aria-label="Text to type" />
            </div>
            <Button type="submit" size="sm" variant="accent" icon="send">
              Send
            </Button>
          </form>
        </Popover>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Screenshot" aria-haspopup="menu" {...shotMenu.triggerProps}>
          <Icon name="camera" size={16} />
        </button>
        <Menu
          state={shotMenu}
          label="Screenshot"
          placement="top-start"
          items={[
            { id: 'save', label: 'Save screenshot…', icon: 'download', shortcut: 'Ctrl+Shift+S', onSelect: () => void screenshot(mac, target.udid, 'save') },
            { id: 'copy', label: 'Copy screenshot', icon: 'copy', onSelect: () => void screenshot(mac, target.udid, 'copy') },
          ]}
        />
        <span className="sim__spacer" />
        <span className="sim__stats tabular" aria-live="off">
          {state.kind === 'streaming' && hasFrame ? (
            <>
              <StatusDot tone="live" />
              {stats && stats.fps > 0 ? `${stats.fps} fps · ${stats.kbps >= 1000 ? `${(stats.kbps / 1000).toFixed(1)} Mbps` : `${stats.kbps} kbps`}` : 'Live'}
            </>
          ) : state.kind === 'ended' ? (
            'Disconnected'
          ) : reconnecting ? (
            'Reconnecting…'
          ) : (
            'Connecting…'
          )}
        </span>
      </div>
    </div>
  );
}

export function SimulatorPane({ mac, target, onBooted }: { mac: MacSummary | null; target: Target | null; onBooted?: () => void }) {
  const frame = useApp((s) => s.settings?.deviceFrame ?? true);
  const navigate = useApp((s) => s.navigate);
  const [booting, setBooting] = useState(false);
  const connected = useMacs((s) => (mac ? s.macs.find((m) => m.name === mac.name)?.state : undefined));

  if (!mac) {
    return (
      <EmptyState compact icon="mac" title="No Mac" actions={<Button onClick={() => navigate({ name: 'onboarding' })}>Pair a Mac</Button>}>
        The simulator runs on your Mac.
      </EmptyState>
    );
  }
  if (!target) {
    return (
      <EmptyState compact icon="phone" title="No simulator selected">
        Pick a simulator in the toolbar.
      </EmptyState>
    );
  }
  if (target.kind === 'device') {
    return (
      <EmptyState compact icon="phone" title={`${target.name} is a device`}>
        The live screen is available for simulators. Your app runs on the iPhone itself; its logs stream into the console.
      </EmptyState>
    );
  }
  if (connected === 'offline') {
    return (
      <EmptyState compact icon="plugDisconnected" title={`Can’t reach ${mac.label}`}>
        {mac.error ?? 'Make sure the Mac is awake and on the same network.'}
      </EmptyState>
    );
  }
  if (target.state !== 'Booted') {
    const boot = async () => {
      setBooting(true);
      try {
        await call('simulators.boot', { mac: mac.name, udid: target.udid });
        onBooted?.();
      } catch (err) {
        toast({ tone: 'critical', title: `Could not boot ${target.name}`, body: errorInfo(err).hint ?? errorInfo(err).message });
      } finally {
        setBooting(false);
      }
    };
    return (
      <EmptyState
        compact
        icon="power"
        title={booting || target.state === 'Booting' ? `Booting ${target.name}…` : `${target.name} is shut down`}
        actions={
          <Button variant="accent" icon="power" busy={booting || target.state === 'Booting'} onClick={() => void boot()}>
            Boot
          </Button>
        }
      >
        {target.os}. Run or Live boots it automatically.
      </EmptyState>
    );
  }
  return <Screen key={`${mac.name}-${target.udid}`} mac={mac.name} target={target} frame={frame} />;
}
