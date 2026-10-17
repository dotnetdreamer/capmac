/**
 * The picture of the iPhone mirroring to this PC, kept while Studio runs. The iPhone sends a
 * keyframe only when mirroring starts and none on request, so a decoder that stops can never pick
 * the picture up again (the engine keeps the stream since that keyframe only for its first minutes).
 * So one worker and one stream from the engine serve every This-PC Screen pane: a pane lends the
 * worker a fresh canvas while it is shown and gets the stream's status replayed when it opens. With
 * no pane, the worker keeps decoding with no canvas.
 *
 * The stream ends when the engine ends it (the receiver stopped, the engine restarted), when the
 * window closes or reloads (the engine then catches the next one up from its cache), and
 * MIRROR_KEEP_MS after the last pane closed: This PC's screen was left for good, so the receiver
 * stops and the iPhone stops mirroring.
 */
import type { ErrorInfo } from '../../shared/contract';

/** A message from the screen worker: its own (frame-size, first-frame, stats, …) or the engine's, passed on. */
export interface WorkerMessage {
  type: string;
  [key: string]: unknown;
}

/** The iPhone and app a pane is for. The picture is the same for all; touch is per iPhone and app. */
export interface MirrorTarget {
  udid: string;
  projectPath: string;
}

/** The screen worker, as the owner uses it. */
export interface MirrorWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface MirrorDeps {
  createWorker(): MirrorWorker;
  /** Opens the engine's stream of the This-PC iPhone: its id and this end of its port. */
  open(target: MirrorTarget): Promise<{ streamId: string; port: MessagePort }>;
  /** Closes the stream in the engine for good: the receiver stops when nothing else uses it. */
  stop(streamId: string): Promise<void>;
  /** A failed open, as the pane shows it. */
  errorInfo(error: unknown): ErrorInfo;
}

/** A pane's hold on the mirror, while it is shown. */
export interface MirrorPane {
  /** A message for the worker (input, the canvas size), dropped once another pane took over. */
  post(message: unknown): void;
  /** Asks the engine to check touch again (it was just turned on for this iPhone). */
  refreshTouch(): void;
  /** The engine's stream (for screenshots), once it is open. */
  readonly streamId: string | null;
  /** Gives the canvas back. The worker keeps decoding. */
  detach(): void;
}

/** What a pane needs to show the stream as it is now, in the order it is replayed. */
const STATUS = ['state', 'codec', 'info', 'mirror-client', 'device-wait', 'frame-size', 'first-frame', 'stats'] as const;
type StatusType = (typeof STATUS)[number];
const isStatus = (type: string): type is StatusType => (STATUS as readonly string[]).includes(type);

/** How long the mirror is kept with no pane showing it (the receiver used to stop this long after the last screen closed). */
export const MIRROR_KEEP_MS = 10 * 60 * 1000;

const sameTarget = (a: MirrorTarget | null, b: MirrorTarget) => a?.udid === b.udid && a.projectPath === b.projectPath;

export class PhoneMirror {
  private worker: MirrorWorker | null = null;
  private streamId: string | null = null;
  private target: MirrorTarget | null = null;
  private readonly status = new Map<StatusType, WorkerMessage>();
  private pane: { onMessage(message: WorkerMessage): void } | null = null;
  private ended = false;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: MirrorDeps, private readonly keepMs = MIRROR_KEEP_MS) {}

  /**
   * Shows the mirror on this canvas (transferred to the worker) and sends this pane the stream's
   * messages, starting with its status now. Starts the stream on first use, and again after it
   * ended. The newest pane wins: one that was attached before gets nothing more.
   */
  attach(target: MirrorTarget, canvas: OffscreenCanvas, onMessage: (message: WorkerMessage) => void): MirrorPane {
    this.cancelKeep();
    if (this.ended) this.release();
    if (!this.worker) this.start(target);
    else if (!sameTarget(this.target, target)) {
      this.target = target;
      if (this.streamId) this.sendTarget();
    }
    const pane = { onMessage };
    this.pane = pane;
    // The worker draws its newest picture on the new canvas at once.
    this.worker!.postMessage({ type: 'canvas', canvas }, [canvas]);
    for (const type of STATUS) {
      const message = this.status.get(type);
      if (message) onMessage(message);
    }
    const shown = () => this.pane === pane;
    const owner = this;
    return {
      post: (message) => {
        if (shown()) this.worker?.postMessage(message);
      },
      refreshTouch: () => {
        if (shown() && this.streamId) this.sendTarget();
      },
      get streamId() {
        return shown() ? owner.streamId : null;
      },
      detach: () => {
        if (!shown()) return;
        this.pane = null;
        if (this.ended) {
          this.release();
          return;
        }
        this.worker?.postMessage({ type: 'canvas', canvas: null });
        this.keepTimer = setTimeout(() => this.release(), this.keepMs);
      },
    };
  }

  /** The engine stopped (it restarts by itself): its stream is gone. */
  lost(error: ErrorInfo): void {
    if (this.worker) this.onMessage(this.worker, { type: 'state', state: 'ended', error });
  }

  private start(target: MirrorTarget): void {
    const worker = this.deps.createWorker();
    this.worker = worker;
    this.target = target;
    this.ended = false;
    worker.onmessage = (event) => this.onMessage(worker, event.data as WorkerMessage);
    // The iPhone sends a keyframe only when mirroring starts: never skip frames to wait for one.
    worker.postMessage({ type: 'keyframes', onRequest: false });
    this.deps.open(target).then(
      ({ streamId, port }) => {
        if (this.worker !== worker) {
          port.close();
          void this.deps.stop(streamId).catch(() => undefined);
          return;
        }
        this.streamId = streamId;
        worker.postMessage({ type: 'port', port }, [port]);
        // A pane for another iPhone or app took over while the stream opened.
        if (!sameTarget(this.target, target)) this.sendTarget();
      },
      (error: unknown) => {
        if (this.worker === worker) this.onMessage(worker, { type: 'state', state: 'ended', error: this.deps.errorInfo(error) });
      },
    );
  }

  /** Touch for the iPhone and app shown now (the picture goes on as it is). */
  private sendTarget(): void {
    if (this.target) this.worker?.postMessage({ type: 'phone-target', udid: this.target.udid, projectPath: this.target.projectPath });
  }

  private onMessage(worker: MirrorWorker, received: WorkerMessage): void {
    if (worker !== this.worker) return;
    // Without keyframes on request, a broken picture comes back only when mirroring starts again.
    const message = received.type === 'decoder-error' ? { type: 'device-wait', wait: 'restart-mirroring' } : received;
    if (isStatus(message.type)) this.status.set(message.type, message);
    // The newest state counts: a stream that ended and went on (the engine restarted the receiver) lives.
    if (message.type === 'state') this.ended = message.state === 'ended';
    this.pane?.onMessage(message);
    if (this.ended && !this.pane) this.release();
  }

  private cancelKeep(): void {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
  }

  /** Lets the stream go: the engine closes it for good first (not a reloaded window), then the worker stops. */
  private release(): void {
    this.cancelKeep();
    const worker = this.worker;
    const streamId = this.streamId;
    this.worker = null;
    this.streamId = null;
    this.target = null;
    this.ended = false;
    this.status.clear();
    if (!worker) return;
    const stopped = streamId ? this.deps.stop(streamId).catch(() => undefined) : Promise.resolve();
    void stopped.finally(() => worker.terminate());
  }
}
