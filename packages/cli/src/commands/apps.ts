/**
 * `capmac apps`: the apps in this folder (a Capacitor project's iOS app and
 * Electron app, or the projects of a monorepo) and which one CapMac works on;
 * `capmac apps use <app>` picks it, for the CLI and CapMac Studio alike.
 */
import path from 'node:path';
import { appsOf, canRun, chooseApp, currentApp, describeFlavor, findApps, frameworkName, loadProject, nothingToRun, type DetectedProject, type ProjectApp, type ProjectInfo, type RunnableApp } from '@capmac/core/engine';
import { log, pc } from '../ui.js';

const KIND: Record<string, string> = { ios: 'iOS app', electron: 'Electron app', macos: 'Mac app' };
const WHERE: Record<string, string> = { ios: 'runs in the iPhone and iPad simulators, and on a real iPhone', electron: 'runs on the Mac’s desktop' };

export const appKind = (app: Pick<ProjectApp, 'id' | 'platform'>) => KIND[app.id] ?? (app.platform === 'ios' ? KIND.ios! : KIND.macos!);

/** "^43.4.0" → "43.4". */
function versionLabel(range: string | null): string | null {
  const match = range?.match(/(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return match[2] && match[2] !== '0' ? `${match[1]}.${match[2]}` : match[1]!;
}

function tech(app: ProjectApp): string {
  const parts: string[] = [];
  const version = versionLabel(app.version);
  if (app.id === 'electron') {
    if (app.flavor && app.flavor !== 'plain') parts.push(describeFlavor(app.flavor as Parameters<typeof describeFlavor>[0]));
    parts.push(version ? `Electron ${version}` : 'Electron');
  } else {
    const framework = frameworkName(app.framework);
    parts.push(version ? `${framework} ${version}` : framework);
    if (app.flavor) parts.push(app.flavor === 'SPM' ? 'Swift Package Manager' : app.flavor);
  }
  if (app.rel) parts.push(`${app.rel}/`);
  return parts.join(' · ');
}

function printApps(project: DetectedProject, indent: string): void {
  const current = currentApp(project);
  const width = Math.max(...project.apps.map((a) => a.id.length));
  const kindWidth = Math.max(...project.apps.map((a) => appKind(a).length));
  for (const app of project.apps) {
    const mark = !canRun(app) ? pc.dim('-') : app.id === current ? pc.green('●') : pc.dim('○');
    const status = app.status === 'setup' ? pc.yellow(`  needs setup: ${app.hint ?? ''}`) : app.status === 'unsupported' ? pc.dim(`  (CapMac can't run ${frameworkName(app.framework)} apps yet)`) : '';
    log.line(`${indent}${mark} ${pc.bold(app.id.padEnd(width))}  ${appKind(app).padEnd(kindWidth)}  ${pc.dim(tech(app))}${status}`);
    if (canRun(app) && WHERE[app.id]) log.line(`${indent}  ${' '.repeat(width)}  ${pc.dim(WHERE[app.id]!)}`);
  }
}

export async function appsCommand(options: { json?: boolean }): Promise<void> {
  const search = await findApps(process.cwd());
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...search, projects: search.projects.map((p) => ({ ...p, current: currentApp(p) })) }, null, 2)}\n`);
    return;
  }
  const runnable = search.projects.filter((p) => p.apps.some(canRun));
  if (runnable.length === 0) throw nothingToRun(search);
  const here = search.projects[0]!;
  const inProject = here.rel === '' || here.rel.startsWith('..');
  if (inProject && search.projects.length === 1) {
    const count = here.apps.filter(canRun).length;
    log.line(count > 1 ? `${pc.bold(here.name)} has ${count} apps:` : `${pc.bold(here.name)}:`);
    log.line();
    printApps(here, '  ');
    const current = currentApp(here);
    const other = here.apps.find((a) => canRun(a) && a.id !== current);
    log.line();
    if (current && other) {
      log.line(`\`capmac run\` and CapMac Studio use the ${appKind({ id: current, platform: current === 'ios' ? 'ios' : 'mac' })}${here.chosen ? '' : ' (the default)'}.`);
      log.dim(`Switch with \`capmac apps use ${other.id}\`, or for one command: \`capmac run --app ${other.id}\`.`);
    }
    return;
  }
  log.line(inProject ? `${pc.bold(here.name)}, and more apps in the folders inside it:` : `No app in this folder itself. CapMac found ${runnable.length === 1 ? 'one project' : `${search.projects.length} projects`} inside it:`);
  for (const project of search.projects) {
    log.line();
    log.line(`  ${pc.bold(project.rel || '.')}  ${pc.dim(project.name)}`);
    printApps(project, '    ');
  }
  log.line();
  const first = runnable.find((p) => p.rel && !p.rel.startsWith('..'));
  if (first) log.dim(`Run capmac in a project's folder, e.g. \`cd ${first.rel.split('/').join(path.sep)}\`.`);
  if (search.truncated) log.dim('There may be more apps deeper down: run `capmac apps` in a folder closer to them.');
}

export async function appsUseCommand(app: string): Promise<void> {
  const project = await loadProject(process.cwd());
  const id = await chooseApp(project, app);
  log.success(`${pc.bold(project.appName)}: \`capmac run\`, \`capmac dev\` and CapMac Studio use the ${appKind({ id, platform: id === 'ios' ? 'ios' : 'mac' })} from now on.`);
}

/** Before a run: which app, when the project has more than one (and how to pick the other). */
export async function announceApp(project: ProjectInfo, app: RunnableApp): Promise<void> {
  const apps = (await appsOf(project)).filter(canRun);
  if (apps.length < 2) return;
  const other = apps.find((a) => a.id !== app);
  log.dim(`${project.appName} has ${apps.length} apps: this is the ${appKind({ id: app, platform: app === 'ios' ? 'ios' : 'mac' })}${other ? ` (the other: \`--app ${other.id}\`, or \`capmac apps use ${other.id}\`)` : ''}.`);
}
