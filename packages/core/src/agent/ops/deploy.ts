import type { DeployParams, DeployResult, Target } from '../../shared/protocol.js';
import { toolEnv } from '../env.js';
import { step, type AgentIO } from '../io.js';
import { AgentError, parseJsonLoose, run, sleep, tryCapture, which } from '../proc.js';

async function simulatorState(udid: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const json = await tryCapture('xcrun', ['simctl', 'list', 'devices', '-j'], { env, timeoutMs: 60_000 });
  for (const list of Object.values<any[]>(parseJsonLoose(json)?.devices ?? {})) {
    const found = list.find((d) => d.udid === udid);
    if (found) return String(found.state);
  }
  return null;
}

/**
 * Shows the simulator window on the Mac (Simulator.app, or Device Hub on
 * Xcode 27+), in the background (-g): someone may be working on the Mac.
 */
async function showSimulatorWindow(udid: string, env: NodeJS.ProcessEnv): Promise<void> {
  const simulator = await run('open', ['-g', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { env, timeoutMs: 30_000 }).catch(() => null);
  if (simulator?.code === 0) return;
  await run('open', ['-g', '-b', 'com.apple.dt.Devices'], { env, timeoutMs: 30_000 }).catch(() => null);
}

export async function bootSimulator(target: Target, io: AgentIO, env: NodeJS.ProcessEnv, show: boolean): Promise<void> {
  const state = await simulatorState(target.udid, env);
  if (state === null) throw new AgentError(`Simulator ${target.name} (${target.udid}) no longer exists.`, 'TARGET_NOT_FOUND', 'Run `capmac targets` to pick another one.');
  if (state !== 'Booted') {
    await step(io, 'boot', `Booting ${target.name} (${target.os})`, async () => {
      // -b boots the device if needed and waits until it has finished booting.
      const r = await run('xcrun', ['simctl', 'bootstatus', target.udid, '-b'], {
        env,
        signal: io.signal,
        timeoutMs: 5 * 60_000,
        onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 120) }),
      });
      if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
      if (r.code !== 0) {
        const text = r.tail.join('\n');
        const hint = /launchd_sim|bind to session|CoreSimulatorService|Aqua/i.test(text)
          ? 'Simulators need the Mac user logged in to the desktop. Log in on the Mac (or turn on automatic login), then try again.'
          : /dyld_shared_cache/i.test(text)
            ? 'Run `capmac exec -- xcrun simctl runtime dyld_shared_cache update --all` on the Mac, then try again.'
            : undefined;
        throw new AgentError(`Could not boot ${target.name}`, 'DEPLOY_FAILED', hint, r.tail.slice(-10));
      }
    });
  }
  if (show) await showSimulatorWindow(target.udid, env);
}

function appEnv(env: NodeJS.ProcessEnv, prefix: string, osLogs: boolean | undefined): NodeJS.ProcessEnv {
  return {
    ...env,
    // Swift print() is block-buffered without a TTY; keep logs flowing line by line.
    [`${prefix}NSUnbufferedIO`]: 'YES',
    ...(osLogs ? { [`${prefix}OS_ACTIVITY_DT_MODE`]: 'enable' } : {}),
  };
}

async function deploySimulator(params: DeployParams, io: AgentIO, env: NodeJS.ProcessEnv): Promise<DeployResult> {
  const { target, appPath, bundleId } = params;
  await bootSimulator(target, io, env, Boolean(params.showSimulator));
  await step(io, 'install', `Installing on ${target.name}`, async () => {
    const r = await run('xcrun', ['simctl', 'install', target.udid, appPath], { env, signal: io.signal, timeoutMs: 5 * 60_000 });
    if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
    if (r.code !== 0) throw new AgentError('Installing the app on the simulator failed', 'DEPLOY_FAILED', undefined, r.tail.slice(-10));
  });

  const launchEnv = appEnv(env, 'SIMCTL_CHILD_', params.osLogs);
  const appArgs = params.launchArgs ?? [];
  if (!params.attach) {
    let r = await run('xcrun', ['simctl', 'launch', '--terminate-running-process', target.udid, bundleId, ...appArgs], { env: launchEnv, signal: io.signal, timeoutMs: 120_000 });
    if (r.code !== 0 && /FBSOpenApplicationServiceErrorDomain/.test(r.tail.join('\n'))) {
      await sleep(2000, io.signal);
      r = await run('xcrun', ['simctl', 'launch', '--terminate-running-process', target.udid, bundleId, ...appArgs], { env: launchEnv, signal: io.signal, timeoutMs: 120_000 });
    }
    if (r.code !== 0) throw new AgentError('Launching the app failed', 'DEPLOY_FAILED', undefined, r.tail.slice(-10));
    io.send({ t: 'ready', data: { pid: Number(r.stdout.split(':').pop()) || null } });
    return { reason: 'detached', exitCode: null };
  }

  // simctl prints "<bundle id>: <pid>" through buffered stdio, so in console
  // mode it only shows up when simctl exits. Treat the app's first output (or
  // a few quiet seconds) as "launched" instead.
  const pidLine = new RegExp(`^${bundleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\d+$`);
  for (let attempt = 1; ; attempt++) {
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      io.send({ t: 'ready', data: {} });
    };
    const quietTimer = setTimeout(announce, 4000);
    const result = await run('xcrun', ['simctl', 'launch', '--console-pty', '--terminate-running-process', target.udid, bundleId, ...appArgs], {
      env: launchEnv,
      signal: io.signal,
      capture: false,
      onLine: (line, stream) => {
        if (pidLine.test(line.trim())) return;
        announce();
        io.send({ t: 'app', stream, text: line });
      },
    }).finally(() => clearTimeout(quietTimer));
    if (result.cancelled) {
      // The developer stopped the session (Ctrl+C): stop the app too, like Xcode's Stop button.
      await run('xcrun', ['simctl', 'terminate', target.udid, bundleId], { env, timeoutMs: 30_000 }).catch(() => undefined);
      return { reason: 'cancelled', exitCode: null };
    }
    const tail = result.tail.join('\n');
    if (result.code !== 0 && /An error was encountered processing the command|FBSOpenApplicationServiceErrorDomain|Unable to launch|failed to launch/i.test(tail)) {
      // Right after a boot SpringBoard sometimes refuses the first launch.
      if (attempt === 1 && /FBSOpenApplicationServiceErrorDomain|SBMainWorkspace/.test(tail)) {
        await sleep(2000, io.signal);
        continue;
      }
      throw new AgentError('Launching the app failed', 'DEPLOY_FAILED', undefined, result.tail.slice(-10));
    }
    return { reason: 'exited', exitCode: result.code };
  }
}

const DEVICECTL_CHATTER = /^(Launched application with|Waiting for the application to terminate|The app terminated with the exit code|Acquired tunnel connection|Enabling developer disk image services|Acquired usage assertion)/;

async function deployDevice(params: DeployParams, io: AgentIO, env: NodeJS.ProcessEnv): Promise<DeployResult> {
  const { target, appPath, bundleId } = params;
  await step(io, 'install', `Installing on ${target.name}`, async () => {
    const r = await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', target.udid, appPath], {
      env,
      signal: io.signal,
      timeoutMs: 10 * 60_000,
      onLine: (line) => line.trim() && io.send({ t: 'progress', text: line.trim().slice(0, 120) }),
    });
    if (r.cancelled) throw new AgentError('Cancelled', 'CANCELLED');
    if (r.code !== 0) {
      const text = r.tail.join('\n');
      const hint = /Developer Mode/i.test(text)
        ? 'Turn on Developer Mode on the iPhone: Settings › Privacy & Security › Developer Mode.'
        : /locked|BSErrorCodeDescription = Locked/i.test(text)
          ? 'Unlock the iPhone and try again.'
          : /trust|pair/i.test(text)
            ? 'Connect the iPhone to the Mac once and tap "Trust This Computer".'
            : undefined;
      throw new AgentError('Installing the app on the device failed', 'DEPLOY_FAILED', hint, r.tail.slice(-12));
    }
  });

  const childEnv = JSON.stringify({ NSUnbufferedIO: 'YES', ...(params.osLogs ? { OS_ACTIVITY_DT_MODE: 'enable' } : {}) });
  const launchArgs = ['devicectl', 'device', 'process', 'launch', '--device', target.udid, '--terminate-existing', '--environment-variables', childEnv];
  const lockedHint = (text: string) => (/locked/i.test(text) ? 'Unlock the iPhone and try again.' : undefined);
  const appArgs = params.launchArgs ?? [];
  if (!params.attach) {
    const r = await run('xcrun', [...launchArgs, bundleId, ...appArgs], { env, signal: io.signal, timeoutMs: 120_000 });
    if (r.code !== 0) throw new AgentError('Launching the app failed', 'DEPLOY_FAILED', lockedHint(r.tail.join('\n')), r.tail.slice(-10));
    io.send({ t: 'ready', data: {} });
    return { reason: 'detached', exitCode: null };
  }

  // devicectl only streams the app's output when it has a terminal, so give it one with script(1).
  const script = await which('script', env);
  const command = script ? script : 'xcrun';
  const args = script ? ['-q', '-t', '0', '/dev/null', 'xcrun', ...launchArgs, '--console', bundleId, ...appArgs] : [...launchArgs, '--console', bundleId, ...appArgs];
  let started = false;
  const attach = await run(command, args, {
    env,
    signal: io.signal,
    capture: false,
    keepStdinOpen: true,
    onLine: (line, stream) => {
      if (!started) {
        started = true;
        io.send({ t: 'ready', data: {} });
      }
      if (DEVICECTL_CHATTER.test(line.trim())) {
        io.log('debug', line.trim());
        return;
      }
      io.send({ t: 'app', stream, text: line });
    },
  });
  if (attach.cancelled) return { reason: 'cancelled', exitCode: null };
  const text = attach.tail.join('\n');
  if (attach.code !== 0 && /--console|not implemented|unknown option|unrecognized/i.test(text)) {
    // Xcode 15 cannot attach a console: launch without one.
    io.log('warn', 'This Xcode cannot stream device console output (needs Xcode 16+). The app was launched without logs.');
    const r = await run('xcrun', [...launchArgs, bundleId, ...appArgs], { env, signal: io.signal, timeoutMs: 120_000 });
    if (r.code !== 0) throw new AgentError('Launching the app failed', 'DEPLOY_FAILED', lockedHint(r.tail.join('\n')), r.tail.slice(-10));
    io.send({ t: 'ready', data: {} });
    return { reason: 'detached', exitCode: null };
  }
  if (attach.code !== 0 && !/The app terminated/.test(text)) {
    throw new AgentError('Launching the app failed', 'DEPLOY_FAILED', lockedHint(text), attach.tail.slice(-10));
  }
  const exitCode = Number(text.match(/exit code (-?\d+)/)?.[1] ?? attach.code ?? 0);
  return { reason: 'exited', exitCode };
}

export async function opBoot(params: { target: Target; show?: boolean }, io: AgentIO): Promise<{ booted: boolean }> {
  await bootSimulator(params.target, io, await toolEnv(), Boolean(params.show));
  return { booted: true };
}

/** Shuts a simulator down (fine if it is already shut down). */
export async function opShutdown(params: { target: Target }, io: AgentIO): Promise<{ shutdown: boolean }> {
  const env = await toolEnv();
  const r = await run('xcrun', ['simctl', 'shutdown', params.target.udid], { env, signal: io.signal, timeoutMs: 120_000 });
  if (r.code !== 0 && !/current state: Shutdown/i.test(r.tail.join('\n'))) {
    throw new AgentError(`Could not shut down ${params.target.name}`, 'DEPLOY_FAILED', undefined, r.tail.slice(-10));
  }
  return { shutdown: true };
}

export async function opDeploy(params: DeployParams, io: AgentIO): Promise<DeployResult> {
  const env = await toolEnv();
  return params.target.kind === 'simulator' ? deploySimulator(params, io, env) : deployDevice(params, io, env);
}

/** Streams the unified log (os_log/NSLog) of a running app on a simulator. */
export async function opLogs(params: { target: Target; executable: string }, io: AgentIO): Promise<{ code: number | null }> {
  if (params.target.kind !== 'simulator') {
    throw new AgentError('Live log streaming of a running app is only available for simulators.', 'BAD_REQUEST', 'For devices, `capmac run` attaches to the app console when it launches.');
  }
  const env = await toolEnv();
  const predicate = `process == "${params.executable.replace(/"/g, '')}"`;
  const r = await run('xcrun', ['simctl', 'spawn', params.target.udid, 'log', 'stream', '--style', 'compact', '--level', 'debug', '--predicate', predicate], {
    env,
    signal: io.signal,
    capture: false,
    onLine: (line) => {
      if (/^Filtering the log data|^Timestamp\s/.test(line)) return;
      io.send({ t: 'app', stream: 'stdout', text: line });
    },
  });
  return { code: r.code };
}
