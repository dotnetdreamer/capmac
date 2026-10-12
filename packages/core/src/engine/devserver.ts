import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { log, type EngineContext } from './context.js';
import { UserError } from './errors.js';
import { stripAnsi } from './format.js';
import { scriptCommand, type ProjectInfo } from './project.js';

export interface DevServer {
  url: URL;
  /** True when capmac did not start it (we only connect to it). */
  external: boolean;
  /** The command capmac started (null when external). */
  command: string | null;
  stop(): Promise<void>;
  /** Resolves when a dev server capmac started exits on its own. */
  exited: Promise<number | null>;
}

const URL_IN_TEXT = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]|[\w.-]+):\d+[^\s'"]*)/g;
/** Vite / webpack / Angular messages that mean "the app just got new code". */
const HMR_LINE = /\b(hmr update|page reload|hot updated|hmr\b.*\bupdate|Compiled successfully|Application bundle generation complete)\b/i;

export function detectDevCommand(project: ProjectInfo): string | null {
  const scripts = project.scripts;
  if (scripts.dev) return scriptCommand(project.packageManager, 'dev');
  if (scripts.start && /\b(ng serve|ionic serve|vite|react-scripts start|webpack(-dev-server| serve)|vue-cli-service serve|stencil|astro dev|next dev|nuxt dev|svelte-kit dev)\b/.test(scripts.start)) {
    return project.packageManager === 'npm' ? 'npm start' : scriptCommand(project.packageManager, 'start');
  }
  if (scripts.serve) return scriptCommand(project.packageManager, 'serve');
  if (scripts.start) return project.packageManager === 'npm' ? 'npm start' : scriptCommand(project.packageManager, 'start');
  return null;
}

/** Picks the best local URL from dev server output (prefers localhost over LAN addresses). */
export function pickDevUrl(text: string): URL | null {
  const urls = [...stripAnsi(text).matchAll(URL_IN_TEXT)].map((m) => m[1]!.replace(/[.,;)]+$/, ''));
  if (urls.length === 0) return null;
  const local = urls.find((u) => /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u)) ?? urls.find((u) => /\/\/(0\.0\.0\.0|\[::\])[:/]/.test(u)) ?? urls[0]!;
  const url = new URL(local);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
  return url;
}

export function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ''), port, autoSelectFamily: true });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Stops a process and everything it started (dev servers spawn their own children). */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || !child.pid) {
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      resolve();
    }
  });
}

export interface DevServerOptions {
  url?: string;
  command?: string;
}

export async function startDevServer(project: ProjectInfo, options: DevServerOptions, ctx: EngineContext): Promise<DevServer> {
  const explicit = options.url ?? project.config.web?.devUrl;
  if (explicit) {
    const url = new URL(explicit);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!(await canConnect(url.hostname, port))) {
      throw new UserError(`Nothing is listening at ${url.href}.`, 'Start your dev server first, or let capmac start it by leaving out --url.');
    }
    return { url, external: true, command: null, stop: async () => undefined, exited: new Promise(() => undefined) };
  }
  const command = options.command ?? project.config.web?.dev ?? detectDevCommand(project);
  if (!command) {
    throw new UserError('No dev server script found in package.json ("dev", "start" or "serve").', 'Pass the command with --dev-command "npm run dev", or point at a running server with --url http://localhost:5173.');
  }
  log(ctx, 'info', `Starting dev server: ${command}`);
  const child = spawn(command, {
    cwd: project.capDir,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, BROWSER: 'none', ...(process.env.NO_COLOR ? {} : { FORCE_COLOR: '1' }) },
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  let output = '';
  let found: URL | null = null;
  let partial = '';
  const onText = (text: string) => {
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      ctx.emit({ type: 'devserver-output', text: line });
      if (found && HMR_LINE.test(stripAnsi(line))) ctx.emit({ type: 'hmr', state: 'update', at: Date.now(), detail: stripAnsi(line).trim() });
    }
  };
  const url = await new Promise<URL>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UserError('The dev server did not print a URL within 2 minutes.', 'Pass --url http://localhost:<port> if it is running, or check its output above.')), 120_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      onText(text);
      if (found) return;
      output = (output + text).slice(-20_000);
      const candidate = pickDevUrl(output);
      if (candidate) {
        found = candidate;
        clearTimeout(timer);
        resolve(candidate);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!found) {
        const missingDeps = /is not recognized|command not found|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(output);
        reject(new UserError(
          `The dev server exited (code ${code}) before it was ready.`,
          missingDeps ? 'Its dependencies may not be installed on this PC: run `npm install` in the project, then try again.' : 'Check its output above.',
          stripAnsi(output).split(/\r?\n/).filter((l) => l.trim()).slice(-15),
        ));
      }
    });
  }).catch(async (err) => {
    await killTree(child);
    throw err;
  });
  const port = Number(url.port || 80);
  for (let i = 0; i < 40 && !(await canConnect(url.hostname, port)); i++) await new Promise((r) => setTimeout(r, 250));
  if (url.protocol === 'https:') log(ctx, 'warn', 'The dev server uses HTTPS; iOS will reject a self-signed certificate. Prefer plain HTTP for live reload.');
  return { url, external: false, command, stop: () => killTree(child), exited };
}
