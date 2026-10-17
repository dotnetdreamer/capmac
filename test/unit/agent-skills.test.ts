import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screenshotTarget } from '../../packages/cli/src/commands/screenshot.js';
import {
  findSkillAgent,
  installSkill,
  isAgentUsedIn,
  isNewerVersion,
  removeSkill,
  skillAgents,
  skillPlan,
  skillProjectRoot,
  skillStatus,
} from '../../packages/core/src/engine/agent-skills.js';
import {
  capmacCommandDir,
  capmacCommandStatus,
  installCapmacCommand,
  launcherFiles,
  pathEnvironment,
  pathWith,
  pathWithout,
  removeCapmacCommand,
} from '../../packages/core/src/engine/capmac-command.js';
import { SKILL_NAME, skillFiles } from '../../packages/core/src/engine/skill-content.js';
import type { TargetsResult } from '../../packages/core/src/shared/protocol.js';

describe('the skill follows the Agent Skills format', () => {
  const files = skillFiles('1.2.3');
  const skill = files['SKILL.md']!;
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const field = (name: string) => front.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1];

  it('has a valid name that matches its folder', () => {
    expect(field('name')).toBe(SKILL_NAME);
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(SKILL_NAME.length).toBeLessThanOrEqual(64);
  });

  it('says what it does and when to use it, within 1024 characters', () => {
    const description = field('description')!;
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use when/);
  });

  it('stays short, carries its version, and links its reference by a relative path', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
    expect(skill).toContain('capmac-skill-version: 1.2.3');
    expect(skill).toContain('(references/commands.md)');
    expect(files['references/commands.md']).toContain('capmac screenshot');
  });

  it('teaches commands that finish, and leaves passwords to the user', () => {
    expect(skill).toContain('capmac run --no-logs');
    expect(skill).toContain('capmac run --for 20');
    expect(skill).toMatch(/never ask for or type/);
  });
});

describe('installing the skill', () => {
  let dir: string;
  let home: string;
  let project: string;
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-skills-'));
    home = path.join(dir, 'home');
    project = path.join(dir, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(path.join(project, '.git'), { recursive: true });
    mkdirSync(path.join(project, 'apps', 'mobile'), { recursive: true });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    for (const key of ['XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME']) delete process.env[key];
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('knows agents by id or name, and which are on this PC', async () => {
    expect(findSkillAgent('claude')?.id).toBe('claude-code');
    expect(findSkillAgent('Gemini CLI')?.id).toBe('gemini');
    const status = await skillStatus('1.0.0');
    expect(status.filter((s) => s.detected).map((s) => s.id)).toEqual(['claude-code', 'codex']);
  });

  it('writes each folder once: .claude for Claude Code, the shared .agents for the rest', async () => {
    const changes = await installSkill({ agents: ['claude-code', 'codex', 'cursor', 'gemini'], scope: 'global', version: '1.0.0' });
    expect(changes.map((c) => [path.relative(home, c.dir), c.result])).toEqual([
      [path.join('.claude', 'skills', 'capmac'), 'written'],
      [path.join('.agents', 'skills', 'capmac'), 'written'],
    ]);
    expect(changes[1]!.agents).toEqual(expect.arrayContaining(['Codex', 'Cursor', 'Gemini CLI', 'GitHub Copilot']));
    expect(existsSync(path.join(home, '.agents', 'skills', 'capmac', 'references', 'commands.md'))).toBe(true);
    const again = await installSkill({ agents: ['claude-code'], scope: 'global', version: '1.0.0' });
    expect(again[0]!.result).toBe('unchanged');
  });

  it('reports who sees it, directly or through a shared folder, and offers updates', async () => {
    await installSkill({ agents: ['codex'], scope: 'global', version: '1.0.0' });
    const status = await skillStatus('1.1.0');
    const of = (id: string) => status.find((s) => s.id === id)!;
    expect(of('codex').global.state).toBe('outdated');
    // Cursor reads the same shared folder: it sees the (older) skill, and gets the update offered too.
    expect(of('cursor').global.state).toBe('outdated');
    expect(of('cursor').seenGlobal).toBe(true);
    expect(of('claude-code').seenGlobal).toBe(false);
    await installSkill({ agents: ['codex'], scope: 'global', version: '1.1.0' });
    const now = await skillStatus('1.1.0');
    expect(now.find((s) => s.id === 'cursor')!.global.state).toBe('installed');
  });

  it('puts project skills at the repository root, for every chosen agent', async () => {
    const app = path.join(project, 'apps', 'mobile');
    expect(skillProjectRoot(app)).toBe(project);
    const changes = await installSkill({ agents: ['claude-code', 'codex', 'windsurf'], scope: 'project', projectDir: app, version: '1.0.0' });
    expect(changes.map((c) => path.relative(project, c.dir))).toEqual([
      path.join('.claude', 'skills', 'capmac'),
      path.join('.agents', 'skills', 'capmac'),
      path.join('.windsurf', 'skills', 'capmac'),
    ]);
    const status = await skillStatus('1.0.0', app);
    expect(status.find((s) => s.id === 'junie')!.seenInProject).toBe(true); // reads .agents/skills
  });

  it('never overwrites or removes a "capmac" skill it did not write', async () => {
    const theirs = path.join(home, '.claude', 'skills', 'capmac');
    mkdirSync(theirs, { recursive: true });
    writeFileSync(path.join(theirs, 'SKILL.md'), '---\nname: capmac\ndescription: my own\n---\nhello\n');
    expect((await installSkill({ agents: ['claude-code'], scope: 'global', version: '1.0.0' }))[0]!.result).toBe('skipped-foreign');
    expect((await removeSkill({ agents: ['claude-code'], scope: 'global' }))[0]!.result).toBe('skipped-foreign');
    expect(readFileSync(path.join(theirs, 'SKILL.md'), 'utf8')).toContain('my own');
    expect((await installSkill({ agents: ['claude-code'], scope: 'global', version: '1.0.0', force: true }))[0]!.result).toBe('updated');
  });

  it('removes only its own copies, and says who read them', async () => {
    await installSkill({ agents: ['all'], scope: 'global', version: '1.0.0' });
    const removed = await removeSkill({ agents: ['codex'], scope: 'global' });
    expect(removed[0]!.result).toBe('removed');
    expect(removed[0]!.agents).toContain('Cursor');
    expect(existsSync(path.join(home, '.agents', 'skills', 'capmac'))).toBe(false);
    expect(existsSync(path.join(home, '.claude', 'skills', 'capmac'))).toBe(true);
  });

  it('takes away the folders it made, and only when nothing else is in them', async () => {
    mkdirSync(path.join(project, '.claude'));
    writeFileSync(path.join(project, '.claude', 'settings.json'), '{}');
    await installSkill({ agents: ['claude-code', 'codex'], scope: 'project', projectDir: project, version: '1.0.0' });
    await removeSkill({ agents: ['claude-code', 'codex'], scope: 'project', projectDir: project });
    expect(existsSync(path.join(project, '.agents'))).toBe(false);
    expect(existsSync(path.join(project, '.claude', 'skills'))).toBe(false);
    expect(existsSync(path.join(project, '.claude', 'settings.json'))).toBe(true);
  });

  it('rejects unknown agents', async () => {
    await expect(installSkill({ agents: ['notepad'], scope: 'global', version: '1.0.0' })).rejects.toThrow(/does not know the agent/);
    expect(skillAgents().length).toBeGreaterThanOrEqual(13);
  });

  it('says what it would find before it writes: missing, current, changed, older, newer or someone else’s', async () => {
    const plan = (version = '1.1.0') => skillPlan({ agents: ['claude-code', 'codex', 'gemini'], scope: 'project', projectDir: path.join(project, 'apps', 'mobile'), version });
    expect((await plan()).map((e) => [path.relative(project, e.dir), e.state, e.agents])).toEqual([
      [path.join('.claude', 'skills', 'capmac'), 'missing', ['claude-code']],
      [path.join('.agents', 'skills', 'capmac'), 'missing', ['codex', 'gemini']],
    ]);
    expect((await plan())[1]!.readers).toEqual(expect.arrayContaining(['Codex', 'Gemini CLI', 'Antigravity', 'GitHub Copilot']));
    await installSkill({ agents: ['claude-code', 'codex'], scope: 'project', projectDir: project, version: '1.1.0' });
    expect((await plan()).map((e) => e.state)).toEqual(['current', 'current']);
    expect((await plan('1.2.0')).map((e) => [e.state, e.version])).toEqual([['older', '1.1.0'], ['older', '1.1.0']]);
    expect((await plan('1.0.9')).map((e) => e.state)).toEqual(['newer', 'newer']);
    appendFileSync(path.join(project, '.claude', 'skills', 'capmac', 'SKILL.md'), '\nAsk before pushing.\n');
    writeFileSync(path.join(project, '.agents', 'skills', 'capmac', 'SKILL.md'), '---\nname: capmac\ndescription: our own\n---\n');
    expect((await plan()).map((e) => e.state)).toEqual(['changed', 'foreign']);
    // Planning writes nothing.
    expect(readFileSync(path.join(project, '.claude', 'skills', 'capmac', 'SKILL.md'), 'utf8')).toContain('Ask before pushing.');
  });

  it('compares versions as numbers, and a dev build is never the newer one', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '0.10.0')).toBe(false);
    expect(isNewerVersion('dev', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.1.1', 'dev')).toBe(false);
  });

  it('tells which agents a project uses from their files', () => {
    writeFileSync(path.join(project, 'CLAUDE.md'), '# Notes for Claude');
    writeFileSync(path.join(project, 'GEMINI.md'), '');
    mkdirSync(path.join(project, '.github', 'instructions'), { recursive: true });
    expect(skillAgents().filter((a) => isAgentUsedIn(a, project)).map((a) => a.id)).toEqual(['claude-code', 'copilot', 'gemini']);
  });

  it('installs for Antigravity in its own folders, and in the shared folder in a project', async () => {
    const changes = await installSkill({ agents: ['antigravity', 'antigravity-cli'], scope: 'global', version: '1.0.0' });
    expect(changes.map((c) => path.relative(home, c.dir))).toEqual([path.join('.gemini', 'config', 'skills', 'capmac'), path.join('.gemini', 'antigravity-cli', 'skills', 'capmac')]);
    const inProject = await installSkill({ agents: ['antigravity'], scope: 'project', projectDir: project, version: '1.0.0' });
    expect(path.relative(project, inProject[0]!.dir)).toBe(path.join('.agents', 'skills', 'capmac'));
    expect(findSkillAgent('antigravity')?.id).toBe('antigravity');
  });
});

describe('the capmac command for new terminals', () => {
  let dir: string;
  let userPath: string;
  const savedEnv = { LOCALAPPDATA: process.env.LOCALAPPDATA, PATH: process.env.PATH };
  const savedPath = { read: pathEnvironment.read, writeUser: pathEnvironment.writeUser };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capmac-command-'));
    process.env.LOCALAPPDATA = path.join(dir, 'Local');
    process.env.PATH = '';
    userPath = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools';
    pathEnvironment.read = async () => ({ user: userPath, machine: '' });
    pathEnvironment.writeUser = async (value) => {
      userPath = value;
    };
  });
  afterEach(() => {
    Object.assign(pathEnvironment, savedPath);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('edits PATH without duplicates and keeps %VAR% entries', () => {
    expect(pathWith('C:\\a;%USERPROFILE%\\b', 'C:\\new')).toBe('C:\\a;%USERPROFILE%\\b;C:\\new');
    expect(pathWith('C:\\a;c:\\NEW\\', 'C:\\new')).toBe('C:\\a;c:\\NEW\\');
    expect(pathWith('', 'C:\\new')).toBe('C:\\new');
    expect(pathWithout('C:\\a;C:\\new;%X%\\b', 'c:\\new\\')).toBe('C:\\a;%X%\\b');
    expect(pathWithout('C:\\a;C:\\b', 'C:\\new')).toBe('C:\\a;C:\\b');
  });

  it('gives back the exact PATH text after adding and removing', () => {
    for (const original of ['C:\\a;C:\\b', 'C:\\a;C:\\b;', 'C:\\a;;%X%\\b;', '']) {
      expect(pathWithout(pathWith(original, 'C:\\new'), 'C:\\new')).toBe(original);
    }
  });

  it('writes launchers for cmd/PowerShell and Git Bash', () => {
    const files = launcherFiles('C:\\Program Files\\capmac Studio\\resources\\cli\\cli.mjs');
    expect(files['capmac.cmd']).toContain('node "C:\\Program Files\\capmac Studio\\resources\\cli\\cli.mjs" %*');
    expect(files['capmac.cmd']).toContain('if not exist');
    expect(files.capmac).toContain('exec node "C:/Program Files/capmac Studio/resources/cli/cli.mjs" "$@"');
  });

  it.skipIf(process.platform !== 'win32')('adds itself to the user PATH once, and goes away cleanly', async () => {
    const cli = path.join(dir, 'cli.mjs');
    writeFileSync(cli, '');
    expect((await capmacCommandStatus()).found).toBeNull();
    const added = await installCapmacCommand(cli);
    expect(added.ours).toBe(true);
    expect(added.found).toBe(path.join(capmacCommandDir(), 'capmac.cmd'));
    expect(userPath).toBe(`%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools;${capmacCommandDir()}`);
    await installCapmacCommand(cli);
    expect(userPath.split(';').length).toBe(3);
    const removed = await removeCapmacCommand();
    expect(removed.found).toBeNull();
    expect(userPath).toBe('%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools');
    expect(existsSync(capmacCommandDir())).toBe(false);
  });
});

describe('screenshot target', () => {
  const sim = (udid: string, name: string, state: string) => ({ kind: 'simulator' as const, udid, name, os: 'iOS 26.5', osVersion: '26.5', state, available: true });
  const all: TargetsResult = {
    simulators: [sim('IPAD', 'iPad Air', 'Booted'), sim('A', 'iPhone 17', 'Booted'), sim('B', 'iPhone 17 Pro', 'Booted'), sim('C', 'iPhone Air', 'Shutdown')],
    devices: [],
    deviceSupport: true,
  } as unknown as TargetsResult;

  it('prefers the booted simulator this app last ran on, then a booted iPhone', () => {
    expect(screenshotTarget(all, undefined, 'B').udid).toBe('B');
    expect(screenshotTarget(all, undefined, 'C').udid).toBe('A');
    expect(screenshotTarget(all, undefined, undefined).udid).toBe('A');
  });

  it('explains when the simulator asked for is not running, or none is', () => {
    expect(() => screenshotTarget(all, 'iPhone Air', undefined)).toThrow(/not running/);
    expect(() => screenshotTarget({ ...all, simulators: [sim('C', 'iPhone Air', 'Shutdown')] } as TargetsResult, undefined, undefined)).toThrow(/No simulator is running/);
  });

  it('photographs a plugged-in iPhone asked for by name or with --device', () => {
    const phone = { kind: 'device' as const, udid: 'PHONE', name: 'IK 14 Pro Max', os: 'iOS 26.6.2', osVersion: '26.6.2', state: 'available', available: true, connection: 'usb' as const };
    const withPhone = { ...all, devices: [phone] } as unknown as TargetsResult;
    expect(screenshotTarget(withPhone, 'IK 14 Pro Max', undefined).udid).toBe('PHONE');
    expect(screenshotTarget(withPhone, undefined, 'B', true).udid).toBe('PHONE');
    // Without asking, a booted simulator still comes first.
    expect(screenshotTarget(withPhone, undefined, undefined).udid).toBe('A');
    expect(() => screenshotTarget(all, undefined, undefined, true)).toThrow(/No iPhone or iPad/);
  });
});
