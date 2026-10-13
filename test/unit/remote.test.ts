/**
 * Remote access, end to end on this PC: the real signaling server, a real
 * door and the PC's connector, over WebRTC (peer to peer on loopback) and
 * through the server's relay. A TCP echo server stands in for the Mac's sshd:
 * like sshd it speaks first (a greeting the moment it is connected), then
 * every byte that goes in must come back unchanged.
 */
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, mkdtempSync, promises as fs, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignalServer } from '../../services/signal/src/server.js';
import { bindingResponse, startStun } from '../../services/signal/src/stun.js';
import { Door } from '../../packages/core/src/door/door.js';
import { openRemote, type RemoteStream } from '../../packages/core/src/engine/remote/connect.js';
import { pcIdentity, resetPcIdentityCache } from '../../packages/core/src/engine/remote/identity.js';
import { toNdcIceServers } from '../../packages/core/src/remote/ice.js';
import { setNodeDataChannelDir } from '../../packages/core/src/remote/native.js';
import { descriptionText, helloText, sdpFingerprints, signalSocketUrl, signalUrlProblem } from '../../packages/core/src/shared/remote.js';
import type { DoorConfig, RemotePc } from '../../packages/core/src/shared/remote-door.js';
import { generateIdentity, signText, verifyText } from '../../packages/core/src/shared/remote-keys.js';

const ROOT = path.resolve(__dirname, '..', '..');

let server: SignalServer;
let signalUrl = '';
let echo: net.Server;
let echoPort = 0;
let work: string;
let door: Door | null = null;
let doorDir: string;
let previousConfigDir: string | undefined;
const streams: RemoteStream[] = [];

/** What the stand-in sshd sends the moment it is connected (sshd greets first). */
const GREETING = Buffer.from(`SSH-2.0-CapMacTest ${'x'.repeat(60_000)}
`);

function startEcho(): Promise<void> {
  echo = net.createServer((socket) => {
    socket.write(GREETING);
    socket.pipe(socket);
  });
  return new Promise((resolve) => echo.listen(0, '127.0.0.1', () => {
    echoPort = (echo.address() as net.AddressInfo).port;
    resolve();
  }));
}

function writeAllowed(pcs: RemotePc[]): void {
  const file = path.join(doorDir, 'allowed.json');
  writeFileSync(file, JSON.stringify(pcs));
  // The door re-reads the file when its mtime changes; make sure it does.
  const t = new Date(Date.now() + Math.floor(Math.random() * 100_000));
  utimesSync(file, t, t);
}

async function startDoor(allowedKeys: string[]): Promise<Door> {
  doorDir = mkdtempSync(path.join(work, 'door-'));
  const { identity } = generateIdentity();
  const config: DoorConfig = {
    version: 1,
    signalUrl,
    sshPort: echoPort,
    keepAwake: false,
    keyFile: path.join(doorDir, 'door_ed25519'),
    allowedFile: path.join(doorDir, 'allowed.json'),
    statusFile: path.join(doorDir, 'status.json'),
    logFile: path.join(doorDir, 'door.log'),
    runtimeDir: ROOT,
  };
  writeAllowed(allowedKeys.map((key) => ({ key, name: 'test-pc', addedAt: new Date().toISOString() })));
  const d = new Door(config, identity, { version: 'test', sshHost: '127.0.0.1', allowKeepAwake: false });
  d.start();
  // Online once the server welcomed it.
  for (let i = 0; i < 100 && d.status.state !== 'online'; i++) await new Promise((r) => setTimeout(r, 50));
  expect(d.status.state).toBe('online');
  return d;
}

/** Checks the greeting arrives whole, then sends `bytes` random bytes through the stream and checks they come back. */
async function roundTrip(sock: Duplex, bytes: number): Promise<void> {
  const data = randomBytes(bytes);
  const expected = Buffer.concat([GREETING, data]);
  const received: Buffer[] = [];
  let total = 0;
  const done = new Promise<void>((resolve, reject) => {
    sock.on('data', (chunk: Buffer) => {
      received.push(chunk);
      total += chunk.length;
      if (total >= expected.length) resolve();
    });
    sock.on('error', reject);
  });
  // Wait a moment first, as SSH would, so the greeting races the stream being set up.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let offset = 0; offset < data.length; offset += 50_000) sock.write(data.subarray(offset, offset + 50_000));
  await done;
  expect(Buffer.concat(received).equals(expected)).toBe(true);
}

beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'capmac-remote-'));
  previousConfigDir = process.env.CAPMAC_CONFIG_DIR;
  process.env.CAPMAC_CONFIG_DIR = path.join(work, 'pc');
  resetPcIdentityCache();
  setNodeDataChannelDir(ROOT);
  server = new SignalServer({ port: 0, host: '127.0.0.1', stunUrls: [], version: 'test' });
  const port = await server.start();
  signalUrl = `ws://127.0.0.1:${port}`;
  await startEcho();
});

afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await door?.stop();
  door = null;
});

afterAll(async () => {
  await server.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
  if (previousConfigDir === undefined) delete process.env.CAPMAC_CONFIG_DIR;
  else process.env.CAPMAC_CONFIG_DIR = previousConfigDir;
  resetPcIdentityCache();
  await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
});

describe('remote access, end to end', () => {
  it('connects peer to peer and carries bytes unchanged', async () => {
    const pc = await pcIdentity();
    door = await startDoor([pc.publicKey]);
    const stream = await openRemote({ label: 'Test Mac', macKey: door.macKey, signalUrl, relay: 'never' });
    streams.push(stream);
    expect(stream.route).toBe('direct');
    await roundTrip(stream.sock, 2 * 1024 * 1024);
    expect(door.sessionCount).toBe(1);
    expect(server.stats().macsOnline).toBe(1);
  });

  it('connects through the relay and carries bytes unchanged', async () => {
    const pc = await pcIdentity();
    door = await startDoor([pc.publicKey]);
    const stream = await openRemote({ label: 'Test Mac', macKey: door.macKey, signalUrl, relay: 'always' });
    streams.push(stream);
    expect(stream.route).toBe('relay');
    await roundTrip(stream.sock, 2 * 1024 * 1024);
    expect(server.stats().relayedBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  it('refuses a PC the Mac was not paired with, on both routes', async () => {
    const stranger = generateIdentity().identity.publicKey;
    door = await startDoor([stranger]);
    await expect(openRemote({ label: 'Test Mac', macKey: door.macKey, signalUrl, relay: 'never' })).rejects.toMatchObject({ code: 'NOT_PAIRED' });
    await expect(openRemote({ label: 'Test Mac', macKey: door.macKey, signalUrl, relay: 'always' })).rejects.toMatchObject({ code: 'NOT_PAIRED' });
    expect(door.sessionCount).toBe(0);
  });

  it('drops a connected PC once it is removed from the allowed list', async () => {
    const pc = await pcIdentity();
    door = await startDoor([pc.publicKey]);
    const stream = await openRemote({ label: 'Test Mac', macKey: door.macKey, signalUrl, relay: 'never' });
    streams.push(stream);
    writeAllowed([]);
    await Promise.race([stream.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('still connected')), 15_000))]);
  });

  it('says the Mac is offline when its door is not connected', async () => {
    const macKey = generateIdentity().identity.publicKey;
    await expect(openRemote({ label: 'Test Mac', macKey, signalUrl, relay: 'allow' })).rejects.toMatchObject({ code: 'MAC_OFFLINE' });
  });

  it('turns away a hello with a bad signature', async () => {
    const { identity } = generateIdentity();
    const other = generateIdentity().identity;
    const ws = new WebSocket(signalSocketUrl(signalUrl, `/v1/mac/${identity.publicKey}`));
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener('message', (event) => {
        const m = JSON.parse(String(event.data));
        if (m.t === 'challenge') ws.send(JSON.stringify({ t: 'hello', role: 'mac', key: identity.publicKey, sig: signText(other, helloText('mac', m.nonce, identity.publicKey, identity.publicKey)) }));
      });
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    expect(code).toBe(4403);
  });
});

describe('remote access, the pieces', () => {
  it('binds an offer to its DTLS fingerprints', () => {
    const sdp = 'v=0\r\na=fingerprint:SHA-256 ab:cd:ef\r\na=setup:actpass\r\n';
    expect(sdpFingerprints(sdp)).toEqual(['sha-256 AB:CD:EF']);
    const { identity } = generateIdentity();
    const text = descriptionText('offer', 'session-1234567890', 'mac', identity.publicKey, sdp);
    const sig = signText(identity, text);
    expect(verifyText(identity.publicKey, text, sig)).toBe(true);
    // Another certificate in the SDP (someone in the middle) breaks the signature.
    const tampered = descriptionText('offer', 'session-1234567890', 'mac', identity.publicKey, sdp.replace('ab:cd:ef', 'ab:cd:00'));
    expect(verifyText(identity.publicKey, tampered, sig)).toBe(false);
  });

  it('reads signaling server addresses the way people type them', () => {
    expect(signalSocketUrl('signal.example.com', '/v1/x')).toBe('wss://signal.example.com/v1/x');
    expect(signalSocketUrl('https://signal.example.com/', '/v1/x')).toBe('wss://signal.example.com/v1/x');
    expect(signalSocketUrl('http://localhost:8787', 'v1/x')).toBe('ws://localhost:8787/v1/x');
    expect(signalUrlProblem('signal.example.com')).toBeNull();
    expect(signalUrlProblem('ws://signal.example.com')).toMatch(/wss/);
    expect(signalUrlProblem('ws://127.0.0.1:8787')).toBeNull();
    expect(signalUrlProblem('')).toMatch(/address/);
  });

  it('hands node-datachannel STUN first and only UDP TURN', () => {
    const servers = toNdcIceServers([
      { urls: ['turn:turn.example.com:3478?transport=udp', 'turn:turn.example.com:3478?transport=tcp', 'turns:turn.example.com:5349?transport=tcp'], username: '1:u', credential: 'p' },
      { urls: 'stun:stun.example.com:3478' },
    ], 'allow');
    expect(servers).toEqual(['stun:stun.example.com:3478', { hostname: 'turn.example.com', port: 3478, username: '1:u', password: 'p', relayType: 'TurnUdp' }]);
    expect(toNdcIceServers([{ urls: 'turn:t:3478', username: 'u', credential: 'p' }], 'never')).toEqual([]);
  });

  it('answers STUN binding requests with the sender’s address', async () => {
    const stun = await startStun(0, '127.0.0.1', '::1');
    const client = dgram.createSocket('udp4');
    const transaction = randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(0x2112a442, 4);
    transaction.copy(request, 8);
    const response = await new Promise<Buffer>((resolve) => {
      client.on('message', (msg) => resolve(msg));
      client.bind(0, '127.0.0.1', () => client.send(request, stun.ports[0]!, '127.0.0.1'));
    });
    const localPort = client.address().port;
    client.close();
    await stun.close();
    expect(response.readUInt16BE(0)).toBe(0x0101);
    expect(response.subarray(8, 20).equals(transaction)).toBe(true);
    // XOR-MAPPED-ADDRESS is the first attribute.
    expect(response.readUInt16BE(20)).toBe(0x0020);
    const port = response.readUInt16BE(26) ^ 0x2112;
    const ip = (response.readUInt32BE(28) ^ 0x2112a442) >>> 0;
    expect(port).toBe(localPort);
    expect([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.')).toBe('127.0.0.1');
    expect(bindingResponse(Buffer.from('not stun'), '127.0.0.1', 1)).toBeNull();
  });

  it('keeps the PC’s identity across restarts', async () => {
    const first = await pcIdentity();
    resetPcIdentityCache();
    const second = await pcIdentity();
    expect(second.publicKey).toBe(first.publicKey);
    expect(existsSync(path.join(process.env.CAPMAC_CONFIG_DIR!, 'remote_ed25519'))).toBe(true);
  });
});
