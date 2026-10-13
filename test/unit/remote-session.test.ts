/**
 * How MacSession.open picks its route once remote access is on: the local
 * network when the Mac answers there, the internet otherwise (peer to peer,
 * or the relay), and a clear error when neither works. An in-process ssh2
 * server plays the Mac's sshd; the signaling server and the door are real.
 */
import { mkdtempSync, promises as fs, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignalServer } from '../../services/signal/src/server.js';
import { Door } from '../../packages/core/src/door/door.js';
import { ensureClientKey, loadGlobalConfig, saveGlobalConfig, type HostConfig } from '../../packages/core/src/engine/config.js';
import { pcIdentity, resetPcIdentityCache } from '../../packages/core/src/engine/remote/identity.js';
import { MacSession, setRouteOverride } from '../../packages/core/src/engine/session.js';
import { fingerprintOf } from '../../packages/core/src/engine/ssh.js';
import { setNodeDataChannelDir } from '../../packages/core/src/remote/native.js';
import type { DoorConfig } from '../../packages/core/src/shared/remote-door.js';
import { generateIdentity } from '../../packages/core/src/shared/remote-keys.js';

const { Server, utils } = ssh2;
const ROOT = path.resolve(__dirname, '..', '..');

let work: string;
let previousConfigDir: string | undefined;
let sshd: InstanceType<typeof Server>;
let sshPort = 0;
let hostKeyFingerprint = '';
let signal: SignalServer;
let signalUrl = '';
let door: Door | null = null;
let closedPort = 0;
const sessions: MacSession[] = [];

function startSshd(): Promise<void> {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const parsed = utils.parseKey(hostKey);
  if (parsed instanceof Error) throw parsed;
  hostKeyFingerprint = fingerprintOf((Array.isArray(parsed) ? parsed[0]! : parsed).getPublicSSH());
  sshd = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])));
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`ran: ${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on('error', () => undefined);
  });
  return new Promise((resolve) => sshd.listen(0, '127.0.0.1', () => {
    sshPort = (sshd.address() as net.AddressInfo).port;
    resolve();
  }));
}

/** A port nothing listens on (connections are refused at once). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startDoor(): Promise<Door> {
  const dir = mkdtempSync(path.join(work, 'door-'));
  const { identity } = generateIdentity();
  const config: DoorConfig = {
    version: 1,
    signalUrl,
    sshPort,
    keepAwake: false,
    keyFile: path.join(dir, 'door_ed25519'),
    allowedFile: path.join(dir, 'allowed.json'),
    statusFile: path.join(dir, 'status.json'),
    logFile: path.join(dir, 'door.log'),
    runtimeDir: ROOT,
  };
  writeFileSync(config.allowedFile, JSON.stringify([{ key: (await pcIdentity()).publicKey, name: 'test', addedAt: new Date().toISOString() }]));
  const d = new Door(config, identity, { version: 'test', sshHost: '127.0.0.1', allowKeepAwake: false });
  d.start();
  for (let i = 0; i < 100 && d.status.state !== 'online'; i++) await new Promise((r) => setTimeout(r, 50));
  return d;
}

/** Writes the paired Mac to the test config: reachable on the "local network" (127.0.0.1) or not. */
async function pairTestMac(options: { lan: boolean; route?: 'auto' | 'lan' | 'internet'; relay?: 'allow' | 'never' | 'always' }): Promise<void> {
  const host: HostConfig = {
    name: 'test-mac',
    host: '127.0.0.1',
    port: options.lan ? sshPort : closedPort,
    username: 'ik',
    hostKey: hostKeyFingerprint,
    nodePath: '/usr/local/bin/node',
    home: '/Users/ik',
    macName: 'Test Mac',
    pairedAt: new Date().toISOString(),
    remote: door ? { macKey: door.macKey, signalUrl, enabledAt: new Date().toISOString(), route: options.route ?? 'auto', relay: options.relay ?? 'allow' } : undefined,
  };
  const config = await loadGlobalConfig();
  config.hosts = { [host.name]: host };
  config.defaultHost = host.name;
  await saveGlobalConfig(config);
}

async function open(): Promise<MacSession> {
  const session = await MacSession.open();
  sessions.push(session);
  return session;
}

async function exec(session: MacSession, command: string): Promise<string> {
  const channel = await session.conn.exec(command);
  return new Promise((resolve) => {
    let out = '';
    channel.on('data', (d: Buffer) => (out += d.toString()));
    channel.on('close', () => resolve(out.trim()));
  });
}

beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'capmac-remote-session-'));
  previousConfigDir = process.env.CAPMAC_CONFIG_DIR;
  process.env.CAPMAC_CONFIG_DIR = path.join(work, 'pc');
  resetPcIdentityCache();
  await ensureClientKey();
  setNodeDataChannelDir(ROOT);
  await startSshd();
  closedPort = await freePort();
  signal = new SignalServer({ port: 0, host: '127.0.0.1', stunUrls: [], version: 'test' });
  signalUrl = `ws://127.0.0.1:${await signal.start()}`;
});

afterEach(async () => {
  setRouteOverride(null);
  for (const s of sessions.splice(0)) s.close();
  await door?.stop();
  door = null;
});

afterAll(async () => {
  await signal.close();
  await new Promise<void>((resolve) => sshd.close(() => resolve()));
  if (previousConfigDir === undefined) delete process.env.CAPMAC_CONFIG_DIR;
  else process.env.CAPMAC_CONFIG_DIR = previousConfigDir;
  resetPcIdentityCache();
  await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
});

describe('choosing the route', () => {
  it('uses the local network when the Mac answers there', async () => {
    door = await startDoor();
    await pairTestMac({ lan: true });
    const session = await open();
    expect(session.route).toBe('lan');
    expect(await exec(session, 'whoami')).toBe('ran: whoami');
  });

  it('goes over the internet, peer to peer, when the local network does not answer', async () => {
    door = await startDoor();
    await pairTestMac({ lan: false });
    const session = await open();
    expect(session.route).toBe('direct');
    expect(session.routeDetail).toMatch(/host/);
    expect(await exec(session, 'uname')).toBe('ran: uname');
  });

  it('uses the relay when told to', async () => {
    door = await startDoor();
    await pairTestMac({ lan: true, route: 'internet', relay: 'always' });
    const session = await open();
    expect(session.route).toBe('relay');
    expect(await exec(session, 'id')).toBe('ran: id');
  });

  it('follows a one-time route over the Mac’s setting (the CLI’s --route)', async () => {
    door = await startDoor();
    await pairTestMac({ lan: true, route: 'auto' });
    setRouteOverride('internet');
    expect((await open()).route).toBe('direct');
    setRouteOverride('lan');
    expect((await open()).route).toBe('lan');
  });

  it('says what happened both ways when neither works', async () => {
    door = await startDoor();
    await pairTestMac({ lan: false });
    await door.stop();
    door = null;
    const error = await MacSession.open().then(() => null, (err: unknown) => err as { message: string; details?: string[] });
    expect(error?.message).toMatch(/Test Mac is offline/);
    expect(error?.details?.join('\n')).toMatch(/On the local network:[\s\S]*Over the internet:/);
  });

  it('only tries the local network when told to, even with the Mac away', async () => {
    door = await startDoor();
    await pairTestMac({ lan: false, route: 'lan' });
    await expect(MacSession.open()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
