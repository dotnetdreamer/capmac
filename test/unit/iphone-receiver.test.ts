import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  firewallCheckScript,
  MirrorReceiver,
  parseReceiverLine,
  receiverArgs,
  receiverHome,
  receiverInstalled,
  RECEIVER_VERSION,
  setBundledReceiver,
  type ReceiverListener,
  type ReceiverState,
} from '../../packages/core/src/engine/iphone/receiver.js';
import { STREAM_CONFIG, STREAM_FRAME } from '../../packages/core/src/shared/stream.js';

// Lines as UxPlay 1.74 printed them while an iPhone 14 Pro Max mirrored to this PC.
const lines = {
  ready: 'register_dnssd: advertised AirPlay service with "Features" code = 0x527FFEE6',
  client: 'connection request from IK 14 Pro Max (iPhone15,3) with deviceID = CA:E5:70:45:CA:32',
  open: 'Open connections: 1',
  closed: 'Open connections: 0',
  streaming: 'Begin streaming to GStreamer video pipeline',
  missing: "Required gstreamer plugin 'libav' not found",
};

describe('the screen-mirroring receiver', () => {
  it('understands the UxPlay lines that matter', () => {
    expect(parseReceiverLine(lines.ready)).toEqual({ t: 'ready' });
    expect(parseReceiverLine(lines.client)).toEqual({ t: 'client', client: { name: 'IK 14 Pro Max', model: 'iPhone15,3', deviceId: 'CA:E5:70:45:CA:32' } });
    expect(parseReceiverLine(lines.closed)).toEqual({ t: 'connections', count: 0 });
    expect(parseReceiverLine(lines.streaming)).toEqual({ t: 'streaming' });
    expect(parseReceiverLine(lines.missing)).toEqual({ t: 'error', message: 'The screen receiver is missing its libav part.' });
    expect(parseReceiverLine('POST /feedback RTSP/1.0')).toBeNull();
    // A late heartbeat on a busy Wi-Fi is no error: mirroring goes on.
    expect(parseReceiverLine('*** ERROR: 3 seconds since last client feedback request (expected every two seconds); client may be offline')).toBeNull();
  });

  it('forwards video to a loopback port, decoding and playing nothing', () => {
    const args = receiverArgs('CapMac', 50123);
    expect(args).toEqual(expect.arrayContaining(['-n', 'CapMac', '-nh', '-as', '0', '-vp', 'identity', '-nohold']));
    expect(args[args.indexOf('-vrtp') + 1]).toBe('config-interval=1 ! udpsink host=127.0.0.1 port=50123 sync=false');
  });

  it.runIf(process.platform === 'win32')('asks Windows Firewall about the receiver without changing anything', () => {
    // A program with no rules: Windows asks the first time it listens, so there is nothing to say yet.
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', firewallCheckScript("C:\\No Such Folder\\it's not\\uxplay.exe")], { encoding: 'utf8' });
    expect(result.stdout.trim().split(/\r?\n/).pop()).toBe('none');
    expect(firewallCheckScript('C:\\x\\uxplay.exe')).not.toMatch(/Set-|New-|Remove-|Enable-|Disable-/);
  }, 60_000);

  it('catches a screen that opens later up from the last keyframe, and forgets a session that ended', () => {
    const receiver = new MirrorReceiver({ name: 'CapMac', home: 'C:\\nowhere' });
    const internals = receiver as unknown as { onLine(line: string): void; onPacket(packet: Buffer): void; state: ReceiverState };
    internals.state = 'waiting';
    internals.onLine(lines.client);
    internals.onLine(lines.open);
    for (const packet of rtpPackets()) internals.onPacket(packet);
    expect(receiver.state).toBe('mirroring');
    expect(receiver.client?.name).toBe('IK 14 Pro Max');

    // A screen opening now gets the config, then every frame since the keyframe.
    const late = listen();
    (receiver as unknown as { catchUpListener(l: ReceiverListener): void }).catchUpListener(late.listener);
    expect(late.states).toEqual(['mirroring']);
    expect(late.types).toEqual([STREAM_CONFIG, STREAM_FRAME, STREAM_FRAME, STREAM_FRAME, STREAM_FRAME]);
    expect(late.keys[1]).toBe(true);

    // The iPhone stops mirroring: nothing of that session is replayed.
    internals.onLine(lines.closed);
    expect(receiver.state).toBe('waiting');
    expect(receiver.client).toBeNull();
    const after = listen();
    (receiver as unknown as { catchUpListener(l: ReceiverListener): void }).catchUpListener(after.listener);
    expect(after.states).toEqual(['waiting']);
    expect(after.types).toEqual([]);
  });

  it('asks for mirroring to start again when a screen opens past the catch-up limit', () => {
    const receiver = new MirrorReceiver({ name: 'CapMac', home: 'C:\\nowhere', catchUpLimit: 1000 });
    const internals = receiver as unknown as { onLine(line: string): void; onPacket(packet: Buffer): void; state: ReceiverState; catchUpListener(l: ReceiverListener): void };
    internals.state = 'waiting';
    internals.onLine(lines.client);
    for (const packet of rtpPackets()) internals.onPacket(packet);
    const late = listen();
    internals.catchUpListener(late.listener);
    expect(late.states).toEqual(['catch-up']);
    expect(late.types).toEqual([]);
  });

  it('asks for mirroring to start again when an iPhone connected but sends no picture', async () => {
    vi.useFakeTimers();
    try {
      const receiver = new MirrorReceiver({ name: 'CapMac', home: 'C:\\nowhere' });
      const internals = receiver as unknown as { onLine(line: string): void; onPacket(packet: Buffer): void; state: ReceiverState };
      internals.state = 'waiting';
      const pane = listen();
      receiver.subscribe({ ...pane.listener, onLog: () => undefined });
      // An iPhone that mirrors as usual: its picture comes within a second.
      internals.onLine(lines.client);
      await vi.advanceTimersByTimeAsync(800);
      for (const packet of rtpPackets()) internals.onPacket(packet);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(receiver.state).toBe('mirroring');
      internals.onLine(lines.closed);

      // One that came back to a restarted receiver with its old session: connected, and nothing comes.
      internals.onLine(lines.client);
      internals.onLine(lines.open);
      await vi.advanceTimersByTimeAsync(4900);
      expect(receiver.state).toBe('waiting');
      await vi.advanceTimersByTimeAsync(100);
      expect(receiver.state).toBe('no-picture');
      expect(pane.states.at(-1)).toBe('no-picture');
      // Mirroring started again on the iPhone: the picture comes.
      for (const packet of rtpPackets()) internals.onPacket(packet);
      expect(receiver.state).toBe('mirroring');
      receiver.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at once when its last screen was closed for good, and keeps going a while for a reloaded window', () => {
    const receiver = new MirrorReceiver({ name: 'CapMac', home: 'C:\\nowhere' });
    const stop = vi.spyOn(receiver, 'stop');
    const quiet = () => ({ ...listen().listener, onLog: () => undefined });
    const first = receiver.subscribe(quiet());
    const second = receiver.subscribe(quiet());
    // Another screen still uses it.
    first({ now: true });
    expect(stop).not.toHaveBeenCalled();
    // A window that reloads: it waits for that window to come back.
    second();
    expect(stop).not.toHaveBeenCalled();
    const third = receiver.subscribe(quiet());
    third({ now: true });
    expect(stop).toHaveBeenCalledTimes(1);
    // A second unsubscribe changes nothing.
    third({ now: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('asks Windows Firewall again until it lets iPhones through, as when Windows asks about a new receiver', async () => {
    vi.useFakeTimers();
    try {
      // Windows adds blocking rules while it asks, and allows them once Allow is clicked.
      const verdicts = ['blocked', 'blocked', 'allowed'];
      const asked: string[] = [];
      const receiver = new MirrorReceiver({ name: 'CapMac', home: 'C:\\Studio\\resources\\mirror-receiver', firewallVerdict: async (exe) => (asked.push(exe), verdicts.shift() ?? 'allowed') });
      const firewall = running(receiver);
      firewall.ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(firewall.seen).toEqual([true]);
      expect(asked[0]).toBe(path.join('C:\\Studio\\resources\\mirror-receiver', 'bin', 'uxplay.exe'));
      await vi.advanceTimersByTimeAsync(3000);
      expect(firewall.seen).toEqual([true]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(firewall.seen).toEqual([true, false]);
      // Allowed: no more asking.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(asked).toHaveLength(3);
      receiver.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps asking a while when there is no rule yet, and believes an iPhone that gets through', async () => {
    vi.useFakeTimers();
    try {
      const verdicts = ['none', 'none', 'blocked'];
      let asked = 0;
      const receiver = new MirrorReceiver({ name: 'CapMac', home: 'C:\\nowhere', firewallVerdict: async () => (asked++, verdicts.shift() ?? 'none') });
      const firewall = running(receiver);
      firewall.ready();
      await vi.advanceTimersByTimeAsync(6000);
      expect(firewall.seen).toEqual([false, true]);
      (receiver as unknown as { onLine(line: string): void }).onLine(lines.client);
      expect(firewall.seen).toEqual([false, true, false]);
      // No rule for two minutes: Windows isn't asking, so it stops looking.
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      const settled = asked;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(asked).toBe(settled);
      receiver.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds the receiver version the engine looks for', () => {
    const script = readFileSync(path.join(__dirname, '../../packages/core/receiver/build.sh'), 'utf8');
    const commit = /^UXPLAY_COMMIT=([0-9a-f]{40})/m.exec(script)![1]!;
    const version = /^VERSION="([^"$]*)\$\{UXPLAY_COMMIT:0:7\}([^"]*)"/m.exec(script)!;
    expect(`${version[1]}${commit.slice(0, 7)}${version[2]}`).toBe(RECEIVER_VERSION);
  });
});

describe('where the screen receiver is', () => {
  let dir = '';
  afterEach(() => {
    setBundledReceiver(null);
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const bundle = (home: string) => {
    mkdirSync(path.join(home, 'bin'), { recursive: true });
    mkdirSync(path.join(home, 'lib', 'gstreamer-1.0'), { recursive: true });
    writeFileSync(path.join(home, 'bin', 'uxplay.exe'), '');
    writeFileSync(path.join(home, 'lib', 'gstreamer-1.0', 'libgstrtp.dll'), '');
    return home;
  };

  it('is CAPMAC_MIRROR_RECEIVER, else the one Studio ships, else the one set up on this PC', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-receiver-'));
    vi.stubEnv('LOCALAPPDATA', path.join(dir, 'local'));
    vi.stubEnv('CAPMAC_MIRROR_RECEIVER', '');
    const byHand = path.join(dir, 'local', 'CapMac', 'mirror-receiver', RECEIVER_VERSION);
    expect(receiverHome()).toBe(byHand);
    expect(receiverInstalled()).toBe(false);

    const shipped = bundle(path.join(dir, 'CapMac Studio', 'resources', 'mirror-receiver'));
    setBundledReceiver(shipped);
    expect(receiverHome()).toBe(shipped);
    expect(receiverInstalled()).toBe(true);
    // Studio's copy went missing: the one set up by hand still works.
    bundle(byHand);
    setBundledReceiver(path.join(dir, 'gone'));
    expect(receiverHome()).toBe(byHand);
    expect(receiverInstalled()).toBe(true);

    const override = path.join(dir, 'override');
    vi.stubEnv('CAPMAC_MIRROR_RECEIVER', override);
    expect(receiverHome()).toBe(override);
    expect(receiverInstalled()).toBe(false);
  });

  it.runIf(process.platform === 'win32')('says how to get a missing receiver back, for where it looks', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-receiver-'));
    vi.stubEnv('LOCALAPPDATA', path.join(dir, 'local'));
    vi.stubEnv('CAPMAC_MIRROR_RECEIVER', '');
    const hint = async () => {
      const error = await new MirrorReceiver({ name: 'CapMac' }).start().then(() => null, (e: unknown) => e as { message: string; hint?: string });
      expect(error?.message).toBe('The screen-mirroring receiver is not set up on this PC yet.');
      return error?.hint;
    };
    expect(await hint()).toMatch(/build\.sh/);
    setBundledReceiver(path.join(dir, 'CapMac Studio', 'resources', 'mirror-receiver'));
    expect(await hint()).toBe('Install CapMac Studio again to get it back.');
    vi.stubEnv('CAPMAC_MIRROR_RECEIVER', path.join(dir, 'override'));
    expect(await hint()).toMatch(/CAPMAC_MIRROR_RECEIVER/);
  });
});

/** A receiver whose UxPlay is running (a stand-in), with a screen that hears the firewall verdicts. */
function running(receiver: MirrorReceiver) {
  const internals = receiver as unknown as { onLine(line: string): void; child: unknown; state: ReceiverState };
  internals.child = { kill: () => undefined };
  internals.state = 'starting';
  const seen: boolean[] = [];
  receiver.subscribe({ ...listen().listener, onLog: () => undefined, onFirewall: (blocked) => seen.push(blocked) });
  return { seen, ready: () => internals.onLine(lines.ready) };
}

function listen() {
  const states: ReceiverState[] = [];
  const types: number[] = [];
  const keys: boolean[] = [];
  const listener: ReceiverListener = {
    onVideo: ({ header }) => {
      types.push(header.type);
      keys.push(header.key);
    },
    onState: (state) => states.push(state),
  };
  return { listener, states, types, keys };
}

/** The 270×586 fixture as RTP: each NAL whole (single-NAL packets), one picture per timestamp. */
function rtpPackets(): Buffer[] {
  const stream = readFileSync(path.join(__dirname, '../fixtures/h264/screen-270x586.h264'));
  const nals: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i + 3 <= stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      if (start >= 0) nals.push(trim(stream.subarray(start, i)));
      start = i + 3;
      i += 2;
    }
  }
  nals.push(stream.subarray(start));
  const packets: Buffer[] = [];
  let picture = -1;
  nals.forEach((nal, n) => {
    if ((nal[0]! & 0x1f) === 9) picture += 1;
    const last = n === nals.length - 1 || (nals[n + 1]![0]! & 0x1f) === 9;
    const packet = Buffer.alloc(12 + nal.length);
    packet[0] = 0x80;
    packet[1] = (last ? 0x80 : 0) | 96;
    packet.writeUInt16BE(n, 2);
    packet.writeUInt32BE(1000 + picture * 3000, 4);
    packet.writeUInt32BE(0xcafe, 8);
    packet.set(nal, 12);
    packets.push(packet);
  });
  return packets;
}

function trim(nal: Uint8Array): Uint8Array {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) end -= 1;
  return nal.subarray(0, end);
}
