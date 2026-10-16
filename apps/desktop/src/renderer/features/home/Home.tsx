import { useEffect, useState } from 'react';
import type { RecentProject } from '../../../shared/contract';
import { appGlyph, appKind, canRun } from '../../lib/apps';
import { appOf, forgetProject, openProject, pickProject, startSession, stopSession } from '../../state/actions';
import { useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { resolveMac, useMacs } from '../../state/macs';
import { projectKey, useProjects } from '../../state/projects';
import { isActive, isBusy, useRuns } from '../../state/runs';
import { t } from '../../../shared/i18n';
import { formatBytes, timeAgo } from '../../lib/format';
import { AppIcon } from '../../ui/AppIcon';
import { Button, IconButton } from '../../ui/Button';
import { Badge, EmptyState, Skeleton, StatusDot } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Menu, usePopover } from '../../ui/Popover';
import { toast } from '../../state/app';
import './home.css';

function ProjectCard({ recent }: { recent: RecentProject }) {
  const entry = useProjects((s) => s.byKey[projectKey(recent.path)]);
  const run = useRuns((s) => s.byKey[projectKey(recent.path)]);
  const inspect = useProjects((s) => s.inspect);
  const loadSize = useProjects((s) => s.loadSize);
  const navigate = useApp((s) => s.navigate);
  const prefs = useApp((s) => s.settings?.projectPrefs[projectKey(recent.path)]);
  const menu = usePopover();
  useEffect(() => {
    void inspect(recent.path).then((summary) => summary && loadSize(recent.path));
  }, [inspect, loadSize, recent.path]);

  const summary = entry?.summary;
  const name = summary?.appName ?? recent.name;
  const active = isActive(run);
  const busy = isBusy(run);
  const missing = entry?.error && !summary;
  const last = recent.lastRun;
  // With more than one app, the one Run and Live use stands out.
  const app = appOf(summary, prefs ?? {});
  const several = (summary?.apps.filter(canRun).length ?? 0) > 1;
  const appTone = (id: string) => (several && app === id ? 'accent' : 'neutral');
  const current = several ? summary?.apps.find((a) => a.id === app) : undefined;

  let status: React.ReactNode = null;
  if (active) {
    status = (
      <span className="project-card__status">
        <StatusDot tone={busy ? 'busy' : run?.mode === 'live' ? 'live' : 'ok'} pulse={busy || run?.mode === 'live'} />
        {busy ? t.home.building : run?.mode === 'live' ? t.common.live : t.home.running}
      </span>
    );
  } else if (run?.status === 'failed') {
    status = (
      <span className="project-card__status is-error">
        <StatusDot tone="error" />
        {t.home.buildFailed}
      </span>
    );
  }

  return (
    <article className={`project-card${missing ? ' is-missing' : ''}`} aria-label={name}>
      <button type="button" className="project-card__open" onClick={() => (missing ? undefined : navigate({ name: 'project', path: recent.path }))} aria-label={t.home.openProject(name)} disabled={Boolean(missing)} />
      <div className="project-card__top">
        {summary || missing ? <AppIcon src={entry?.icon} name={name} seed={summary?.appId ?? recent.appId} size={44} /> : <Skeleton width={44} height={44} radius={10} />}
        <div className="project-card__ident">
          <div className="project-card__name truncate">{name}</div>
          <div className="project-card__id mono truncate">{summary?.appId ?? recent.appId}</div>
        </div>
        {status}
      </div>
      {missing ? (
        <p className="project-card__missing">
          <Icon name="warning" size={14} filled /> {t.home.missing}
        </p>
      ) : (
        <div className="project-card__meta" title={current ? t.apps.current(appKind(current)) : undefined}>
          {summary?.kind === 'flutter' && (
            <>
              <Badge tone="neutral">{t.home.flutter}</Badge>
              {summary.apps.filter(canRun).map((a) => (
                <Badge key={a.id} tone={appTone(a.id)} icon={several ? appGlyph(a) : undefined}>
                  {t.home.flutterApp[a.id] ?? appKind(a)}
                </Badge>
              ))}
            </>
          )}
          {summary && summary.kind !== 'flutter' && (summary.hasIos || !summary.electron) && (
            <Badge tone={appTone('ios')} icon={several ? 'phone' : undefined}>
              {summary.iosPackageManager === 'unknown' ? (summary.hasIos ? 'iOS' : t.home.noIos) : summary.iosPackageManager}
            </Badge>
          )}
          {summary?.electron && (
            <Badge tone={appTone('electron')} icon={several ? 'desktop' : undefined}>
              {t.home.electron}
            </Badge>
          )}
          {entry?.size ? (
            <span className="tabular">
              {t.count.files(entry.size.files)} · {formatBytes(entry.size.bytes)}
            </span>
          ) : (
            <Skeleton width={96} height={10} />
          )}
        </div>
      )}
      <div className="project-card__foot">
        <span className="project-card__last truncate">
          {last ? (
            <>
              <Icon name={last.ok ? 'history' : 'errorCircle'} size={14} />
              {last.ok ? t.home.lastRun(last.mode === 'live', timeAgo(last.at), last.target) : t.home.lastFailed(timeAgo(last.at))}
            </>
          ) : (
            <>
              <Icon name="clock" size={14} />
              {t.home.notRun}
            </>
          )}
        </span>
        <div className="project-card__actions">
          {active ? (
            <IconButton icon="stop" filled label={t.common.stop} size="sm" onClick={() => void stopSession(recent.path)} />
          ) : (
            <>
              <IconButton icon="play" filled label={t.common.run} size="sm" disabled={Boolean(missing)} onClick={() => void startSession(recent.path, 'run').then(() => navigate({ name: 'project', path: recent.path }))} />
              <IconButton icon="flash" filled label={t.home.liveReload} size="sm" disabled={Boolean(missing)} onClick={() => void startSession(recent.path, 'live').then(() => navigate({ name: 'project', path: recent.path }))} />
            </>
          )}
          <button type="button" className="icon-btn icon-btn--sm" aria-label={t.common.moreActionsFor(name)} aria-haspopup="menu" {...menu.triggerProps}>
            <Icon name="more" size={16} />
          </button>
          <Menu
            state={menu}
            label={t.common.actionsFor(name)}
            items={[
              { id: 'folder', label: t.home.openFolder, icon: 'folderOpen', onSelect: () => void window.capmac.invoke('app:open-path', { path: recent.path }) },
              { id: 'editor', label: t.home.openInEditor, icon: 'open', onSelect: () => void window.capmac.invoke('app:open-in-editor', { file: recent.path }) },
              { id: 'forget', label: t.home.removeFromList, icon: 'delete', separatorBefore: true, onSelect: () => void forgetProject(recent.path) },
            ]}
          />
        </div>
      </div>
    </article>
  );
}

function EmptyArt() {
  return (
    <svg className="home-empty__art" width="168" height="112" viewBox="0 0 168 112" aria-hidden="true">
      <rect x="8" y="14" width="96" height="66" rx="8" className="art-surface" />
      <rect x="8" y="14" width="96" height="14" rx="8" className="art-bar" />
      <rect x="18" y="38" width="44" height="6" rx="3" className="art-line" />
      <rect x="18" y="52" width="64" height="6" rx="3" className="art-line" />
      <rect x="18" y="66" width="32" height="6" rx="3" className="art-line" />
      <path d="M104 47h18" className="art-link" />
      <rect x="122" y="10" width="40" height="80" rx="10" className="art-phone" />
      <path d="M137 40v20l15-10z" className="art-play" />
    </svg>
  );
}

/** Copies a bundled sample to Documents, opens it and runs it. */
async function runSample(kind: 'ios' | 'electron' | 'flutter'): Promise<void> {
  try {
    const { path } = await call('projects.createSample', { kind });
    // Without a Mac, open it: the workspace shows how to pair one.
    if ((await openProject(path)) && useMacs.getState().macs.length > 0) void startSession(path, 'run');
  } catch (err) {
    toast({ tone: 'critical', title: t.home.sampleFailed, body: errorInfo(err).message });
  }
}

function SampleButton({ variant = 'standard', kind = 'ios' }: { variant?: 'standard' | 'subtle'; kind?: 'ios' | 'electron' | 'flutter' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      icon={kind === 'electron' ? 'desktop' : kind === 'flutter' ? 'sparkle' : 'rocket'}
      busy={busy}
      onClick={async () => {
        setBusy(true);
        await runSample(kind);
        setBusy(false);
      }}
    >
      {kind === 'electron' ? t.home.trySampleElectron : kind === 'flutter' ? t.home.trySampleFlutter : t.home.trySample}
    </Button>
  );
}

/** The samples, from the page header: the iOS app, the Electron app and the Flutter app. */
function SampleMenu() {
  const menu = usePopover();
  return (
    <>
      <button type="button" className="btn btn--subtle btn--md" aria-haspopup="menu" {...menu.triggerProps}>
        <Icon name="rocket" size={16} />
        <span className="btn__label">{t.home.trySampleMenu}</span>
        <Icon name="chevronDown" size={12} className="btn__icon-right" />
      </button>
      <Menu
        state={menu}
        label={t.home.trySampleMenu}
        width={280}
        items={[
          { id: 'ios', label: t.home.sampleIos, icon: 'phone', onSelect: () => void runSample('ios') },
          { id: 'electron', label: t.home.sampleElectron, icon: 'desktop', onSelect: () => void runSample('electron') },
          { id: 'flutter', label: t.home.sampleFlutter, icon: 'sparkle', onSelect: () => void runSample('flutter') },
        ]}
      />
    </>
  );
}

export function Home() {
  const recents = useApp((s) => s.settings?.recentProjects ?? []);
  const macs = useMacs((s) => s.macs);
  const mac = resolveMac(macs);
  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__header">
          <div>
            <h1 className="page__title">{t.home.title}</h1>
            <p className="page__subtitle">{mac ? t.home.subtitle(mac.label) : t.home.subtitleNoMac}</p>
          </div>
          {recents.length > 0 && (
            <div className="page__actions">
              <SampleMenu />
              <Button variant="accent" icon="folderAdd" onClick={() => void pickProject()}>
                {t.home.addProject}
              </Button>
            </div>
          )}
        </header>
        {recents.length === 0 ? (
          <div className="home-empty">
            <EmptyState
              art={<EmptyArt />}
              title={t.home.emptyTitle}
              actions={
                <>
                  <Button variant="accent" icon="folderOpen" onClick={() => void pickProject()}>
                    {t.home.chooseFolder}
                  </Button>
                  <SampleButton />
                  <SampleButton kind="electron" />
                  <SampleButton kind="flutter" />
                </>
              }
            >
              {t.home.emptyBody}
            </EmptyState>
          </div>
        ) : (
          <div className="project-grid">
            {recents.map((p) => (
              <ProjectCard key={p.path} recent={p} />
            ))}
            <button type="button" className="project-add" onClick={() => void pickProject()}>
              <Icon name="folderAdd" size={20} />
              <span className="project-add__title">{t.home.addCard}</span>
              <span className="project-add__hint">{t.home.addCardHint}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
