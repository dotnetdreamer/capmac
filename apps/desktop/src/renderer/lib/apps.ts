/** How Studio names a project's apps (see core's apps.ts for how they are found). */
import type { AppSearch, DetectedProject, ProjectApp, ProjectSummary } from '../../shared/contract';
import { t } from '../../shared/i18n';
import type { IconName } from '../ui/Icon';

export const canRun = (app: Pick<ProjectApp, 'status'>) => app.status !== 'unsupported';

/** "iOS app", "Electron app". */
export function appKind(app: Pick<ProjectApp, 'id' | 'platform'>): string {
  return t.apps.kind[app.id] ?? (app.platform === 'ios' ? t.apps.kind.ios! : t.apps.kind.macos!);
}

export const appGlyph = (app: Pick<ProjectApp, 'platform'>): IconName => (app.platform === 'ios' ? 'phone' : 'desktop');

/** "^43.4.0" → "43.4": the version people say. */
export function versionLabel(range: string | null): string | null {
  const match = range?.match(/(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return match[2] && match[2] !== '0' ? `${match[1]}.${match[2]}` : match[1]!;
}

/** What it is built with, for a card's last line: "Capacitor 8.5 · Swift packages · ios/App". */
export function appTech(app: ProjectApp, projectName?: string): string {
  const parts: string[] = [];
  if (projectName && app.name && app.name !== projectName) parts.push(app.name);
  const version = versionLabel(app.version);
  if (app.id === 'electron') {
    if (app.flavor && app.flavor !== 'plain') parts.push(t.apps.flavor[app.flavor] ?? app.flavor);
    parts.push(version ? t.apps.version('Electron', version) : 'Electron');
  } else {
    const framework = t.apps.framework[app.framework] ?? app.framework;
    parts.push(version ? t.apps.version(framework, version) : framework);
    if (app.flavor) parts.push(t.apps.flavor[app.flavor] ?? app.flavor);
  }
  if (app.rel) parts.push(`${app.rel}/`);
  return parts.join(' · ');
}

/** What it is built with, short, for the toolbar: "Capacitor 8.5", "Electron 43.4". */
export function appTechShort(app: ProjectApp): string {
  const version = versionLabel(app.version);
  const framework = app.id === 'electron' ? 'Electron' : t.apps.framework[app.framework] ?? app.framework;
  return version ? t.apps.version(framework, version) : framework;
}

/** "iPhone and iPad", "Mac", both, and "Windows": where a project's apps CapMac can't run yet would go. */
export function platformsLabel(apps: ProjectApp[]): string {
  const ios = apps.some((a) => a.platform === 'ios');
  const mac = apps.some((a) => a.platform === 'mac');
  const apple = ios && mac ? t.apps.platforms.both : ios ? t.apps.platforms.ios : mac ? t.apps.platforms.mac : '';
  return [apple, apps.some((a) => a.platform === 'windows') ? t.apps.platforms.windows : ''].filter(Boolean).join(' and ');
}

/** A search made of one project Studio already knows (to ask which app, the first time it opens). */
export function searchOf(summary: ProjectSummary): AppSearch {
  const project: DetectedProject = { dir: summary.path, rel: '', name: summary.appName, framework: summary.kind, apps: summary.apps, chosen: summary.appChosen ? summary.app : null };
  return { start: summary.path, projects: [project], suggested: { dir: summary.path, app: summary.app }, truncated: false };
}
