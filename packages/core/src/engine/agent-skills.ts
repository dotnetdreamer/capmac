/**
 * Installs the capmac skill (see skill-content.ts) for AI coding agents, for
 * all of a user's projects (global) or inside one project, so the agent knows
 * how to use the capmac CLI.
 *
 * Every agent below reads the Agent Skills format (a folder with SKILL.md).
 * Most of them also read the shared `.agents/skills` folder, so one copy there
 * serves many; Claude Code reads only `.claude/skills`. Folders as documented
 * by each vendor in October 2026.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './errors.js';
import type { AgentSkillStatus, SkillChange, SkillPlace, SkillScope, SkillState } from '../shared/skills.js';
import { SKILL_MARKER, SKILL_NAME, skillFiles } from './skill-content.js';

export type { AgentSkillStatus, SkillChange, SkillPlace, SkillScope, SkillState } from '../shared/skills.js';

export interface SkillAgent {
  id: string;
  name: string;
  /** Where capmac installs the skill for this agent: a folder that holds skill folders. */
  install: { global: string; project: string };
  /** Every skills folder the agent reads (install folders included), to tell whether it already sees the skill. */
  reads: { global: string[]; project: string[] };
  /** Config folders whose presence means the agent is used on this PC. */
  detect: string[];
}

const home = () => os.homedir();
const appData = () => process.env.APPDATA ?? path.join(home(), 'AppData', 'Roaming');
const xdgConfig = () => process.env.XDG_CONFIG_HOME ?? path.join(home(), '.config');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(home(), '.claude');
const codexHome = () => process.env.CODEX_HOME ?? path.join(home(), '.codex');
const shared = () => path.join(home(), '.agents', 'skills');
const SHARED_PROJECT = '.agents/skills';

/** The agents capmac can install the skill for, most used first. */
export function skillAgents(): SkillAgent[] {
  const h = home();
  const vscodeStorage = path.join(appData(), 'Code', 'User', 'globalStorage');
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      install: { global: path.join(claudeDir(), 'skills'), project: '.claude/skills' },
      reads: { global: [path.join(claudeDir(), 'skills')], project: ['.claude/skills'] },
      detect: [claudeDir()],
    },
    {
      id: 'codex',
      name: 'Codex',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: { global: [shared(), path.join(codexHome(), 'skills')], project: [SHARED_PROJECT, '.codex/skills'] },
      detect: [codexHome()],
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: {
        global: [shared(), path.join(process.env.COPILOT_HOME ?? path.join(h, '.copilot'), 'skills'), path.join(claudeDir(), 'skills')],
        project: [SHARED_PROJECT, '.github/skills', '.claude/skills'],
      },
      detect: [process.env.COPILOT_HOME ?? path.join(h, '.copilot'), path.join(appData(), 'Code', 'User')],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: {
        global: [shared(), path.join(h, '.cursor', 'skills'), path.join(claudeDir(), 'skills'), path.join(codexHome(), 'skills')],
        project: [SHARED_PROJECT, '.cursor/skills', '.claude/skills', '.codex/skills'],
      },
      detect: [path.join(h, '.cursor')],
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: { global: [shared(), path.join(h, '.gemini', 'skills')], project: [SHARED_PROJECT, '.gemini/skills'] },
      detect: [path.join(h, '.gemini')],
    },
    {
      id: 'windsurf',
      name: 'Windsurf (Devin Desktop)',
      install: { global: path.join(h, '.codeium', 'windsurf', 'skills'), project: '.windsurf/skills' },
      reads: {
        global: [path.join(h, '.codeium', 'windsurf', 'skills'), path.join(xdgConfig(), 'devin', 'skills')],
        project: ['.windsurf/skills', '.devin/skills', SHARED_PROJECT],
      },
      detect: [path.join(h, '.codeium', 'windsurf'), path.join(xdgConfig(), 'devin')],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      install: { global: path.join(xdgConfig(), 'opencode', 'skills'), project: SHARED_PROJECT },
      reads: { global: [path.join(xdgConfig(), 'opencode', 'skills')], project: [SHARED_PROJECT, '.opencode/skills', '.claude/skills'] },
      detect: [path.join(xdgConfig(), 'opencode')],
    },
    {
      id: 'cline',
      name: 'Cline',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: { global: [shared(), path.join(h, '.cline', 'skills')], project: [SHARED_PROJECT, '.cline/skills', '.clinerules/skills', '.claude/skills'] },
      detect: [path.join(h, '.cline'), path.join(vscodeStorage, 'saoudrizwan.claude-dev')],
    },
    {
      id: 'kilo',
      name: 'Kilo Code',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: { global: [shared(), path.join(h, '.kilo', 'skills')], project: [SHARED_PROJECT, '.kilo/skills'] },
      detect: [path.join(h, '.kilo'), path.join(xdgConfig(), 'kilo'), path.join(h, '.kilocode'), path.join(vscodeStorage, 'kilocode.kilo-code')],
    },
    {
      id: 'amp',
      name: 'Amp',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: {
        global: [shared(), path.join(xdgConfig(), 'agents', 'skills'), path.join(xdgConfig(), 'amp', 'skills'), path.join(claudeDir(), 'skills')],
        project: [SHARED_PROJECT, '.claude/skills'],
      },
      detect: [path.join(xdgConfig(), 'amp')],
    },
    {
      id: 'augment',
      name: 'Augment',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: { global: [shared(), path.join(h, '.augment', 'skills'), path.join(claudeDir(), 'skills')], project: [SHARED_PROJECT, '.augment/skills', '.claude/skills'] },
      detect: [path.join(h, '.augment')],
    },
    {
      id: 'goose',
      name: 'Goose',
      install: { global: shared(), project: SHARED_PROJECT },
      reads: { global: [shared(), path.join(claudeDir(), 'skills')], project: [SHARED_PROJECT, '.goose/skills', '.claude/skills'] },
      detect: [path.join(appData(), 'Block', 'goose'), path.join(xdgConfig(), 'goose')],
    },
    {
      id: 'junie',
      name: 'JetBrains Junie',
      install: { global: path.join(h, '.junie', 'skills'), project: SHARED_PROJECT },
      reads: { global: [path.join(h, '.junie', 'skills')], project: [SHARED_PROJECT, '.junie/skills'] },
      detect: [path.join(h, '.junie')],
    },
  ];
}

export function findSkillAgent(id: string): SkillAgent | undefined {
  const wanted = id.toLowerCase();
  return skillAgents().find((a) => a.id === wanted || a.name.toLowerCase() === wanted || a.id.split('-')[0] === wanted);
}

export function isAgentDetected(agent: SkillAgent): boolean {
  return agent.detect.some((dir) => existsSync(dir));
}

/** Skills go at the root of the repository (agents search from there), else in the folder itself. */
export function skillProjectRoot(dir: string): string {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dir);
    current = parent;
  }
}

function resolveFolder(folder: string, scope: SkillScope, projectRoot?: string): string {
  if (scope === 'global') return folder;
  if (!projectRoot) throw new Error('A project folder is needed for project skills.');
  return path.join(projectRoot, ...folder.split('/'));
}

/** Reads one skill folder: ours (with its version), someone else's skill named capmac, or nothing. */
async function inspect(skillDir: string): Promise<{ state: SkillState; version?: string }> {
  let text: string;
  try {
    text = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return { state: 'missing' };
  }
  const version = text.match(new RegExp(`${SKILL_MARKER}\\s*([^\\s>]+)`))?.[1];
  if (!version) return { state: 'foreign' };
  return { state: 'installed', version };
}

async function place(folder: string, current: string): Promise<SkillPlace> {
  const dir = path.join(folder, SKILL_NAME);
  const found = await inspect(dir);
  return { dir, state: found.state === 'installed' && found.version !== current ? 'outdated' : found.state, version: found.version };
}

/** Where the skill is, for every agent: in its global folder and (given a project) in the project. */
export async function skillStatus(version: string, projectDir?: string): Promise<AgentSkillStatus[]> {
  const root = projectDir ? skillProjectRoot(projectDir) : undefined;
  const seen = async (folders: string[], scope: SkillScope) => {
    for (const folder of folders) {
      const found = await inspect(path.join(resolveFolder(folder, scope, root), SKILL_NAME));
      if (found.state === 'installed') return true;
    }
    return false;
  };
  return Promise.all(
    skillAgents().map(async (agent) => ({
      id: agent.id,
      name: agent.name,
      detected: isAgentDetected(agent),
      global: await place(agent.install.global, version),
      project: root ? await place(resolveFolder(agent.install.project, 'project', root), version) : null,
      seenGlobal: await seen(agent.reads.global, 'global'),
      seenInProject: root ? await seen(agent.reads.project, 'project') : false,
    })),
  );
}

function selectAgents(ids: string[]): SkillAgent[] {
  if (ids.length === 0) throw new UserError('Choose at least one agent.', `Agents: ${skillAgents().map((a) => a.id).join(', ')}, or "all".`);
  if (ids.includes('all')) return skillAgents();
  return ids.map((id) => {
    const agent = findSkillAgent(id);
    if (!agent) throw new UserError(`CapMac does not know the agent "${id}".`, `Agents: ${skillAgents().map((a) => a.id).join(', ')}, or "all".`);
    return agent;
  });
}

/** The skill folders a change touches, each once, however many chosen agents share it. */
function targetDirs(ids: string[], scope: SkillScope, root?: string): string[] {
  return [...new Set(selectAgents(ids).map((agent) => path.join(resolveFolder(agent.install[scope], scope, root), SKILL_NAME)))];
}

/** Every agent (chosen or not) that reads a skills folder: what an install there serves, or a removal takes away. */
function readersOf(skillDir: string, scope: SkillScope, root?: string): string[] {
  const folder = path.dirname(skillDir).toLowerCase();
  return skillAgents()
    .filter((agent) => agent.reads[scope].some((f) => resolveFolder(f, scope, root).toLowerCase() === folder))
    .map((agent) => agent.name);
}

/**
 * Writes the skill for these agents. A folder already holding someone else's
 * `capmac` skill is left alone unless `force`.
 */
export async function installSkill(options: { agents: string[]; scope: SkillScope; projectDir?: string; version: string; force?: boolean }): Promise<SkillChange[]> {
  const root = options.scope === 'project' ? skillProjectRoot(options.projectDir ?? process.cwd()) : undefined;
  const files = skillFiles(options.version);
  const changes: SkillChange[] = [];
  for (const dir of targetDirs(options.agents, options.scope, root)) {
    const before = await inspect(dir);
    const agents = readersOf(dir, options.scope, root);
    if (before.state === 'foreign' && !options.force) {
      changes.push({ dir, agents, result: 'skipped-foreign' });
      continue;
    }
    if (before.state === 'installed' && before.version === options.version) {
      const same = await Promise.all(Object.entries(files).map(async ([rel, text]) => (await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null)) === text));
      if (same.every(Boolean)) {
        changes.push({ dir, agents, result: 'unchanged' });
        continue;
      }
    }
    // Ours (or forced): start clean so files from an older version do not linger.
    if (before.state !== 'missing') await fs.rm(dir, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(dir, ...rel.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }
    changes.push({ dir, agents, result: before.state === 'missing' ? 'written' : 'updated' });
  }
  return changes;
}

/** Removes capmac's skill for these agents; never a skill capmac did not write. */
export async function removeSkill(options: { agents: string[]; scope: SkillScope; projectDir?: string }): Promise<SkillChange[]> {
  const root = options.scope === 'project' ? skillProjectRoot(options.projectDir ?? process.cwd()) : undefined;
  const changes: SkillChange[] = [];
  for (const dir of targetDirs(options.agents, options.scope, root)) {
    const before = await inspect(dir);
    const agents = readersOf(dir, options.scope, root);
    if (before.state === 'missing') changes.push({ dir, agents, result: 'absent' });
    else if (before.state === 'foreign') changes.push({ dir, agents, result: 'skipped-foreign' });
    else {
      await fs.rm(dir, { recursive: true, force: true });
      changes.push({ dir, agents, result: 'removed' });
    }
  }
  return changes;
}
