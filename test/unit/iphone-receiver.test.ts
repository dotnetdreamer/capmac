import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { firewallCheckScript, MirrorReceiver, parseReceiverLine, receiverArgs, type ReceiverListener, type ReceiverState } from '../../packages/core/src/engine/iphone/receiver.js';
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
});

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
