/**
 * CapMac's skill for AI coding agents (core's agent-skills.ts), from VS Code.
 * It goes in by itself, as `capmac.agents.addSkill` says: into each project CapMac
 * finds an app in (the default), or once for all projects. It goes in for the
 * agents CapMac finds: this editor when it is one (Cursor, Windsurf,
 * Antigravity), the agents' extensions in it (Claude Code, Codex, Gemini…),
 * the ones the project's own files name (CLAUDE.md, AGENTS.md, GEMINI.md…)
 * and the ones set up on this PC. A skill already there is never replaced
 * without asking, and each project gets it once: one the user removes (by hand,
 * or with **CapMac: Remove the CapMac Skill for AI Agents…**) stays removed
 * until **CapMac: Add the CapMac Skill for AI Agents…** adds it again.
 */
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  installSkill,
  isAgentDetected,
  isAgentUsedIn,
  removeSkill,
  skillAgents,
  skillPlan,
  skillProjectRoot,
  skillStatus,
  type AgentSkillStatus,
  type SkillPlanEntry,
  type SkillScope,
} from '@capmac/core/engine/agent-skills';
import { s, studio } from './i18n.js';
import type { Model } from './state/model.js';
import { editorAgents, keyOf, skillSteps, type AgentReason } from './state/pure.js';

declare const __CAPMAC_VERSION__: string | undefined;
/** What the copies are marked with: CapMac's version (the CLI and CapMac Studio are on the same one). */
const VERSION = typeof __CAPMAC_VERSION__ === 'string' ? __CAPMAC_VERSION__ : 'dev';

/** Projects (their root, as keyOf) the skill was looked at in, with the CapMac version that did it. */
const STATE_PROJECTS = 'capmac.skill.projects';
/** The user profile: the CapMac version that last looked at its skill, and whether it added it there. */
const STATE_PROFILE = 'capmac.skill.profile';

type AddMode = 'project' | 'global' | 'off';

/** The agents CapMac finds, each with why: the editor first, then its extensions, the project, this PC. */
export function detectAgents(projectRoot?: string): Map<string, AgentReason[]> {
  const found = editorAgents(vscode.env.appName, vscode.env.uriScheme, vscode.extensions.all.map((e) => e.id));
  for (const agent of skillAgents()) {
    const reasons = found.get(agent.id) ?? [];
    if (projectRoot && isAgentUsedIn(agent, projectRoot)) reasons.push('project');
    if (isAgentDetected(agent)) reasons.push('pc');
    if (reasons.length) found.set(agent.id, reasons);
  }
  return found;
}

/** The projects (repository roots, where agents look for skills) of the apps CapMac runs here. */
function appRoots(model: Model): string[] {
  const roots = new Map<string, string>();
  for (const app of model.runnableApps()) {
    const root = skillProjectRoot(app.project.dir);
    roots.set(keyOf(root), root);
  }
  return [...roots.values()];
}

const names = (ids: string[]) => s.skill.list([...new Set(ids)].map((id) => skillAgents().find((a) => a.id === id)?.name ?? id));

/** A skill folder as people read it: from the project's root, or from the home folder (~). */
function shortPath(dir: string, root?: string): string {
  const from = root ?? os.homedir();
  const rel = path.relative(from, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return dir;
  return root ? rel : `~${path.sep}${rel}`;
}

async function showSkill(dir: string): Promise<void> {
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'SKILL.md')), { preview: true });
}

async function rememberProject(context: vscode.ExtensionContext, root: string): Promise<void> {
  await context.globalState.update(STATE_PROJECTS, { ...context.globalState.get<Record<string, string>>(STATE_PROJECTS, {}), [keyOf(root)]: VERSION });
}

/** The copies one look wrote by itself, in a project or the user profile: one notification says so, and its Undo removes them. */
interface Added {
  scope: SkillScope;
  root?: string;
  entries: SkillPlanEntry[];
}

/** Adds the skill by itself, as `capmac.agents.addSkill` says, each time CapMac finds the apps of this workspace. */
export function registerSkill(context: vscode.ExtensionContext, model: Model, output: vscode.LogOutputChannel): void {
  const looked = new Set<string>();
  let profileLooked = false;
  let queue = Promise.resolve();
  const look = () => {
    queue = queue
      .then(async () => {
        const mode = vscode.workspace.getConfiguration('capmac').get<AddMode>('agents.addSkill', 'project');
        if (mode === 'off') return;
        const added: Added[] = [];
        if (!profileLooked) {
          profileLooked = true;
          await lookAtProfile(context, mode === 'global', added);
        }
        if (mode === 'project') {
          for (const root of appRoots(model)) {
            if (looked.has(keyOf(root))) continue;
            looked.add(keyOf(root));
            await lookAtProject(context, root, added);
          }
        }
        if (added.length) announce(added);
      })
      .catch((err) => output.warn(`The CapMac skill: ${(err as Error).message}`));
  };
  context.subscriptions.push(
    model.onDidChange((change) => change === 'apps' && !model.detecting && look()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('capmac.agents.addSkill')) return;
      profileLooked = false;
      looked.clear();
      look();
    }),
  );
}

/** The folders that the agents CapMac finds, and that don't see a CapMac skill yet (here or for all projects), would get it in. */
async function wantedFolders(scope: SkillScope, root?: string): Promise<SkillPlanEntry[]> {
  const found = detectAgents(root);
  if (!found.size) return [];
  const status = await skillStatus(VERSION, root);
  const without = status.filter((a) => found.has(a.id) && !a.seenGlobal && !(scope === 'project' && a.seenInProject)).map((a) => a.id);
  return without.length ? skillPlan({ agents: without, scope, projectDir: root, version: VERSION }) : [];
}

/** A project CapMac found an app in: the skill the first time, then an update offer with each new version. */
async function lookAtProject(context: vscode.ExtensionContext, root: string, added: Added[]): Promise<void> {
  const before = context.globalState.get<Record<string, string>>(STATE_PROJECTS, {})[keyOf(root)];
  if (before === VERSION) return;
  await rememberProject(context, root);
  const first = before === undefined;
  const wanted = first ? await wantedFolders('project', root) : [];
  const every = await skillPlan({ agents: ['all'], scope: 'project', projectDir: root, version: VERSION });
  await carryOut(skillSteps(first, wanted, every), 'project', root, added);
}

/** The user profile: the skill once when `capmac.agents.addSkill` is "global", and an update offer with each new version. */
async function lookAtProfile(context: vscode.ExtensionContext, add: boolean, added: Added[]): Promise<void> {
  const record = context.globalState.get<{ version?: string; added?: boolean }>(STATE_PROFILE, {});
  const adding = add && !record.added;
  const checking = record.version !== VERSION;
  if (!adding && !checking) return;
  await context.globalState.update(STATE_PROFILE, { version: VERSION, added: Boolean(record.added) || adding });
  const wanted = adding ? await wantedFolders('global') : [];
  const every = checking ? await skillPlan({ agents: ['all'], scope: 'global', version: VERSION }) : [];
  await carryOut(skillSteps(adding, wanted, every), 'global', undefined, added);
}

/** Writes what is missing (for `announce`), then asks about what is there. */
async function carryOut(steps: ReturnType<typeof skillSteps>, scope: SkillScope, root: string | undefined, added: Added[]): Promise<void> {
  if (steps.write.length) {
    await installSkill({ agents: steps.write.flatMap((e) => e.agents), scope, projectDir: root, version: VERSION });
    added.push({ scope, root, entries: steps.write });
  }
  const there = [...steps.replace, ...steps.update];
  if (!there.length) return;
  // Only CapMac's own older copies: an update. Someone else's skill named capmac: a replacement.
  const project = root ? path.basename(root) : null;
  const update = !steps.replace.length;
  const message = update ? (project ? s.skill.olderProject(project) : s.skill.olderProfile) : project ? s.skill.foreignProject(project) : s.skill.foreignProfile;
  const yes = update ? s.skill.update : s.skill.replace;
  void vscode.window.showInformationMessage(message, yes, s.skill.keepOne).then(async (answer) => {
    if (answer !== yes) return;
    try {
      await installSkill({ agents: there.flatMap((e) => e.agents), scope, projectDir: root, version: VERSION, force: true });
      vscode.window.setStatusBarMessage(`$(check) ${update ? s.skill.updated : s.skill.replaced}`, 4000);
    } catch (err) {
      void vscode.window.showErrorMessage(s.skill.failed, { detail: (err as Error).message } as vscode.MessageOptions);
    }
  });
}

/** One notification for everything a look added (several projects of a workspace at once), with Show and Undo. */
function announce(added: Added[]): void {
  const who = names(added.flatMap((a) => a.entries.flatMap((e) => e.agents)));
  const projects = added.flatMap((a) => (a.root ? [path.basename(a.root)] : []));
  const message = projects.length ? s.skill.addedProject(s.skill.list(projects), who, projects.length > 1) : s.skill.addedProfile(who);
  void vscode.window.showInformationMessage(message, s.skill.show, s.skill.undo).then(async (answer) => {
    try {
      if (answer === s.skill.show) await showSkill(added[0]!.entries[0]!.dir);
      if (answer !== s.skill.undo) return;
      for (const a of added) await removeSkill({ agents: a.entries.flatMap((e) => e.agents), scope: a.scope, projectDir: a.root });
      vscode.window.setStatusBarMessage(`$(check) ${s.skill.removed}`, 4000);
    } catch (err) {
      void vscode.window.showErrorMessage((err as Error).message);
    }
  });
}

// ─── CapMac: Add the CapMac Skill for AI Agents… ─────────────────────────────

/** Asks where (a project of this workspace, or all projects) and for which agents, then adds the skill, asking before it replaces one. */
export async function addSkill(context: vscode.ExtensionContext, model: Model): Promise<void> {
  const where = await pickWhere(model);
  if (!where) return;
  const { scope, root } = where;
  const status = await skillStatus(VERSION, root);
  const agents = await pickAgents(status, detectAgents(root), scope);
  if (!agents?.length) return;

  const plan = await skillPlan({ agents, scope, projectDir: root, version: VERSION });
  const missing = plan.filter((e) => e.state === 'missing');
  const there = plan.filter((e) => e.state !== 'missing' && e.state !== 'current');
  let write = missing;
  if (there.length) {
    type Found = keyof typeof s.skill.found;
    const one = there.length === 1;
    const first = there[0]!;
    const foreign = first.state === 'foreign';
    const title = !one ? s.skill.existsMany(there.length) : foreign ? s.skill.foreignOne(shortPath(first.dir, root)) : s.skill.existsOne(shortPath(first.dir, root));
    const detail = one
      ? [s.skill.foundOne[first.state as Found](first.version), foreign ? s.skill.replaceTheirs : s.skill.replaceOne].filter(Boolean).join('\n\n')
      : [...there.map((e) => s.skill.found[e.state as Found](shortPath(e.dir, root), e.version)), '', s.skill.replaceMany].join('\n');
    const keep = one ? s.skill.keepOne : s.skill.keepMany;
    const answer = await vscode.window.showWarningMessage(title, { modal: true, detail }, s.skill.replace, keep);
    if (!answer) return;
    if (answer === s.skill.replace) write = [...missing, ...there];
  }
  if (root) await rememberProject(context, root);
  if (!write.length) {
    if (!there.length) void vscode.window.showInformationMessage(s.skill.upToDate(names(agents)));
    return;
  }
  await installSkill({ agents: write.flatMap((e) => e.agents), scope, projectDir: root, version: VERSION, force: write.some((e) => e.state === 'foreign') });
  const answer = await vscode.window.showInformationMessage(studio.skills.added(names(agents), scope === 'project'), s.skill.show);
  if (answer) await showSkill(write[0]!.dir);
}

// ─── CapMac: Remove the CapMac Skill for AI Agents… ──────────────────────────

/** Asks where and for which agents (the ones with CapMac's skill there), then removes it. Someone else's skill named capmac stays. */
export async function removeSkillFor(context: vscode.ExtensionContext, model: Model): Promise<void> {
  const where = await pickWhere(model, true);
  if (!where) return;
  const { scope, root } = where;
  const status = await skillStatus(VERSION, root);
  const has = status.filter((agent) => {
    const place = scope === 'global' ? agent.global : agent.project;
    return place?.state === 'installed' || place?.state === 'outdated';
  });
  if (!has.length) {
    void vscode.window.showInformationMessage(studio.skills.nothingToRemove);
    return;
  }
  const items = has.map((agent) => ({ label: agent.name, description: stateOf(agent, scope) ?? undefined, picked: true, id: agent.id }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: s.skill.removeTitle, placeHolder: s.skill.removePlaceholder, ignoreFocusOut: true });
  if (!picked?.length) return;
  try {
    const changes = await removeSkill({ agents: picked.map((p) => p.id), scope, projectDir: root });
    // Removed by hand: CapMac doesn't add it there again by itself.
    if (root) await rememberProject(context, root);
    else await context.globalState.update(STATE_PROFILE, { ...context.globalState.get<{ version?: string; added?: boolean }>(STATE_PROFILE, {}), added: true });
    const removed = changes.filter((c) => c.result === 'removed');
    const who = s.skill.list([...new Set(removed.flatMap((c) => c.agents))]);
    vscode.window.setStatusBarMessage(`$(check) ${removed.length ? studio.skills.removed(who) : studio.skills.nothingToRemove}`, 4000);
  } catch (err) {
    void vscode.window.showErrorMessage((err as Error).message);
  }
}

/** The projects of this workspace (its apps' first, then its folders'), and all projects. */
async function pickWhere(model: Model, removing = false): Promise<{ scope: SkillScope; root?: string } | undefined> {
  const roots = new Map<string, string>();
  for (const root of appRoots(model)) roots.set(keyOf(root), root);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const root = skillProjectRoot(folder.uri.fsPath);
    if (!roots.has(keyOf(root))) roots.set(keyOf(root), root);
  }
  type Where = vscode.QuickPickItem & { scope: SkillScope; root?: string };
  // Where a new copy would go only matters when adding one.
  const items: Where[] = [
    ...[...roots.values()].map((root): Where => ({
      label: `$(folder) ${roots.size === 1 ? s.skill.thisProject(path.basename(root)) : path.basename(root)}`,
      description: root,
      detail: removing ? undefined : s.skill.projectDetail,
      scope: 'project',
      root,
    })),
    { label: `$(account) ${studio.skills.global}`, detail: removing ? undefined : studio.skills.globalHint, scope: 'global' },
  ];
  if (items.length === 1) return items[0];
  return vscode.window.showQuickPick(items, removing ? { title: s.skill.removeTitle, placeHolder: s.skill.removeWherePlaceholder } : { title: s.skill.title, placeHolder: s.skill.wherePlaceholder });
}

/** Every agent CapMac knows, the ones it found first and ticked, with why and whether they have the skill. */
async function pickAgents(status: AgentSkillStatus[], found: Map<string, AgentReason[]>, scope: SkillScope): Promise<string[] | undefined> {
  const reason = (r: AgentReason) => (r === 'extension' ? s.skill.reason.extension(vscode.env.appName) : s.skill.reason[r]);
  const items = [...status]
    .sort((a, b) => Number(found.has(b.id)) - Number(found.has(a.id)))
    .map((agent) => ({
      label: agent.name,
      description: [...(found.get(agent.id) ?? []).map(reason), stateOf(agent, scope)].filter(Boolean).join(' · '),
      picked: found.has(agent.id),
      id: agent.id,
    }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: s.skill.agentsTitle, placeHolder: s.skill.agentsPlaceholder, ignoreFocusOut: true });
  return picked?.map((p) => p.id);
}

/** Whether the agent has the skill there already (Studio's words). */
function stateOf(agent: AgentSkillStatus, scope: SkillScope): string | null {
  const place = scope === 'global' ? agent.global : agent.project;
  const seen = scope === 'global' ? agent.seenGlobal : agent.seenInProject;
  if (place?.state === 'installed') return studio.skills.state.added;
  if (place?.state === 'outdated') return studio.skills.state.outdated;
  if (place?.state === 'foreign') return studio.skills.state.foreign;
  return seen ? studio.skills.state.shared : null;
}
