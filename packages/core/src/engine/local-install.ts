/** Installs a project's JavaScript dependencies on this PC (the web build and dev server need them). */
import { spawn } from 'node:child_process';
import { startStep, type EngineContext } from './context.js';
import { CancelledError, UserError } from './errors.js';
import { stripAnsi } from './format.js';
import type { ProjectInfo } from './project.js';

export async function installLocalDependencies(project: ProjectInfo, ctx: EngineContext, signal?: AbortSignal): Promise<void> {
  const command = `${project.packageManager} install`;
  const s = startStep(ctx, `Installing dependencies on this PC (${command})`, 'other');
  const tail: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', npm_config_fund: 'false', npm_config_audit: 'false' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, { cwd: project.syncRoot, shell: true, env, windowsHide: true });
    const onAbort = () => {
      child.kill();
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const onData = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = stripAnsi(raw).trimEnd();
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        ctx.emit({ type: 'tool-output', stream: 'stdout', text: line });
        s.update(line.trim().slice(0, 160));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (exit) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(exit);
    });
  }).catch((err) => {
    if (err instanceof CancelledError) s.cancel();
    else s.fail();
    throw err;
  });
  if (code !== 0) {
    s.fail();
    const missing = tail.some((l) => /is not recognized|command not found|ENOENT/i.test(l));
    throw new UserError(
      `${command} failed (exit ${code}).`,
      missing ? `Install Node.js (and ${project.packageManager}) on this PC: https://nodejs.org` : 'Check the output above; a private registry may need a token in your .npmrc.',
      tail.slice(-25),
    );
  }
  s.succeed();
}
