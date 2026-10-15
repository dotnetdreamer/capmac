import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { CSS_CURSORS, macModifiers } from '@capmac/core/shared/electron';
import type { AppWindowInfo, ErrorInfo, InputEvent, MacSummary, ScreenInfo } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { workspaceBus, type WorkspaceAction } from '../../app/commands';
import { reloadApp, startSession } from '../../state/actions';
import { toast } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { useMacs } from '../../state/macs';
import { useProject } from '../../state/projects';
import { isActive, isBusy, MAC_TARGET_ID, type RunState } from '../../state/runs';
import { claimScreenPort } from '../../lib/screen-ports';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState, Spinner, StatusDot } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Menu, Popover, usePopover } from '../../ui/Popover';
import { Rich } from '../../ui/Rich';
import { Tooltip } from '../../ui/Tooltip';

type StreamState = { kind: 'connecting' } | { kind: 'streaming' } | { kind: 'reconnecting' } | { kind: 'ended'; error?: ErrorInfo };

/** The macOS title bar CapMac draws above the page (the app draws only its page). */
const TITLE_BAR = 28;
const BUTTONS = ['left', 'middle', 'right'] as const;

const formatRate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);

/** The frames' longest side for a canvas this big: a little above it (crisp text), in steps, within limits. */
function frameSizeFor(canvasPixels: number): number {
  return Math.max(640, Math.min(2400, Math.ceil(canvasPixels / 64) * 64));
}

/** A full-size PNG of the app's window (`appWindow`: the one showing). */
async function screenshot(mac: string, path: string, appWindow: number | null, action: 'save' | 'copy') {
  try {
    const shot = await call('screen.screenshot', { mac, udid: MAC_TARGET_ID, projectPath: path, window: appWindow ?? undefined });
    if (action === 'copy') {
      await window.capmac.invoke('app:copy-image', { data: shot.png });
      toast({ tone: 'success', title: t.simulator.shotCopied, body: shot.width ? `${shot.width} × ${shot.height}` : undefined });
    } else {
      const name = t.appWindow.shotName(new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
      const saved = await window.capmac.invoke('app:save-image', { data: shot.png, name });
      if (saved) toast({ tone: 'success', title: t.simulator.shotSaved, body: saved, action: { label: t.common.showInFolder, run: () => void window.capmac.invoke('app:show-in-folder', { path: saved }) } });
    }
  } catch (err) {
    toast({ tone: 'critical', title: t.simulator.shotFailed, body: tidy(errorInfo(err).message) });
  }
}

/** The window's three buttons. They act on the window on the Mac. */
function TrafficLights({ onAction, overlay }: { onAction: (action: 'close' | 'minimize' | 'zoom') => void; overlay?: boolean }) {
  return (
    <span className={`appwin__lights${overlay ? ' appwin__lights--overlay' : ''}`}>
      <button type="button" className="appwin__light appwin__light--close" aria-label={t.appWindow.close} title={t.appWindow.close} onClick={() => onAction('close')} />
      <button type="button" className="appwin__light appwin__light--min" aria-label={t.appWindow.minimize} title={t.appWindow.minimize} onClick={() => onAction('minimize')} />
      <button type="button" className="appwin__light appwin__light--zoom" aria-label={t.appWindow.zoom} title={t.appWindow.zoom} onClick={() => onAction('zoom')} />
    </span>
  );
}

/** The app's window, live: a canvas fed by the screen worker, with the Mac's pointer and keyboard. */
function AppScreen({ mac, path, frame, live, label, appName }: { mac: string; path: string; frame: boolean; live: boolean; label: string; appName: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [state, setState] = useState<StreamState>({ kind: 'connecting' });
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [windows, setWindows] = useState<AppWindowInfo[]>([]);
  const [watched, setWatched] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [cursor, setCursor] = useState('default');
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [stats, setStats] = useState<{ fps: number; kbps: number } | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [typed, setTyped] = useState('');
  const typePopover = usePopover();
  const shotMenu = usePopover();
  const windowMenu = usePopover();
  const canvasPixels = useRef(0);

  // Start the stream: worker + canvas + MessagePort from the engine.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'sim__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    let disposed = false;
    let streamId: string | null = null;
    const worker = new Worker(new URL('../../workers/screen.worker.ts', import.meta.url), { type: 'module', name: 'capmac app window' });
    workerRef.current = worker;
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'canvas', canvas: offscreen }, [offscreen]);
    worker.onmessage = (e) => {
      const m = e.data;
      switch (m.type) {
        case 'frame-size':
          setFrameSize({ width: m.width, height: m.height });
          break;
        case 'first-frame':
          setHasFrame(true);
          break;
        case 'stats':
          setStats({ fps: m.fps, kbps: m.kbps });
          break;
        case 'info':
          setInfo(m.info);
          break;
        case 'windows':
          setWindows(m.windows);
          setWatched(m.watched);
          break;
        case 'waiting':
          // While the app restarts, its last picture stays, dimmed.
          setWaiting(m.waiting);
          break;
        case 'cursor':
          setCursor(CSS_CURSORS[m.cursor] ?? 'default');
          break;
        case 'clipboard':
          // Copied in the app: it is on this PC's clipboard too.
          void navigator.clipboard.writeText(m.text).then(() => toast({ tone: 'success', title: t.appWindow.copied }), () => undefined);
          break;
        case 'state':
          setState(m.state === 'ended' ? { kind: 'ended', error: m.error } : { kind: m.state });
          break;
      }
    };
    setState({ kind: 'connecting' });
    setHasFrame(false);
    (async () => {
      try {
        const maxSize = canvasPixels.current ? frameSizeFor(canvasPixels.current) : undefined;
        const opened = await window.capmac.invoke('app:screen-open', { mac, udid: MAC_TARGET_ID, maxSize, projectPath: path });
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
  }, [mac, path, epoch]);

  // Fit the window into the pane.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
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
  const current = windows.find((w) => w.id === watched) ?? null;
  // The page's shape; the title bar is CapMac's, above it (none when the app draws under its own).
  const aspect = frameSize ? frameSize.width / frameSize.height : current ? current.width / Math.max(1, current.height) : 1.45;
  const bar = frame && (current?.titleBar ?? 28) > 0 ? TITLE_BAR : 0;
  const maxW = Math.max(0, box.width - 24);
  const maxH = Math.max(0, box.height - 24 - bar);
  const screenW = Math.floor(Math.min(maxW, maxH * aspect));
  const screenH = Math.floor(screenW / aspect);
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    canvasPixels.current = Math.round(Math.max(screenW, screenH) * dpr);
    workerRef.current?.postMessage({ type: 'size', width: Math.round(screenW * dpr), height: Math.round(screenH * dpr) });
  }, [screenW, screenH, epoch]);
  // Ask for frames about as sharp as the canvas shows them (settled sizes only).
  const sentSize = useRef(0);
  useEffect(() => {
    if (!screenW) return;
    const timer = window.setTimeout(() => {
      const want = frameSizeFor(canvasPixels.current);
      if (sentSize.current && Math.abs(want - sentSize.current) / sentSize.current < 0.12) return;
      sentSize.current = want;
      workerRef.current?.postMessage({ type: 'video-size', maxSize: want });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [screenW, screenH]);

  // ─── Input: as on a Mac ──────────────────────────────────────────────────
  const canInput = Boolean(info?.input) && !waiting && state.kind === 'streaming';
  const send = useCallback((event: InputEvent) => workerRef.current?.postMessage({ type: 'input', event }), []);
  const point = (e: { clientX: number; clientY: number }) => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const moveFrame = useRef(0);
  const lastMove = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null);
  const pressed = useRef(0);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!canInput) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    pressed.current |= 1 << e.button;
    const p = point(e);
    send({ kind: 'mouse', phase: 'down', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left', clicks: Math.min(3, Math.max(1, e.detail || 1)), modifiers: macModifiers(e) || undefined });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!canInput) return;
    lastMove.current = { ...point(e), buttons: e.buttons, modifiers: macModifiers(e) };
    // At most one move per display frame.
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const m = lastMove.current;
      if (m) send({ kind: 'mouse', phase: 'move', x: m.x, y: m.y, buttons: m.buttons || undefined, modifiers: m.modifiers || undefined });
    });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!canInput || !(pressed.current & (1 << e.button))) return;
    pressed.current &= ~(1 << e.button);
    const p = point(e);
    send({ kind: 'mouse', phase: 'up', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left', clicks: Math.min(3, Math.max(1, e.detail || 1)), modifiers: macModifiers(e) || undefined });
  };
  const releaseAll = useCallback(() => {
    // No button stays down on the Mac when the window loses focus or the stream stops.
    const m = lastMove.current;
    for (const [bit, button] of [[1, 'left'], [2, 'middle'], [4, 'right']] as const) {
      if (pressed.current & bit) send({ kind: 'mouse', phase: 'up', x: m?.x ?? 0.5, y: m?.y ?? 0.5, button, clicks: 1 });
    }
    pressed.current = 0;
  }, [send]);
  useEffect(() => {
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('blur', releaseAll);
      releaseAll();
    };
  }, [releaseAll]);
  const onPointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (!canInput || e.buttons) return;
    const p = point(e);
    send({ kind: 'mouse', phase: 'leave', x: p.x, y: p.y });
  };

  const wheel = useRef({ dx: 0, dy: 0, x: 0.5, y: 0.5, modifiers: 0, frame: 0 });
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const p = point(e);
    const w = wheel.current;
    const r = hostRef.current!.getBoundingClientRect();
    // In the app's points: what the wheel moved here, scaled to the window's real size.
    const perPixel = current ? current.width / r.width : 1;
    const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? r.height : 1;
    w.dx += e.deltaX * lines * perPixel;
    w.dy += e.deltaY * lines * perPixel;
    w.x = p.x;
    w.y = p.y;
    w.modifiers = macModifiers(e);
    if (w.frame) return;
    w.frame = requestAnimationFrame(() => {
      w.frame = 0;
      if (Math.abs(w.dx) + Math.abs(w.dy) < 0.5) return;
      send({ kind: 'wheel', x: w.x, y: w.y, dx: Math.max(-2000, Math.min(2000, w.dx)), dy: Math.max(-2000, Math.min(2000, w.dy)), modifiers: w.modifiers || undefined });
      w.dx = 0;
      w.dy = 0;
    });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>, phase: 'down' | 'up') => {
    if (!canInput || e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return;
    // Ctrl+V arrives as a paste event, with this PC's clipboard.
    if (e.ctrlKey && !e.altKey && e.code === 'KeyV') return;
    // Ctrl+Tab and friends stay with CapMac Studio.
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'Tab')) return;
    e.preventDefault();
    send({ kind: 'keyboard', phase, key: e.key.slice(0, 32), code: e.code.slice(0, 32), modifiers: macModifiers(e) || undefined, repeat: e.repeat || undefined });
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!canInput) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    send({ kind: 'text', text: text.slice(0, 20_000), via: 'paste' });
  };

  const windowAction = (action: 'close' | 'minimize' | 'zoom') => {
    if (watched !== null) workerRef.current?.postMessage({ type: 'window-action', window: watched, action });
  };
  const pickWindow = (id: number | null) => workerRef.current?.postMessage({ type: 'window', window: id });

  // Workspace command: Ctrl+Shift+S
  useEffect(() => {
    const onAction = (e: Event) => {
      if ((e as CustomEvent<WorkspaceAction>).detail === 'screenshot') void screenshot(mac, path, watched, 'save');
    };
    workspaceBus.addEventListener('action', onAction);
    return () => workspaceBus.removeEventListener('action', onAction);
  }, [mac, path, watched]);

  const ended = state.kind === 'ended';
  const reconnecting = state.kind === 'reconnecting';
  const noWindow = !waiting && state.kind === 'streaming' && windows.length === 0;
  const title = current?.title || (current ? t.appWindow.untitled(current.id) : appName);
  const radius = frame ? 10 : 4;
  return (
    <div className="sim appwin">
      <div ref={stageRef} className="sim__stage">
        <div className={`appwin__window${frame ? ' has-frame' : ''}${current?.dark ? ' is-dark' : ''}`} style={{ width: screenW, borderRadius: radius }}>
          {frame && bar > 0 && (
            <div className="appwin__titlebar" style={{ height: bar }}>
              <TrafficLights onAction={windowAction} />
              <span className="appwin__title truncate">{title}</span>
            </div>
          )}
          <div className="appwin__screen" style={{ width: screenW, height: screenH, borderRadius: frame && bar > 0 ? `0 0 ${radius}px ${radius}px` : radius }}>
            <div
              ref={hostRef}
              className={`sim__host appwin__host${canInput ? ' can-input' : ''}`}
              style={{ width: screenW, height: screenH, cursor: canInput ? cursor : undefined }}
              tabIndex={0}
              role="img"
              aria-label={t.appWindow.screen(title, t.appWindow.help)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={releaseAll}
              onPointerLeave={onPointerLeave}
              onContextMenu={(e) => e.preventDefault()}
              onWheel={onWheel}
              onKeyDown={(e) => onKey(e, 'down')}
              onKeyUp={(e) => onKey(e, 'up')}
              onCompositionEnd={(e) => e.data && send({ kind: 'text', text: e.data })}
              onPaste={onPaste}
              onBlur={releaseAll}
            />
            {frame && bar === 0 && current && <TrafficLights onAction={windowAction} overlay />}
            {(!hasFrame || ended || reconnecting || waiting || noWindow) && (
              <div className={`sim__overlay${(reconnecting || waiting) && hasFrame ? ' is-dimmed' : ''}`}>
                {ended ? (
                  <>
                    <Icon name="plugDisconnected" size={20} />
                    <span>{tidy(state.error?.message) ?? t.appWindow.stopped}</span>
                    {state.error?.hint && <span className="faint">{tidy(state.error.hint)}</span>}
                    <Button size="sm" onClick={() => setEpoch((n) => n + 1)}>
                      {t.appWindow.reconnect}
                    </Button>
                  </>
                ) : noWindow ? (
                  <>
                    <Icon name="desktop" size={20} />
                    <span>{t.appWindow.noWindow}</span>
                    <span className="faint">{t.appWindow.noWindowBody}</span>
                  </>
                ) : (
                  <>
                    <Spinner size={20} />
                    <span>{reconnecting ? t.appWindow.reconnectingMac : state.kind === 'connecting' ? t.appWindow.connectingTo(label) : t.appWindow.waiting}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="sim__toolbar" role="toolbar" aria-label={t.appWindow.controls}>
        {windows.length > 1 && (
          <>
            <button type="button" className="btn btn--sm btn--subtle appwin__picker" aria-haspopup="menu" aria-label={t.appWindow.chooseWindow} {...windowMenu.triggerProps}>
              <Icon name="desktop" size={14} />
              <span className="truncate">{title}</span>
              <Icon name="chevronDown" size={12} />
            </button>
            <Menu
              state={windowMenu}
              label={t.appWindow.chooseWindow}
              placement="top-start"
              width={260}
              items={[
                ...windows.map((w) => ({ id: `w${w.id}`, label: w.title || t.appWindow.untitled(w.id), hint: w.minimized ? t.appWindow.minimizedOnMac : undefined, checked: w.id === watched, onSelect: () => pickWindow(w.id) })),
                { id: 'follow', label: t.appWindow.followActive, separatorBefore: true, onSelect: () => pickWindow(null) },
              ]}
            />
          </>
        )}
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t.appWindow.typeText} disabled={!canInput} {...typePopover.triggerProps}>
          <Icon name="keyboard" size={16} />
        </button>
        <Popover state={typePopover} placement="top-start" label={t.appWindow.typeTitle}>
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
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.appWindow.typePlaceholder} aria-label={t.simulator.textToType} />
            </div>
            <Button type="submit" size="sm" variant="accent" icon="send">
              {t.simulator.send}
            </Button>
          </form>
        </Popover>
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t.simulator.screenshot} aria-haspopup="menu" disabled={!hasFrame} {...shotMenu.triggerProps}>
          <Icon name="camera" size={16} />
        </button>
        <Menu
          state={shotMenu}
          label={t.simulator.screenshot}
          placement="top-start"
          items={[
            { id: 'save', label: t.simulator.saveShot, icon: 'download', shortcut: 'Ctrl+Shift+S', onSelect: () => void screenshot(mac, path, watched, 'save') },
            { id: 'copy', label: t.simulator.copyShot, icon: 'copy', onSelect: () => void screenshot(mac, path, watched, 'copy') },
          ]}
        />
        {live && <IconButton icon="refresh" size="sm" label={t.toolbar.reloadApp} disabled={!canInput} onClick={() => void reloadApp(path)} />}
        <span className="sim__spacer" />
        {current?.minimized && <span className="faint appwin__note">{t.appWindow.minimizedOnMac}</span>}
        <Tooltip content={stats && stats.fps > 0 ? t.appWindow.framesTip(stats.fps, formatRate(stats.kbps)) : t.appWindow.still} placement="top">
          <span className="sim__stats tabular" tabIndex={0} aria-live="off">
            {state.kind === 'streaming' && hasFrame && !waiting ? (
              <>
                <StatusDot tone="live" />
                {stats && stats.fps > 0 ? `${t.simulator.fps(stats.fps)} · ${formatRate(stats.kbps)}` : t.simulator.live}
              </>
            ) : ended ? (
              t.simulator.disconnected
            ) : reconnecting ? (
              t.common.reconnecting
            ) : waiting && state.kind === 'streaming' ? (
              t.appWindow.waiting
            ) : (
              t.common.connecting
            )}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

/** The Electron app's window on the Mac's desktop: shown while it runs, with Run and Live to start it. */
export function AppWindowPane({ mac, path, run, frame }: { mac: MacSummary | null; path: string; run: RunState | undefined; frame: boolean }) {
  const connected = useMacs((s) => (mac ? s.macs.find((m) => m.name === mac.name)?.state : undefined));
  const appName = useProject(path).summary?.appName ?? '';
  if (!mac) {
    return (
      <EmptyState compact icon="mac" title={t.simulator.noMac}>
        {t.targets.macHint}
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
  const active = isActive(run) && run?.onMac;
  if (!active) {
    const busy = isBusy(run);
    return (
      <EmptyState
        compact
        icon="desktop"
        title={busy ? t.appWindow.starting : t.appWindow.notRunning}
        actions={
          busy ? undefined : (
            <>
              <Button variant="accent" icon="flash" iconFilled onClick={() => void startSession(path, 'live')}>
                {t.common.live}
              </Button>
              <Button icon="play" iconFilled onClick={() => void startSession(path, 'run')}>
                {t.common.run}
              </Button>
            </>
          )
        }
      >
        <Rich text={t.appWindow.notRunningBody} />
      </EmptyState>
    );
  }
  return <AppScreen key={`${mac.name}-${run!.sessionId}`} mac={mac.name} path={path} frame={frame} live={run!.mode === 'live'} label={mac.label} appName={appName} />;
}
