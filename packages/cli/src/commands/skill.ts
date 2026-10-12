import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  capmacCommandDir,
  capmacCommandStatus,
  findCapacitorDir,
  installCapmacCommand,
  installSkill,
  removeCapmacCommand,
  isAgentDetected,
  removeSkill,
  skillAgents,
  skillFiles,
  skillProjectRoot,
  skillStatus,
  UserError,
  type AgentSkillStatus,
  type SkillChange,
  type SkillPlace,
  type SkillScope,
} from '@capmac/core/engine';
import { ask, canPrompt, confirm, log, multiSelect, pc, select } from '../ui.js';
import { thisInstall } from './takeover.js';

declare const __CAPMAC_VERSION__: string | undefined;
const VERSION = typeof __CAPMAC_VERSION__ === 'string' ? __CAPMAC_VERSION__ : 'dev';

export interface SkillOptions {
  /** Agent ids (repeatable, or comma-separated); "all" for every agent. */
  agent?: string[];
  global?: boolean;
  /** --project alone: the current project; --project <dir>: that one. */
  project?: string | boolean;
  force?: boolean;
  /** Also add the `capmac` command for new terminals when it is missing (asked in a terminal). */
  command?: boolean;
}

/** A path under the home folder as ~\…, which reads better in a terminal. */
const tilde = (p: string) => {
  const rel = path.relative(os.homedir(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : p;
};

/** The project the terminal is in: a Capacitor app or a git repository (its root), else none. */
function currentProject(): string | undefined {
  const cap = findCapacitorDir(process.cwd());
  const root = skillProjectRoot(cap ?? process.cwd());
  return cap || existsSync(path.join(root, '.git')) ? root : undefined;
}

/** The project the command is about: --project <dir>, --project alone (this folder's), else the one the terminal is in. */
function projectFrom(options: SkillOptions): string | undefined {
  if (typeof options.project === 'string') {
    if (!existsSync(options.project)) throw new UserError(`There is no folder ${options.project}.`);
    return skillProjectRoot(options.project);
  }
  if (options.project) return currentProject() ?? skillProjectRoot(process.cwd());
  return currentProject();
}

function agentIds(options: SkillOptions): string[] | undefined {
  const ids = options.agent?.flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
  return ids?.length ? ids : undefined;
}

async function chooseAgents(options: SkillOptions): Promise<string[]> {
  const given = agentIds(options);
  if (given) return given;
  const agents = skillAgents();
  const detected = agents.filter(isAgentDetected);
  if (!canPrompt()) {
    if (detected.length) return detected.map((a) => a.id);
    throw new UserError('No AI coding agent was found on this PC.', `Name one with --agent (${agents.map((a) => a.id).join(', ')}, or all).`);
  }
  return multiSelect(
    'Which AI agents should know how to use CapMac?',
    agents.map((a) => ({ label: a.name, value: a.id, hint: isAgentDetected(a) ? 'found on this PC' : undefined, selected: isAgentDetected(a) })),
  );
}

async function chooseScope(options: SkillOptions): Promise<{ scope: SkillScope; projectDir?: string }> {
  if (options.global && options.project) throw new UserError('Choose --global or --project, not both.');
  if (options.global) return { scope: 'global' };
  if (options.project) return { scope: 'project', projectDir: projectFrom(options) };
  if (!canPrompt()) throw new UserError('Where should the skill go?', 'Add --global (all your projects) or --project [folder] (one project, to commit for your team).');
  const here = currentProject();
  const choice = await select('Where?', [
    { label: 'All my projects', value: 'global', hint: "in each agent's own folder, just for you" },
    ...(here ? [{ label: `This project (${path.basename(here)})`, value: 'here', hint: `${here}; commit it so your team's agents get it` }] : []),
    { label: here ? 'Another project…' : 'A project…', value: 'other' },
  ]);
  if (choice === 'global') return { scope: 'global' };
  if (choice === 'here' && here) return { scope: 'project', projectDir: here };
  const dir = await ask('Project folder:');
  if (!dir || !existsSync(dir)) throw new UserError(`There is no folder ${dir || '(none given)'}.`);
  return { scope: 'project', projectDir: skillProjectRoot(dir) };
}

function printChanges(changes: SkillChange[], verb: 'add' | 'remove', projectDir?: string): void {
  // Project folders read best relative to the project; global ones with ~ for the home folder.
  const show = (dir: string) => (projectDir && path.resolve(dir).toLowerCase().startsWith(path.resolve(projectDir).toLowerCase()) ? path.relative(projectDir, dir) : tilde(dir));
  for (const c of changes) {
    const who = pc.dim(c.agents.join(', '));
    switch (c.result) {
      case 'written':
      case 'updated':
        log.success(`${c.result === 'written' ? 'Added' : 'Updated'} ${show(c.dir)}  ${who}`);
        break;
      case 'unchanged':
        log.success(`Up to date: ${show(c.dir)}  ${who}`);
        break;
      case 'removed':
        log.success(`Removed ${show(c.dir)}  ${pc.dim(`(was read by ${c.agents.join(', ')})`)}`);
        break;
      case 'absent':
        break;
      case 'skipped-foreign':
        log.warn(`${show(c.dir)} holds a "capmac" skill that CapMac did not write; left alone.${verb === 'add' ? ' Use --force to replace it.' : ''}`);
        break;
    }
  }
}

export async function skillAddCommand(options: SkillOptions): Promise<void> {
  const agents = await chooseAgents(options);
  const { scope, projectDir } = await chooseScope(options);
  const changes = await installSkill({ agents, scope, projectDir, version: VERSION, force: options.force });
  printChanges(changes, 'add', projectDir);
  if (!changes.some((c) => c.result === 'written' || c.result === 'updated' || c.result === 'unchanged')) return;
  await offerCommand(options);
  log.line();
  log.dim('  Agents load skills when a session starts: start a new one to use it.');
  if (scope === 'project') log.dim(`  Commit the new folders in ${projectDir} so your team's agents get it too.`);
}

/** The skill tells agents to run `capmac`: make sure new terminals can (an npm install, or a launcher for this CLI). */
async function offerCommand(options: SkillOptions): Promise<void> {
  if (process.platform !== 'win32' || (await capmacCommandStatus()).found) return;
  const cli = thisInstall().cli;
  if (/[\\/]_npx[\\/]/.test(cli)) {
    log.warn('Agents run `capmac` as a command, and this PC does not have one. Install it with `npm install -g capmac`.');
    return;
  }
  const add = options.command ?? (canPrompt() ? await confirm('Agents run `capmac` as a command, and new terminals cannot find it yet. Add it?') : false);
  if (!add) {
    log.warn('Agents run `capmac` as a command, and new terminals cannot find it yet.');
    log.dim('  Add it with `capmac skill add --command`, or install it with `npm install -g capmac`.');
    return;
  }
  await installCapmacCommand(cli);
  log.success(`Added the capmac command (${tilde(capmacCommandDir())}, on your PATH for new terminals)`);
}

export async function skillRemoveCommand(options: SkillOptions): Promise<void> {
  const agents = await chooseAgents({ ...options, agent: agentIds(options) ?? ['all'] });
  const { scope, projectDir } = await chooseScope(options);
  const changes = await removeSkill({ agents, scope, projectDir });
  printChanges(changes, 'remove', projectDir);
  if (changes.every((c) => c.result === 'absent')) log.dim('Nothing to remove: the CapMac skill is not installed there.');
  if (options.command) {
    await removeCapmacCommand();
    log.success(`Removed the capmac command (${tilde(capmacCommandDir())}) and its PATH entry`);
  }
}

function cell(place: SkillPlace | null, seen: boolean): string {
  if (!place) return '';
  if (place.state === 'installed') return pc.green('✔ installed');
  if (place.state === 'outdated') return pc.yellow(`↑ ${place.version} (update)`);
  if (place.state === 'foreign') return pc.yellow('another "capmac" skill');
  return seen ? pc.green('✔ via a shared folder') : pc.dim('—');
}

export async function skillStatusCommand(options: SkillOptions): Promise<void> {
  const project = projectFrom(options);
  const rows: AgentSkillStatus[] = await skillStatus(VERSION, project);
  const width = Math.max(...rows.map((r) => r.name.length)) + 2;
  log.line(`${pc.bold('CapMac skill for AI coding agents')} ${pc.dim(`(v${VERSION})`)}`);
  log.line(pc.dim(`  ${'Agent'.padEnd(width)}${'On this PC'.padEnd(13)}${'All projects'.padEnd(24)}${project ? `This project (${path.basename(project)})` : ''}`));
  for (const r of rows) {
    const global = cell(r.global, r.seenGlobal);
    log.line(`  ${r.name.padEnd(width)}${pad(r.detected ? pc.green('found') : pc.dim('—'), 13)}${pad(global, 24)}${cell(r.project, r.seenInProject)}`);
  }
  log.line();
  log.dim(`  Add it:     capmac skill add            ${pc.dim('(asks which agents and where)')}`);
  log.dim('              capmac skill add --agent claude-code,codex --global');
  log.dim('              capmac skill add --agent all --project');
  log.dim('  Remove it:  capmac skill remove --global   ·   See it: capmac skill show');
}

/** Pads to a width counted without colour codes. */
const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - s.replace(/\x1b\[[0-9;]*m/g, '').length));

/** Prints SKILL.md, for agents capmac does not know (paste it wherever they read instructions). */
export async function skillShowCommand(): Promise<void> {
  process.stdout.write(skillFiles(VERSION)['SKILL.md']!);
}
