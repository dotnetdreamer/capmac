import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseTarget, loadProject, MacSession, recall, takeScreenshot, UserError, withStep } from '@capmac/core/engine';
import type { Target, TargetsResult } from '@capmac/core/shared/protocol';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';

/**
 * The simulator to photograph: the one asked for, else the one this project
 * last ran on if it is booted, else any booted iPhone, else any booted simulator.
 */
export function screenshotTarget(all: TargetsResult, wanted: string | undefined, last: string | undefined): Target {
  if (wanted) {
    const target = chooseTarget(all, { wanted, simulator: true });
    if (target.kind !== 'simulator') throw new UserError(`${target.name} is a device; screenshots work on simulators.`, 'Pick a simulator with --target (see `capmac targets`).');
    if (target.state !== 'Booted') throw new UserError(`${target.name} is not running.`, 'Start your app on it first: `capmac run --no-logs --target "<name>"`.');
    return target;
  }
  const booted = all.simulators.filter((t) => t.state === 'Booted');
  const pick = booted.find((t) => t.udid === last) ?? booted.find((t) => /iPhone/.test(t.name)) ?? booted[0];
  if (!pick) throw new UserError('No simulator is running.', 'Start your app first with `capmac run --no-logs`, then take the screenshot.');
  return pick;
}

/** `capmac screenshot [file]`: a PNG of the simulator's screen, saved on this PC. */
export async function screenshotCommand(file: string | undefined, options: { mac?: string; target?: string }): Promise<void> {
  const { ctx } = terminalContext();
  const project = await loadProject(process.cwd()).catch(() => null);
  const session = await MacSession.open({ host: options.mac ?? project?.config.host });
  try {
    const all = await session.call<TargetsResult>('targets');
    const last = project ? (await recall(project.projectId)).lastTarget : undefined;
    const target = screenshotTarget(all, options.target, last);
    const shot = await withStep(ctx, `Screenshot of ${target.name}`, 'other', () => takeScreenshot(session, target.udid));
    const out = path.resolve(file ?? path.join(os.tmpdir(), 'capmac', `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, shot.png);
    log.success(`Saved ${pc.bold(out)}${shot.width && shot.height ? pc.dim(` (${shot.width}×${shot.height})`) : ''}`);
  } finally {
    session.close();
  }
}
