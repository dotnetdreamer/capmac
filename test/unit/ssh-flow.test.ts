/**
 * Exercises capmac's SSH plumbing against an in-process ssh2 server: the real
 * `capmac pair` (password, key install, host key pinning), agent upload,
 * sync, exec and the reverse tunnel. Commands run through Git Bash/sh locally;
 * nothing here pretends to be Xcode.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { Server, utils } = ssh2;
const ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE = path.join(ROOT, 'examples', 'hello-capacitor');
const SHELL = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
const PASSWORD = 'capmac-test-password';
const canRun = existsSync(SHELL) && existsSync(path.join(SAMPLE, 'node_modules'));

let server: InstanceType<typeof Server>;
let port = 0;
let work: string;
let fakeHome: string;
let configDir: string;

function authorizedKeys(): Array<ReturnType<typeof utils.parseKey>> {
  const file = path.join(fakeHome, '.ssh', 'authorized_keys');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => utils.parseKey(l));
}

function startServer(): Promise<void> {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PASSWORD) return ctx.accept();
      if (ctx.method === 'publickey') {
        for (const key of authorizedKeys()) {
          if (key instanceof Error) continue;
          if (ctx.key.algo !== key.type || !ctx.key.data.equals(key.getPublicSSH())) continue;
          if (ctx.signature && ctx.blob && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) continue;
          return ctx.accept();
        }
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          const child = spawn(SHELL, ['-c', info.command], {
            env: { ...process.env, HOME: fakeHome, CAPMAC_HOME: path.join(fakeHome, '.capmac'), SHELL },
            windowsHide: true,
          });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on('close', (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
          stream.on('close', () => child.kill());
        });
      });
      client.on('request', (accept, reject, name, info: any) => {
        if (name !== 'tcpip-forward') return reject?.();
        const listener = net.createServer((socket) => {
          client.forwardOut(info.bindAddr, (listener.address() as net.AddressInfo).port, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, (err, channel) => {
            if (err) return socket.destroy();
            socket.pipe(channel).pipe(socket);
          });
        });
        listener.listen(info.bindPort, '127.0.0.1', () => accept?.((listener.address() as net.AddressInfo).port));
        client.on('close', () => listener.close());
      });
    });
    client.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as net.AddressInfo).port;
    resolve();
  }));
}

function capmac(args: string[], cwd = ROOT, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const show = process.env.CAPMAC_TEST_SHOW === '1';
    execFile(process.execPath, [path.join(ROOT, 'bin', 'capmac.js'), ...args], {
      cwd,
      env: { ...process.env, CAPMAC_CONFIG_DIR: configDir, CAPMAC_NO_TTY: '1', NO_COLOR: '1', FORCE_COLOR: '0', CAPMAC_TEST_PW: PASSWORD, ...extraEnv },
      timeout: 120_000,
    }, (err, stdout, stderr) => {
      if (show) process.stdout.write(`
$ capmac ${args.join(' ')}
${stdout}${stderr}`);
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

describe.skipIf(!canRun)('SSH flow against an in-process server', () => {
  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'packages', 'cli', 'scripts', 'build.mjs')], { cwd: ROOT });
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'capmac-ssh-'));
    fakeHome = path.join(work, 'home');
    configDir = path.join(work, 'config');
    await fs.mkdir(fakeHome, { recursive: true });
    await startServer();
  }, 60_000);

  afterAll(async () => {
    server?.close();
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  });

  it('pairs with a password, installs the key and pins the host key', async () => {
    const result = await capmac(['pair', `${os.userInfo().username}@127.0.0.1:${port}`, '--password-env', 'CAPMAC_TEST_PW', '--yes', '--name', 'testmac']);
    expect(result.out).toContain('Installing capmac\'s SSH key');
    expect(result.out).toContain('Paired with');
    expect(result.code).toBe(0);
    const keys = await fs.readFile(path.join(fakeHome, '.ssh', 'authorized_keys'), 'utf8');
    expect(keys).toMatch(/^ssh-ed25519 \S+ capmac@/m);
    const config = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
    expect(config.defaultHost).toBe('testmac');
    expect(config.hosts.testmac.hostKey).toMatch(/^SHA256:/);
    expect(config.hosts.testmac.nodePath).toBeTruthy();
  }, 120_000);

  it('re-pairs without a password once the key is installed', async () => {
    const result = await capmac(['pair', `${os.userInfo().username}@127.0.0.1:${port}`, '--yes', '--name', 'testmac']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Installing capmac\'s SSH key');
    const keys = (await fs.readFile(path.join(fakeHome, '.ssh', 'authorized_keys'), 'utf8')).trim().split('\n');
    expect(keys).toHaveLength(1);
  }, 120_000);

  it('syncs the sample app and only uploads what changed', async () => {
    const first = await capmac(['sync', '--no-prepare'], SAMPLE);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/files? uploaded/);
    const projects = path.join(fakeHome, '.capmac', 'projects');
    const [projectId] = await fs.readdir(projects);
    const mirror = path.join(projects, projectId!, 'src');
    expect(existsSync(path.join(mirror, 'ios', 'App', 'App', 'AppDelegate.swift'))).toBe(true);
    expect(existsSync(path.join(mirror, 'dist', 'index.html'))).toBe(true);
    expect(existsSync(path.join(mirror, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(mirror, 'ios', 'App', 'App', 'public'))).toBe(false);

    const second = await capmac(['sync', '--no-prepare'], SAMPLE);
    expect(second.code).toBe(0);
    expect(second.out).toContain('up to date');

    const marker = path.join(SAMPLE, 'src', 'capmac-sync-test.txt');
    await fs.writeFile(marker, 'hello');
    try {
      const third = await capmac(['sync', '--no-prepare'], SAMPLE);
      expect(third.out).toContain('1 file uploaded');
      expect(await fs.readFile(path.join(mirror, 'src', 'capmac-sync-test.txt'), 'utf8')).toBe('hello');
    } finally {
      await fs.rm(marker, { force: true });
    }
    const fourth = await capmac(['sync', '--no-prepare'], SAMPLE);
    expect(fourth.out).toContain('1 file removed');
    expect(existsSync(path.join(mirror, 'src', 'capmac-sync-test.txt'))).toBe(false);
  }, 180_000);

  it('runs commands in the project on the "Mac"', async () => {
    const result = await capmac(['exec', '--no-sync', '--', 'echo', 'hello from the other side'], SAMPLE);
    expect(result.out).toContain('hello from the other side');
    expect(result.code).toBe(0);
  }, 60_000);

  it('tunnels a local port to the remote side', async () => {
    const { MacSession } = await import('../../packages/core/src/engine/session.js');
    process.env.CAPMAC_CONFIG_DIR = configDir;
    const web = http.createServer((_req, res) => res.end('served from Windows'));
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', () => resolve()));
    const webPort = (web.address() as net.AddressInfo).port;
    const session = await MacSession.open({ host: 'testmac' });
    try {
      const tunnel = await session.conn.reverseForward(0, webPort, '127.0.0.1');
      expect(tunnel.port).toBeGreaterThan(0);
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${tunnel.port}/`, (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      expect(body).toBe('served from Windows');
      await tunnel.close();
    } finally {
      session.close();
      web.close();
    }
  }, 60_000);

  it('dials back in when the connection drops (MacLink)', async () => {
    const { MacLink } = await import('../../packages/core/src/engine/link.js');
    const { nonInteractivePrompter } = await import('../../packages/core/src/engine/context.js');
    process.env.CAPMAC_CONFIG_DIR = configDir;
    const states: string[] = [];
    const ctx = { emit: (e: { type: string; state?: string }) => e.type === 'connection' && states.push(e.state!), prompter: nonInteractivePrompter, verbose: false };
    const link = new MacLink('testmac', ctx as never, { retryMs: 200 });
    try {
      const first = await link.session();
      const restored = new Promise<void>((resolve) => link.onChange((state) => state === 'restored' && resolve()));
      link.dropConnection();
      await restored;
      const second = await link.session();
      expect(second).not.toBe(first);
      expect((await second.conn.runScript('echo still-here\n')).stdout).toContain('still-here');
      expect(states).toEqual(['connecting', 'connected', 'lost', 'restored']);
    } finally {
      link.close();
    }
  }, 60_000);
});
