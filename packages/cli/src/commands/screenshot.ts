import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseTarget, loadProject, MacSession, recall, runsOnMac, takeAppScreenshot, takeDeviceScreenshot, takeScreenshot, UserError, withStep } from '@capmac/core/engine';
import type { Target, TargetsResult } from '@capmac/core/shared/protocol';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';

/**
 * The screen to photograph: the one asked for (a simulator, or an iPhone
 * plugged into the Mac), else the simulator this project last ran on if it is
 * booted, else any booted iPhone, else any booted simulator.
 */
export function screenshotTarget(all: TargetsResult, wanted: string | undefined, last: string | undefined, device = false): Target {
  if (wanted || device) {
    const target = chooseTarget(all, { wanted, device });
    if (target.kind === 'simulator' && target.state !== 'Booted') throw new UserError(`${target.name} is not running.`, 'Start your app on it first: `capmac run --no-logs --target "<name>"`.');
    return target;
  }
  const booted = all.simulators.filter((t) => t.state === 'Booted');
  const pick = booted.find((t) => t.udid === last) ?? booted.find((t) => /iPhone/.test(t.name)) ?? booted[0];
  if (!pick) throw new UserError('No simulator is running.', 'Start your app first with `capmac run --no-logs`, or photograph a plugged-in iPhone with --device.');
  return pick;
}

/** `capmac screenshot [file]`: a PNG of a simulator's or a plugged-in iPhone's screen (or the Electron app's window), saved on this PC. */
export async function screenshotCommand(file: string | undefined, options: { mac?: string; target?: string; device?: boolean; electron?: boolean }): Promise<void> {
  const { ctx } = terminalContext();
  const project = await loadProject(process.cwd()).catch(() => null);
  const session = await MacSession.open({ host: options.mac ?? project?.config.host });
  try {
    let shot: { png: Buffer; width: number | null; height: number | null };
    if (project && runsOnMac(project, options)) {
      shot = await withStep(ctx, `Screenshot of ${project.appName}`, 'other', () => takeAppScreenshot(session, project.projectId));
    } else {
      const all = await session.call<TargetsResult>('targets');
      const last = project ? (await recall(project.projectId)).lastTarget : undefined;
      const target = screenshotTarget(all, options.target, last, options.device);
      shot = target.kind === 'device'
        ? await withStep(ctx, `Screenshot of ${target.name}`, 'other', () =>
            takeDeviceScreenshot(session, target, {
              onWait: (wait) =>
                log.info(wait === 'device' ? `Plug ${target.name} into ${session.label} with a cable…` : `Click ${pc.bold('Allow')} on ${session.label}: macOS asks once if CapMac may see the iPhone's screen…`),
            }),
          )
        : await withStep(ctx, `Screenshot of ${target.name}`, 'other', () => takeScreenshot(session, target.udid));
    }
    const out = path.resolve(file ?? path.join(os.tmpdir(), 'capmac', `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, shot.png);
    log.success(`Saved ${pc.bold(out)}${shot.width && shot.height ? pc.dim(` (${shot.width}×${shot.height})`) : ''}`);
  } finally {
    session.close();
  }
}
