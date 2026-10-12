import { useEffect, useState } from 'react';
import type { RecentProject } from '../../../shared/contract';
import { forgetProject, openProject, pickProject, startSession, stopSession } from '../../state/actions';
import { useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { resolveMac, useMacs } from '../../state/macs';
import { projectKey, useProjects } from '../../state/projects';
import { isActive, isBusy, useRuns } from '../../state/runs';
import { formatBytes, plural, timeAgo } from '../../lib/format';
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

  let status: React.ReactNode = null;
  if (active) {
    status = (
      <span className="project-card__status">
        <StatusDot tone={busy ? 'busy' : run?.mode === 'live' ? 'live' : 'ok'} pulse={busy || run?.mode === 'live'} />
        {busy ? 'Building…' : run?.mode === 'live' ? 'Live' : 'Running'}
      </span>
    );
  } else if (run?.status === 'failed') {
    status = (
      <span className="project-card__status is-error">
        <StatusDot tone="error" />
        Build failed
      </span>
    );
  }

  return (
    <article className={`project-card${missing ? ' is-missing' : ''}`} aria-label={name}>
      <button type="button" className="project-card__open" onClick={() => (missing ? undefined : navigate({ name: 'project', path: recent.path }))} aria-label={`Open ${name}`} disabled={Boolean(missing)} />
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
          <Icon name="warning" size={14} filled /> Folder not found or not a Capacitor app anymore.
        </p>
      ) : (
        <div className="project-card__meta">
          {summary && <Badge>{summary.iosPackageManager === 'unknown' ? (summary.hasIos ? 'iOS' : 'No iOS platform') : summary.iosPackageManager}</Badge>}
          {entry?.size ? (
            <span className="tabular">
              {plural(entry.size.files, 'file')} · {formatBytes(entry.size.bytes)}
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
              {last.ok ? `${last.mode === 'live' ? 'Live' : 'Ran'} ${timeAgo(last.at)}${last.target ? ` on ${last.target}` : ''}` : `Failed ${timeAgo(last.at)}`}
            </>
          ) : (
            <>
              <Icon name="clock" size={14} />
              Not run yet
            </>
          )}
        </span>
        <div className="project-card__actions">
          {active ? (
            <IconButton icon="stop" filled label="Stop" size="sm" onClick={() => void stopSession(recent.path)} />
          ) : (
            <>
              <IconButton icon="play" filled label="Run" size="sm" disabled={Boolean(missing)} onClick={() => void startSession(recent.path, 'run').then(() => navigate({ name: 'project', path: recent.path }))} />
              <IconButton icon="flash" filled label="Live reload" size="sm" disabled={Boolean(missing)} onClick={() => void startSession(recent.path, 'live').then(() => navigate({ name: 'project', path: recent.path }))} />
            </>
          )}
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`More actions for ${name}`} aria-haspopup="menu" {...menu.triggerProps}>
            <Icon name="more" size={16} />
          </button>
          <Menu
            state={menu}
            label={`${name} actions`}
            items={[
              { id: 'folder', label: 'Open folder', icon: 'folderOpen', onSelect: () => void window.capmac.invoke('app:open-path', { path: recent.path }) },
              { id: 'editor', label: 'Open in editor', icon: 'open', onSelect: () => void window.capmac.invoke('app:open-in-editor', { file: recent.path }) },
              { id: 'forget', label: 'Remove from list', icon: 'delete', separatorBefore: true, onSelect: () => void forgetProject(recent.path) },
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

function SampleButton({ variant = 'standard' }: { variant?: 'standard' | 'subtle' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      icon="rocket"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { path } = await call('projects.createSample', {});
          // Without a Mac, open it: the workspace shows how to pair one.
          if ((await openProject(path)) && useMacs.getState().macs.length > 0) void startSession(path, 'run');
        } catch (err) {
          toast({ tone: 'critical', title: 'Could not create the sample app', body: errorInfo(err).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      Try the sample app
    </Button>
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
            <h1 className="page__title">Projects</h1>
            <p className="page__subtitle">{mac ? `Your Capacitor apps, built and run on ${mac.label}.` : 'Your Capacitor apps. Pair a Mac to build and run them.'}</p>
          </div>
          {recents.length > 0 && (
            <div className="page__actions">
              <SampleButton variant="subtle" />
              <Button variant="accent" icon="folderAdd" onClick={() => void pickProject()}>
                Add project
              </Button>
            </div>
          )}
        </header>
        {recents.length === 0 ? (
          <div className="home-empty">
            <EmptyState
              art={<EmptyArt />}
              title="Add your Capacitor app"
              actions={
                <>
                  <Button variant="accent" icon="folderOpen" onClick={() => void pickProject()}>
                    Choose a folder…
                  </Button>
                  <SampleButton />
                </>
              }
            >
              Pick the folder with your capacitor.config, or drop it anywhere on this window. CapMac syncs it to {mac?.label ?? 'your Mac'} and runs it on the iOS simulator.
            </EmptyState>
          </div>
        ) : (
          <div className="project-grid">
            {recents.map((p) => (
              <ProjectCard key={p.path} recent={p} />
            ))}
            <button type="button" className="project-add" onClick={() => void pickProject()}>
              <Icon name="folderAdd" size={20} />
              <span className="project-add__title">Add a Capacitor app</span>
              <span className="project-add__hint">or drop its folder here</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
