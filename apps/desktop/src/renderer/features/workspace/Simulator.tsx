import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { keystrokeForChar, keystrokeForKey } from '@capmac/core/shared/hid';
import { MIRROR_RECEIVER_NAME as RECEIVER_NAME } from '@capmac/core/shared/mirror';
import type { ErrorInfo, InputEvent, MacSummary, ScreenInfo, StreamFallback, Target } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { workspaceBus, type WorkspaceAction } from '../../app/commands';
import { toast, useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { useMacs } from '../../state/macs';
import { PhoneMirror, type MirrorPane } from '../../lib/phone-mirror';
import { claimScreenPort } from '../../lib/screen-ports';
import { both } from '../../state/actions';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState, Spinner, StatusDot } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Menu, Popover, usePopover } from '../../ui/Popover';
import { Tooltip } from '../../ui/Tooltip';

interface Stats {
  fps: number;
  kbps: number;
  decodeMs: number;
  latencyMs: number | null;
  latencyP95Ms: number | null;
  /** The last touch, key or button press to the picture that answered it. */
  inputMs: number | null;
}

type StreamState = { kind: 'connecting' } | { kind: 'streaming' } | { kind: 'reconnecting' } | { kind: 'ended'; error?: ErrorInfo };

const PADDING = 11;

/** A full-size screenshot: simctl's for a simulator, the newest picture for a plugged-in iPhone. */
async function screenshot(source: { mac: string } | { streamId: string }, target: Target, action: 'save' | 'copy') {
  try {
    const shot = 'streamId' in source ? await call('iphone.screenshot', { streamId: source.streamId }) : await call('screen.screenshot', { mac: source.mac, udid: target.udid });
    if (action === 'copy') {
      await window.capmac.invoke('app:copy-image', { data: shot.png });
      toast({ tone: 'success', title: t.simulator.shotCopied, body: shot.width ? `${shot.width} × ${shot.height}` : undefined });
    } else {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = target.kind === 'device' ? t.simulator.deviceShotName(target.name, stamp) : t.simulator.shotName(stamp);
      const saved = await window.capmac.invoke('app:save-image', { data: shot.png, name });
      if (saved) toast({ tone: 'success', title: t.simulator.shotSaved, body: saved, action: { label: t.common.showInFolder, run: () => void window.capmac.invoke('app:show-in-folder', { path: saved }) } });
    }
  } catch (err) {
    toast({ tone: 'critical', title: t.simulator.shotFailed, body: tidy(errorInfo(err).message) });
  }
}

const formatRate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);

/** The video's longest side for a canvas this tall: a little above it (crisp text), in steps, within limits. */
function videoSizeFor(canvasPixels: number, devicePixels: number | null): number {
  const want = Math.ceil(canvasPixels / 64) * 64;
  return Math.max(640, Math.min(2400, devicePixels ?? 2400, want));
}

/** The stream note in the footer: why the compatible stream is on, and the ways back (an app's window has no simulator to restart). */
export function CompatibleNote({ fallback, onRetry, onRestart }: { fallback: StreamFallback; onRetry: () => void; onRestart?: () => void }) {
  const pop = usePopover();
  return (
    <>
      <button type="button" className="sim__compat" {...pop.triggerProps}>
        <Icon name="info" size={14} />
        {t.simulator.compatible}
      </button>
      <Popover state={pop} placement="top-end" label={t.simulator.compatible} className="sim__compat-pop">
        <div className="sim__compat-body">
          <strong>{t.simulator.usingCompatible}</strong>
          <p>{tidy(fallback.message)}</p>
          {fallback.hint && <p className="faint">{tidy(fallback.hint)}</p>}
          {fallback.details && fallback.details.length > 0 && (
            <details>
              <summary>{t.simulator.details}</summary>
              <pre>{fallback.details.join('\n')}</pre>
            </details>
          )}
          <div className="sim__compat-actions">
            {fallback.restartSimulator && onRestart && (
              <Button size="sm" icon="power" onClick={() => { pop.close(); onRestart(); }}>
                {t.simulator.restart}
              </Button>
            )}
            <Button size="sm" variant="accent" icon="refresh" onClick={() => { pop.close(); onRetry(); }}>
              {t.simulator.trySmooth}
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/** An iPhone mirroring to this PC over Wi-Fi while none is plugged in or paired: its picture, no touch. */
export const MIRROR_TARGET: Target = { kind: 'device', udid: 'wifi-mirror', name: 'iPhone', os: '', osVersion: '', state: 'available', available: true };

let mirror: PhoneMirror | null = null;

/** The iPhone mirroring to this PC: one decoder for every This-PC pane, kept while Studio runs (see phone-mirror.ts). */
function phoneMirror(): PhoneMirror {
  if (mirror) return mirror;
  const created = new PhoneMirror({
    createWorker: () => new Worker(new URL('../../workers/screen.worker.ts', import.meta.url), { type: 'module', name: 'capmac iphone mirror' }),
    open: async ({ udid, projectPath }) => {
      const opened = await window.capmac.invoke('app:screen-open', { udid, backend: 'wsl', projectPath });
      return { streamId: opened.streamId, port: await claimScreenPort(opened.streamId) };
    },
    stop: (streamId) => call('screen.stop', { streamId }),
    errorInfo,
  });
  // The engine stopped: its stream went with it (it restarts by itself).
  useApp.subscribe((state, prev) => {
    if (state.engine.state === 'crashed' && prev.engine.state !== 'crashed') created.lost({ message: t.engine.stopped, hint: t.engine.restartedHint, expected: true });
  });
  mirror = created;
  return created;
}

/**
 * The live screen of a simulator, of an iPhone plugged into the Mac, or of an iPhone mirroring to
 * this PC: a canvas fed by a worker that decodes frames off the main thread.
 */
export function Screen({ mac, macLabel, target, frame, backend, projectPath }: { mac?: string; macLabel?: string; target: Target; frame: boolean; backend?: 'wsl'; projectPath?: string }) {
  const pc = backend === 'wsl';
  // No iPhone found at this PC, only one mirroring to it: no touch to set up.
  const mirrorOnly = pc && target.udid === MIRROR_TARGET.udid;
  const device = target.kind === 'device';
  const macRoute = useMacs((s) => (mac ? s.macs.find((m) => m.name === mac)?.route ?? null : null));
  const [targetBitrate, setTargetBitrate] = useState<number | null>(null);
  const macRtt = useMacs((s) => (mac ? s.macs.find((m) => m.name === mac)?.rttMs ?? null : null));
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  // This PC: the shared mirror, while this pane shows it.
  const mirrorRef = useRef<MirrorPane | null>(null);
  /** A message for this pane's decoder: its own worker, or the shared mirror's. */
  const post = useCallback((message: unknown) => (pc ? mirrorRef.current?.post(message) : workerRef.current?.postMessage(message)), [pc]);
  const prefer = useApp((s) => s.settings?.simulatorStream ?? 'smooth');
  const [state, setState] = useState<StreamState>({ kind: 'connecting' });
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [codec, setCodec] = useState<'h264' | 'jpeg' | null>(null);
  const [fallback, setFallback] = useState<StreamFallback | null>(null);
  const [preparing, setPreparing] = useState<{ stage: 'building' | 'starting'; xcode?: string } | null>(null);
  // A plugged-in iPhone: waiting for its cable, or for Allow on the Mac. An iPhone at this PC:
  // waiting for it to start mirroring (or, when it mirrors since too long ago, to start again).
  const [wait, setWait] = useState<'device' | 'permission' | 'mirror' | 'restart-mirroring' | 'firewall' | null>(null);
  // An iPhone at this PC: which one mirrors now.
  const [mirroring, setMirroring] = useState<string | null>(null);
  // A plugged-in iPhone sends nothing while its screen is off: say so after a moment.
  const [slowPicture, setSlowPicture] = useState(false);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [stats, setStats] = useState<Stats | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [epoch, setEpoch] = useState(0);
  const [announce, setAnnounce] = useState('');
  const typePopover = usePopover();
  const shotMenu = usePopover();
  const [typed, setTyped] = useState('');
  const canvasPixels = useRef(0);
  const fixAxe = useCallback(async () => {
    try {
      await call('macs.fix', { name: mac!, fix: 'install-axe' });
      toast({ tone: 'success', title: t.simulator.axeInstalled, body: t.simulator.axeInstalledBody });
      setEpoch((e) => e + 1);
    } catch (err) {
      const e = errorInfo(err);
      if (!e.cancelled) toast({ tone: 'critical', title: t.simulator.axeFailed, body: both(e) });
    }
  }, [mac]);

  // What the decoder says about the stream: its own news and the engine's, passed on.
  const onScreenMessage = useCallback((m: MessageEvent['data']) => {
    if (m.type === 'frame-size') setFrameSize({ width: m.width, height: m.height });
    else if (m.type === 'mirror-client') setMirroring(m.name);
    else if (m.type === 'first-frame') {
      setHasFrame(true);
      setPreparing(null);
    } else if (m.type === 'stats') setStats({ fps: m.fps, kbps: m.kbps, decodeMs: m.decodeMs, latencyMs: m.latencyMs, latencyP95Ms: m.latencyP95Ms, inputMs: m.inputMs });
    else if (m.type === 'info') setInfo(m.info);
    else if (m.type === 'status') setTargetBitrate(m.bitrate);
    else if (m.type === 'preparing') setPreparing({ stage: m.stage, xcode: m.xcode });
    else if (m.type === 'device-wait') setWait(m.wait);
    else if (m.type === 'codec') {
      setCodec(m.codec);
      setFallback(m.fallback);
      if (m.fallback) setAnnounce(t.simulator.switched(tidy(m.fallback.message)));
    } else if (m.type === 'state') setState(m.state === 'ended' ? { kind: 'ended', error: m.error } : { kind: m.state });
  }, []);
  const resetStream = () => {
    setState({ kind: 'connecting' });
    setHasFrame(false);
    setPreparing(null);
    setWait(null);
    setMirroring(null);
    setFallback(null);
  };

  // Start the stream: worker + canvas + MessagePort from the engine.
  useEffect(() => {
    const host = hostRef.current;
    if (pc || !host) return;
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
    worker.onmessage = (e) => onScreenMessage(e.data);
    resetStream();
    (async () => {
      try {
        const maxSize = canvasPixels.current ? videoSizeFor(canvasPixels.current, null) : undefined;
        const opened = await window.capmac.invoke('app:screen-open', { mac, udid: target.udid, maxSize, device: device ? { name: target.name } : undefined });
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
  }, [mac, target.udid, target.name, device, epoch, prefer, pc, onScreenMessage]);

  // This PC: the shared mirror draws on a fresh canvas while this pane is shown, and says how the
  // stream is now. Before the first paint, so its picture shows at once.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!pc || !host || !projectPath) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'sim__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    resetStream();
    const pane = phoneMirror().attach({ udid: target.udid, projectPath }, canvas.transferControlToOffscreen(), onScreenMessage);
    mirrorRef.current = pane;
    return () => {
      pane.detach();
      mirrorRef.current = null;
      canvas.remove();
    };
  }, [pc, target.udid, projectPath, epoch, onScreenMessage]);

  // The iPhone's screen is up but no picture came: its screen is probably off.
  useEffect(() => {
    setSlowPicture(false);
    if (!device || hasFrame || !info || wait) return;
    const timer = window.setTimeout(() => setSlowPicture(true), 4000);
    return () => window.clearTimeout(timer);
  }, [device, hasFrame, info, wait]);

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
    canvasPixels.current = Math.round(Math.max(screenW, screenH) * dpr);
    post({ type: 'size', width: Math.round(screenW * dpr), height: Math.round(screenH * dpr) });
  }, [screenW, screenH, epoch, post]);

  // Smooth stream: keep the video about as sharp as the canvas shows it (settled sizes only).
  const devicePixels = info?.points && info.scale ? Math.round(Math.max(info.points.width, info.points.height) * info.scale) : null;
  const sentVideoSize = useRef(0);
  useEffect(() => {
    if (codec !== 'h264' || !screenH) return;
    const timer = window.setTimeout(() => {
      const want = videoSizeFor(canvasPixels.current, devicePixels);
      if (sentVideoSize.current && Math.abs(want - sentVideoSize.current) / sentVideoSize.current < 0.12) return;
      sentVideoSize.current = want;
      post({ type: 'video-size', maxSize: want });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [codec, screenW, screenH, devicePixels, post]);

  // ─── Input ───────────────────────────────────────────────────────────────
  // 'touch' (capmac's helper): fingers stream as they move. 'gestures' (AXe): whole taps and swipes.
  const mode = info?.input ? (info.inputMode ?? 'gestures') : null;
  const canInput = mode !== null;
  const send = useCallback((event: InputEvent) => post({ type: 'input', event }), [post]);
  const point = (e: { clientX: number; clientY: number }) => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const ripple = (px: number, py: number) => {
    const id = Date.now() + Math.random();
    setRipples((r) => [...r, { id, x: px, y: py }]);
    window.setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 500);
  };

  // Touch mode: one finger (Alt: two, mirrored around the centre, to pinch and rotate).
  const finger = useRef<{ id: number; two: boolean; x: number; y: number } | null>(null);
  const moveFrame = useRef(0);
  const endTouch = useCallback(
    (how: 'up' | 'cancel', at?: { x: number; y: number }) => {
      const f = finger.current;
      if (!f) return;
      finger.current = null;
      cancelAnimationFrame(moveFrame.current);
      const x = at?.x ?? f.x;
      const y = at?.y ?? f.y;
      if (f.two) send({ kind: 'touch2', phase: 'up', x1: x, y1: y, x2: 1 - x, y2: 1 - y });
      else send({ kind: 'touch', phase: how, x, y });
    },
    [send],
  );
  // No stuck fingers: lift on blur, on disconnect, and when the pane goes away.
  useEffect(() => {
    const onBlur = () => endTouch('cancel');
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      endTouch('cancel');
    };
  }, [endTouch]);
  useEffect(() => {
    if (state.kind !== 'streaming') finger.current = null;
  }, [state.kind]);

  // Gestures mode (AXe): a tap or a swipe once the pointer is released.
  const down = useRef<{ x: number; y: number; t: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !canInput) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    const p = point(e);
    if (mode === 'touch') {
      endTouch('cancel');
      const two = e.altKey;
      finger.current = { id: e.pointerId, two, x: p.x, y: p.y };
      ripple(p.px, p.py);
      if (two) send({ kind: 'touch2', phase: 'down', x1: p.x, y1: p.y, x2: 1 - p.x, y2: 1 - p.y });
      else send({ kind: 'touch', phase: 'down', x: p.x, y: p.y });
    } else {
      down.current = { x: p.x, y: p.y, t: performance.now() };
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const f = finger.current;
    if (!f || f.id !== e.pointerId) return;
    const p = point(e);
    f.x = p.x;
    f.y = p.y;
    // At most one move per display frame.
    cancelAnimationFrame(moveFrame.current);
    moveFrame.current = requestAnimationFrame(() => {
      const now = finger.current;
      if (!now) return;
      if (now.two) send({ kind: 'touch2', phase: 'move', x1: now.x, y1: now.y, x2: 1 - now.x, y2: 1 - now.y });
      else send({ kind: 'touch', phase: 'move', x: now.x, y: now.y });
    });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (mode === 'touch') {
      if (finger.current?.id === e.pointerId) endTouch('up', point(e));
      return;
    }
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
  const onPointerCancel = () => {
    down.current = null;
    endTouch('cancel');
  };

  const wheel = useRef({ dx: 0, dy: 0, x: 0.5, y: 0.5, frame: 0, timer: 0 });
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const p = point(e);
    const w = wheel.current;
    if (mode === 'touch') {
      // Wheel and touchpad scrolling, in the simulator's points: one display frame's worth at a time.
      const r = hostRef.current!.getBoundingClientRect();
      const perPixel = info?.points ? info.points.height / r.height : 1;
      const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? r.height : 1;
      w.dx += e.deltaX * lines * perPixel;
      w.dy += e.deltaY * lines * perPixel;
      w.x = p.x;
      w.y = p.y;
      if (!w.frame) {
        w.frame = requestAnimationFrame(() => {
          w.frame = 0;
          if (Math.abs(w.dx) + Math.abs(w.dy) < 0.5) return;
          send({ kind: 'scroll', x: w.x, y: w.y, dx: Math.max(-2000, Math.min(2000, w.dx)), dy: Math.max(-2000, Math.min(2000, w.dy)) });
          w.dx = 0;
          w.dy = 0;
        });
      }
      return;
    }
    w.dy += e.deltaY;
    w.x = p.x;
    w.y = p.y;
    window.clearTimeout(w.timer);
    w.timer = window.setTimeout(() => {
      const dy = Math.max(-0.5, Math.min(0.5, -w.dy / 1200));
      w.dy = 0;
      send({ kind: 'swipe', x1: w.x, y1: w.y, x2: w.x, y2: Math.min(0.98, Math.max(0.02, w.y + dy)), durationMs: 180 });
    }, 90);
  };

  const textBuffer = useRef({ text: '', timer: 0 });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canInput) return;
    // Simulator.app's shortcuts for the hardware buttons.
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyH' || e.code === 'KeyL')) {
      e.preventDefault();
      send({ kind: 'button', button: e.code === 'KeyH' ? 'home' : 'lock' });
      return;
    }
    if (mode === 'touch') {
      // Ctrl+V arrives as a paste event (with this PC's clipboard).
      if (e.ctrlKey && !e.altKey && e.code === 'KeyV') return;
      const stroke = keystrokeForKey(e);
      if (stroke) {
        e.preventDefault();
        send({ kind: 'keypress', usage: stroke.usage, modifiers: stroke.modifiers || undefined });
      } else if (!e.ctrlKey && [...e.key].length === 1 && !keystrokeForChar(e.key)) {
        // A character no US key types (é, ß, …): typed through the simulator's pasteboard.
        e.preventDefault();
        send({ kind: 'text', text: e.key });
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
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
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    send({ kind: 'text', text: text.slice(0, 20_000), via: mode === 'touch' ? 'paste' : 'type' });
  };

  const retrySmooth = useCallback(() => {
    setFallback(null);
    post({ type: 'retry-smooth' });
  }, [post]);
  // This PC iPhone: sign and install WebDriverAgent so the screen takes taps (one Apple sign-in).
  const [settingUpTouch, setSettingUpTouch] = useState(false);
  const setUpTouch = useCallback(async () => {
    if (!projectPath) return;
    setSettingUpTouch(true);
    try {
      await call('iphone.setUpTouch', { projectPath, udid: target.udid });
      toast({ tone: 'success', title: t.pc.screen.touchOn });
      // Touch starts on the stream that is open: a new one could not show the picture again.
      mirrorRef.current?.refreshTouch();
    } catch (err) {
      const e = errorInfo(err);
      if (!e.cancelled) toast({ tone: 'critical', title: t.pc.screen.touchFailed, body: both(e) });
    } finally {
      setSettingUpTouch(false);
    }
  }, [projectPath, target.udid]);
  const restartSimulator = useCallback(async () => {
    try {
      toast({ tone: 'info', title: t.simulator.restarting(target.name), body: t.simulator.restartingBody });
      await call('simulators.shutdown', { mac: mac!, udid: target.udid });
      await call('simulators.boot', { mac: mac!, udid: target.udid });
      setEpoch((n) => n + 1);
    } catch (err) {
      toast({ tone: 'critical', title: t.simulator.restartFailed(target.name), body: tidy(errorInfo(err).hint ?? errorInfo(err).message) });
    }
  }, [mac, target.udid, target.name]);

  /** Where a full-size screenshot comes from: the Mac's simulator, or this PC's iPhone stream. */
  const shotSource = (): { mac: string } | { streamId: string } => {
    const streamId = pc ? mirrorRef.current?.streamId : null;
    return streamId ? { streamId } : { mac: mac! };
  };

  // Workspace command: Ctrl+Shift+S
  useEffect(() => {
    const onAction = (e: Event) => {
      if ((e as CustomEvent<WorkspaceAction>).detail === 'screenshot') void screenshot(shotSource(), target, 'save');
    };
    workspaceBus.addEventListener('action', onAction);
    return () => workspaceBus.removeEventListener('action', onAction);
  }, [mac, target, pc]);

  const ended = state.kind === 'ended';
  // The connection dropped, or the iPhone was unplugged: keep the last frame, dimmed, until the picture is back.
  const reconnecting = state.kind === 'reconnecting';
  const waiting = !ended && wait !== null;
  const connectingText = device
    ? preparing?.stage === 'building'
      ? t.simulator.deviceSettingUp
      : preparing?.stage === 'starting' || info
        ? t.simulator.deviceStarting(target.name)
        : t.simulator.connectingTo(target.name)
    : preparing?.stage === 'building'
      ? t.simulator.settingUp(preparing.xcode)
      : preparing?.stage === 'starting'
        ? t.simulator.startingSmooth
        : t.simulator.connectingTo(target.name);
  const streamName = codec === 'h264' ? t.simulator.streamSmooth : codec === 'jpeg' ? t.simulator.streamCompatible : t.simulator.stream;
  const overInternet = macRoute === 'direct' || macRoute === 'relay';
  const statsTip = [
    pc && mirroring ? t.pc.screen.mirroring(mirroring) : streamName,
    overInternet ? t.simulator.overInternetRoute(macRoute, macRtt) : null,
    codec === 'h264' && targetBitrate ? t.simulator.upTo(formatRate(Math.round(targetBitrate / 1000))) : null,
    stats && codec === 'h264' && stats.latencyMs !== null ? t.simulator.delay(Math.round(stats.latencyMs), Math.round(stats.latencyP95Ms ?? stats.latencyMs)) : null,
    stats && stats.fps > 0 ? t.simulator.decode(stats.decodeMs.toFixed(1)) : null,
    stats?.inputMs != null ? t.simulator.touch(Math.round(stats.inputMs)) : null,
    codec === 'h264' && stats?.fps === 0 ? t.simulator.still : null,
  ].filter(Boolean).join(' · ');
  const viewOnlyReason = mirrorOnly ? t.pc.screen.touchPlugIn : pc ? tidy(info?.inputReason) ?? t.pc.screen.touchOffWhy : device ? t.simulator.deviceViewOnly : tidy(info?.inputReason) ?? t.simulator.viewOnlyWhy;
  const inputHelp = mode === 'touch' ? t.simulator.helpTouch : t.simulator.helpBasic;
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
              aria-label={t.simulator.screen(target.name, canInput ? inputHelp : null)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onLostPointerCapture={(e) => {
                if (finger.current?.id === e.pointerId) endTouch('cancel');
              }}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onBlur={() => endTouch('cancel')}
            />
            {ripples.map((r) => (
              <span key={r.id} className="sim__ripple" style={{ left: r.x, top: r.y }} />
            ))}
            {(!hasFrame || ended || reconnecting || waiting) && (
              <div className={`sim__overlay${(reconnecting || waiting) && hasFrame ? ' is-dimmed' : ''}`}>
                {ended ? (
                  <>
                    <Icon name={state.error?.code === 'DEVICE_SCREEN_DENIED' ? 'shieldError' : 'plugDisconnected'} size={20} />
                    <span>{tidy(state.error?.message) ?? t.simulator.stopped}</span>
                    {state.error?.hint && <span className="faint">{tidy(state.error.hint)}</span>}
                    <Button size="sm" onClick={() => setEpoch((e) => e + 1)}>
                      {device ? t.simulator.tryAgain : t.simulator.reconnect}
                    </Button>
                  </>
                ) : waiting && !reconnecting && pc ? (
                  <>
                    <Icon name={wait === 'firewall' ? 'wifiOff' : 'wifi'} size={20} />
                    <span>{wait === 'firewall' ? t.pc.screen.firewallTitle : wait === 'restart-mirroring' ? t.pc.screen.mirrorAgainTitle : t.pc.screen.mirrorTitle}</span>
                    <span className="faint">{wait === 'firewall' ? t.pc.screen.firewallBody : wait === 'restart-mirroring' ? t.pc.screen.mirrorAgainBody(RECEIVER_NAME) : t.pc.screen.mirrorBody(RECEIVER_NAME)}</span>
                  </>
                ) : waiting && !reconnecting ? (
                  <>
                    <Icon name={wait === 'device' ? 'usb' : 'shield'} size={20} />
                    <span>{wait === 'device' ? t.simulator.plugIn(target.name, macLabel ?? '') : t.simulator.allowOnMac(macLabel ?? '')}</span>
                    <span className="faint">{wait === 'device' ? t.simulator.plugInBody : t.simulator.allowOnMacBody}</span>
                  </>
                ) : (
                  <>
                    <Spinner size={20} />
                    <span>{reconnecting ? t.simulator.reconnectingMac : connectingText}</span>
                    {!reconnecting && preparing?.stage === 'building' && <span className="faint">{t.simulator.firstTime}</span>}
                    {!reconnecting && slowPicture && <span className="faint">{t.simulator.deviceNoPicture}</span>}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="sim__toolbar" role="toolbar" aria-label={device ? t.simulator.deviceControls : t.simulator.controls}>
        {(info && !info.input) || (device && !pc) ? (
          <span className="sim__viewonly">
            <Tooltip content={viewOnlyReason}>
              <span className="sim__viewonly-label" tabIndex={0}>
                <Icon name="eye" size={14} />
                {t.simulator.viewOnly}
              </span>
            </Tooltip>
            {mirrorOnly ? null : pc ? (
              <Button size="sm" variant="ghost" icon="phone" busy={settingUpTouch} onClick={() => void setUpTouch()}>
                {t.pc.screen.turnOnTouch}
              </Button>
            ) : !device ? (
              <Button size="sm" variant="ghost" onClick={() => void fixAxe()}>
                {t.simulator.installAxe}
              </Button>
            ) : null}
          </span>
        ) : (
          <>
            <IconButton icon="home" size="sm" label={t.simulator.home} shortcut="Ctrl+Shift+H" disabled={!canInput} onClick={() => send({ kind: 'button', button: 'home' })} />
            <IconButton icon="lock" size="sm" label={t.simulator.lock} shortcut="Ctrl+Shift+L" disabled={!canInput} onClick={() => send({ kind: 'button', button: 'lock' })} />
            <button type="button" className="icon-btn icon-btn--sm" aria-label={t.simulator.typeText} disabled={!canInput} {...typePopover.triggerProps}>
              <Icon name="keyboard" size={16} />
            </button>
          </>
        )}
        <Popover state={typePopover} placement="top-start" label={t.simulator.typeTitle}>
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
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.simulator.typePlaceholder} aria-label={t.simulator.textToType} />
            </div>
            <Button type="submit" size="sm" variant="accent" icon="send">
              {t.simulator.send}
            </Button>
          </form>
        </Popover>
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t.simulator.screenshot} aria-haspopup="menu" disabled={device && !hasFrame} {...shotMenu.triggerProps}>
          <Icon name="camera" size={16} />
        </button>
        <Menu
          state={shotMenu}
          label={t.simulator.screenshot}
          placement="top-start"
          items={[
            { id: 'save', label: t.simulator.saveShot, icon: 'download', shortcut: 'Ctrl+Shift+S', onSelect: () => void screenshot(shotSource(), target, 'save') },
            { id: 'copy', label: t.simulator.copyShot, icon: 'copy', onSelect: () => void screenshot(shotSource(), target, 'copy') },
          ]}
        />
        <span className="sim__spacer" />
        {fallback && codec === 'jpeg' && <CompatibleNote fallback={fallback} onRetry={retrySmooth} onRestart={() => void restartSimulator()} />}
        <Tooltip content={statsTip} placement="top">
          <span className="sim__stats tabular" tabIndex={0} aria-live="off">
            {state.kind === 'streaming' && hasFrame ? (
              <>
                <StatusDot tone="live" />
                {overInternet && <Icon name="globe" size={12} className="sim__route" label={t.simulator.overInternet} />}
                {/* Next to the compatible-stream note, the frame rate says enough. */}
                {stats && stats.fps > 0 ? (fallback && codec === 'jpeg' ? t.simulator.fps(stats.fps) : `${t.simulator.fps(stats.fps)} · ${formatRate(stats.kbps)}`) : t.simulator.live}
              </>
            ) : state.kind === 'ended' ? (
              t.simulator.disconnected
            ) : reconnecting ? (
              t.common.reconnecting
            ) : waiting ? (
              pc ? (wait === 'firewall' ? t.pc.screen.blocked : t.pc.screen.waiting) : wait === 'device' ? t.simulator.waitingCable : t.simulator.waitingAllow
            ) : (
              t.common.connecting
            )}
          </span>
        </Tooltip>
        <span className="visually-hidden" role="status">
          {announce}
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
      <EmptyState compact icon="mac" title={t.simulator.noMac} actions={<Button onClick={() => navigate({ name: 'onboarding' })}>{t.common.pairMac}</Button>}>
        {t.simulator.noMacBody}
      </EmptyState>
    );
  }
  if (!target) {
    return (
      <EmptyState compact icon="phone" title={t.simulator.noSimulator}>
        {t.simulator.noSimulatorBody}
      </EmptyState>
    );
  }
  if (connected === 'offline') {
    return (
      <EmptyState compact icon="plugDisconnected" title={t.simulator.cantReach(mac.label)}>
        {tidy(mac.error) ?? t.simulator.cantReachBody}
      </EmptyState>
    );
  }
  // A real iPhone: its screen comes over the cable to the Mac, and on to here.
  if (target.kind === 'device') return <Screen key={`${mac.name}-${target.udid}`} mac={mac.name} macLabel={mac.label} target={target} frame={frame} />;
  if (target.state !== 'Booted') {
    const boot = async () => {
      setBooting(true);
      try {
        await call('simulators.boot', { mac: mac.name, udid: target.udid });
        onBooted?.();
      } catch (err) {
        toast({ tone: 'critical', title: t.simulator.startFailed(target.name), body: tidy(errorInfo(err).hint ?? errorInfo(err).message) });
      } finally {
        setBooting(false);
      }
    };
    return (
      <EmptyState
        compact
        icon="power"
        title={booting || target.state === 'Booting' ? t.simulator.starting(target.name) : t.simulator.off(target.name)}
        actions={
          <Button variant="accent" icon="power" busy={booting || target.state === 'Booting'} onClick={() => void boot()}>
            {t.simulator.start}
          </Button>
        }
      >
        {t.simulator.startBody}
      </EmptyState>
    );
  }
  return <Screen key={`${mac.name}-${target.udid}`} mac={mac.name} macLabel={mac.label} target={target} frame={frame} />;
}
