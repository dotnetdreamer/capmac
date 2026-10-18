import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swipeMoves, WdaControl, WdaStartError } from '../../packages/core/src/engine/iphone/wda.js';
import { mountWslDeveloperImage, OVER_WIFI } from '../../packages/core/src/engine/wsl/device.js';

// The runner helper as WdaControl sees it: a process that prints lines and exits when told.
// `later`: lines it prints a moment after it started (once WebDriverAgent is in use).
interface Runner { stdout: string[]; later?: string[]; stderr?: string; exit?: number }
const boundary = vi.hoisted(() => ({ spawn: vi.fn(), runner: null as null | Runner, children: [] as Array<EventEmitter & { stdin: PassThrough; exitCode: number | null }> }));
vi.mock('node:child_process', () => ({ spawn: boundary.spawn }));
vi.mock('../../packages/core/src/engine/wsl/device.js', async (original) => ({
  ...await original<typeof import('../../packages/core/src/engine/wsl/device.js')>(),
  mountWslDeveloperImage: vi.fn(async () => undefined),
  deviceHelperCommand: vi.fn(async () => ({ executable: 'python.exe', prefix: ['-I'], env: {} })),
}));

const bundleId = 'dev.capmac.wda.9xczl2pprh.xctrunner';
const proMax = { udid: '00008120-00012840269B401E', name: 'IK 14 Pro Max', productType: 'iPhone15,3', connection: 'network' as const };
const iphone8 = { udid: '808ccae4399545073522715663f015d9727366c4', name: 'iPhone', productVersion: '16.7.11', connection: 'usb' as const };

let server: http.Server | null = null;
let screenServer: http.Server | null = null;

/** WebDriverAgent on the iPhone, behind the runner's port: a session and a 430×932-point screen. */
async function fakeWda(): Promise<number> {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/session') res.end(JSON.stringify({ value: { sessionId: 'S1' }, sessionId: 'S1' }));
      else if (req.url?.endsWith('/window/size')) res.end(JSON.stringify({ value: { width: 430, height: 932 } }));
      else res.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}

beforeEach(() => {
  boundary.children = [];
  vi.mocked(mountWslDeveloperImage).mockClear();
  boundary.spawn.mockReset();
  boundary.spawn.mockImplementation(() => {
    const runner = boundary.runner!;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn() });
    // Closing stdin stops it, as the real runner does.
    child.stdin.on('finish', () => {
      child.exitCode = 0;
      child.emit('exit', 0);
    });
    queueMicrotask(() => {
      if (runner.stderr) child.stderr.write(runner.stderr);
      for (const line of runner.stdout) child.stdout.write(`${line}\n`);
      if (runner.later) setTimeout(() => runner.later!.forEach((line) => child.stdout.write(`${line}\n`)), 50);
      if (runner.exit !== undefined) setTimeout(() => {
        child.exitCode = runner.exit!;
        child.emit('exit', runner.exit);
      }, 5);
    });
    boundary.children.push(child);
    return child;
  });
});

afterEach(() => {
  server?.close();
  server = null;
  screenServer?.closeAllConnections();
  screenServer?.close();
  screenServer = null;
});

describe('starting WebDriverAgent', () => {
  it('reaches a Wi-Fi iPhone through the tunnel, and says when it waits for one that is away', async () => {
    const port = await fakeWda();
    boundary.runner = { stdout: ['CAPMAC_LOCKED', `CAPMAC_PORT ${port}`] };
    const onLocked = vi.fn();
    // Over Wi-Fi the iOS version doesn't matter: the way in is always the tunnel.
    const wda = new WdaControl(proMax, bundleId, { onLocked });
    await wda.start();
    expect(wda.ready).toBe(true);
    expect(onLocked).toHaveBeenCalledTimes(1);
    const [file, args] = boundary.spawn.mock.calls[0] as [string, string[]];
    expect(file).toBe('python.exe');
    expect(args.slice(0, 2)).toEqual(['-I', '-c']);
    // The Wi-Fi tunnel's provider comes first, for the runner to use.
    expect(args[2]!.startsWith(OVER_WIFI)).toBe(true);
    expect(args[2]).toContain('USE_IP');
    expect(args.slice(3)).toEqual([proMax.udid, '', bundleId, '8100', 'wifi', '9100']);
    // The runner mounts the developer services through its own tunnel: the iPhone is found once.
    expect(mountWslDeveloperImage).not.toHaveBeenCalled();
    await wda.stop();
  });

  it('starts on the cable with the iPhone’s iOS version', async () => {
    const port = await fakeWda();
    boundary.runner = { stdout: [`CAPMAC_PORT ${port}`] };
    const wda = new WdaControl(iphone8, bundleId);
    await wda.start();
    expect((boundary.spawn.mock.calls[0] as [string, string[]])[1].slice(3)).toEqual([iphone8.udid, '16.7.11', bundleId, '8100', 'usb', '9100']);
    expect(mountWslDeveloperImage).toHaveBeenCalledTimes(1);
    // An older runner forwards no screen stream.
    expect(wda.canWatchScreen).toBe(false);
    await wda.stop();
  });

  it('streams the screen through the runner’s second port, each picture once', async () => {
    const port = await fakeWda();
    const jpeg = (fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200, fill), Buffer.from([0xff, 0xd9])]);
    const part = (image: Buffer) => Buffer.concat([Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`), image, Buffer.from('\r\n\r\n')]);
    // WebDriverAgent's MJPEG server: the same picture three times (the screen stood still), then another.
    screenServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
      res.write(part(jpeg(1)));
      res.write(part(jpeg(1)));
      res.write(Buffer.concat([part(jpeg(1)), part(jpeg(2))]));
      setTimeout(() => res.end(), 20);
    });
    await new Promise<void>((resolve) => screenServer!.listen(0, '127.0.0.1', resolve));
    boundary.runner = { stdout: [`CAPMAC_PORT ${port} ${(screenServer.address() as AddressInfo).port}`] };
    const wda = new WdaControl(iphone8, bundleId);
    await wda.start();
    expect(wda.canWatchScreen).toBe(true);
    expect(wda.screenSize).toEqual({ width: 430, height: 932 });
    const pictures: number[] = [];
    const ended = await new Promise<string>((resolve) => wda.watchScreen((image) => pictures.push(image[2]!), resolve));
    expect(pictures).toEqual([1, 2]);
    expect(ended).toBe('the screen stream ended');
    // Stopped on purpose: no end is reported.
    const onEnd = vi.fn();
    const stop = wda.watchScreen(() => undefined, onEnd);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onEnd).not.toHaveBeenCalled();
    await wda.stop();
  });

  it('lets a runner that ended by itself exit (it waits for its stdin to close)', async () => {
    const port = await fakeWda();
    // The iPhone was unplugged: the runner says why it ended.
    boundary.runner = { stdout: [`CAPMAC_PORT ${port}`], later: ['CAPMAC_ENDED Runner DTX connection closed'] };
    const onEnded = vi.fn();
    const wda = new WdaControl(iphone8, bundleId, { onEnded });
    await wda.start();
    await vi.waitFor(() => expect(onEnded).toHaveBeenCalledWith('Runner DTX connection closed'));
    expect(boundary.children[0]!.exitCode).toBe(0);
    await wda.stop();
  });

  it('says it is no use trying again when WebDriverAgent is gone from the iPhone', async () => {
    boundary.runner = { stdout: [], stderr: 'pymobiledevice3.exceptions.AppNotInstalledError: No app with bundle id dev.capmac.wda.9xczl2pprh.xctrunner found\n', exit: 1 };
    const failed = await new WdaControl(proMax, bundleId).start().then(() => null, (error: unknown) => error);
    expect(failed).toBeInstanceOf(WdaStartError);
    expect(failed).toMatchObject({ retry: false, hint: 'WebDriverAgent is not on the iPhone any more. Turn touch on again to put it back.' });
  });

  it('asks to keep a Wi-Fi iPhone unlocked on the Wi-Fi, and tries again later', async () => {
    boundary.runner = { stdout: ['CAPMAC_LOCKED'], stderr: 'SystemExit: The iPhone did not come back on this Wi-Fi network. Unlock it, or plug it in.\n', exit: 1 };
    const failed = await new WdaControl(proMax, bundleId).start().then(() => null, (error: unknown) => error);
    expect(failed).toMatchObject({ retry: true, hint: 'Unlock the iPhone and keep it on this Wi-Fi, then try again.' });
  });

  it('asks for the passcode when XCTest can’t take over the screen, and not for trust because of the tunnel’s pair verification', async () => {
    // As XCTest says it when the passcode prompt on the iPhone went unanswered.
    boundary.runner = { stdout: [], stderr: 'SystemExit: XCTest could not take over the screen: Timed out while enabling automation mode.\n', exit: 1 };
    const automation = await new WdaControl(proMax, bundleId).start().then(() => null, (error: unknown) => error);
    expect(automation).toMatchObject({
      retry: true,
      hint: 'Your iPhone asks for its passcode before touch can start: enter it on the iPhone. If it doesn’t ask, open Settings, tap Developer, then turn on Enable UI Automation.',
    });
    boundary.runner = { stdout: [], stderr: 'WARNING failed after pair verify: Connection reset by peer\n', exit: 1 };
    const dropped = await new WdaControl(proMax, bundleId).start().then(() => null, (error: unknown) => error);
    expect(dropped).toMatchObject({ retry: true, hint: 'Unlock the iPhone and keep it on this Wi-Fi, then try again.' });
  });
});

describe('a swipe for WebDriverAgent', () => {
  const iphone8Points = { width: 375, height: 667 };
  type Move = { type: string; duration?: number; x?: number; y?: number };

  it('goes along a few points, so iOS’s edge gestures see a finger move', () => {
    const moves = swipeMoves(0.5, 0.5, 0.1, 0.5, 0.2, iphone8Points) as Move[];
    expect(moves.map((m) => m.type)).toEqual(['pointerMove', 'pointerDown', 'pointerMove', 'pointerMove', 'pointerUp']);
    expect(moves.filter((m) => m.type === 'pointerMove').map((m) => m.x)).toEqual([188, 113, 38]);
    expect(moves.filter((m) => m.type === 'pointerMove').map((m) => m.duration)).toEqual([0, 100, 100]);
    // A slow drag gets more points, up to six.
    expect((swipeMoves(0.5, 0.5, 0.1, 0.5, 1.4, iphone8Points) as Move[]).filter((m) => m.type === 'pointerMove')).toHaveLength(7);
  });

  it('rests where the pointer rested: a long press before a drag, a hold before it lifts', () => {
    const moves = swipeMoves(0.5, 0.9, 0.5, 0.5, 0.2, iphone8Points, { pressMs: 600, holdMs: 800 }) as Move[];
    expect(moves.map((m) => (m.type === 'pause' ? `pause ${m.duration}` : m.type))).toEqual(['pointerMove', 'pointerDown', 'pause 600', 'pointerMove', 'pointerMove', 'pause 800', 'pointerUp']);
  });

  it('starts on the edge it moves away from, as a finger coming off the bezel', () => {
    // Up from just above the bottom edge (Control Center on an iPhone 8): from the edge itself.
    expect(swipeMoves(0.5, 0.992, 0.5, 0.4, 0.3, iphone8Points)[0]).toEqual({ type: 'pointerMove', duration: 0, x: 188, y: 667 });
    expect(swipeMoves(0.5, 0.975, 0.5, 0.4, 0.3, iphone8Points)[0]).toMatchObject({ y: 667 });
    // In from the left edge (going back a page).
    expect(swipeMoves(0.01, 0.5, 0.8, 0.5, 0.3, iphone8Points)[0]).toMatchObject({ x: 0, y: 334 });
    // Toward the edge, or from further in: where the pointer went down.
    expect(swipeMoves(0.5, 0.992, 0.5, 0.999, 0.3, iphone8Points)[0]).toMatchObject({ y: 662 });
    expect(swipeMoves(0.5, 0.95, 0.5, 0.4, 0.3, iphone8Points)[0]).toMatchObject({ y: 634 });
  });
});
