import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AppSearch, DetectedProject, ProjectApp, RunnableApp } from '../../shared/contract';
import { t, tidy } from '../../shared/i18n';
import { appGlyph, appKind, appTech, canRun, platformsLabel } from '../lib/apps';
import { useApp } from '../state/app';
import { useChooser } from '../state/chooser';
import { projectKey, useIcon } from '../state/projects';
import { AppIcon } from '../ui/AppIcon';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Badge } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { Rich } from '../ui/Rich';
import './app-chooser.css';

interface Option {
  project: DetectedProject;
  app: ProjectApp;
}

/** Asks which app to work on when a folder has more than one (see state/chooser.ts). */
export function AppChooserHost() {
  const request = useChooser((s) => s.request);
  return request ? <AppChooser key={request.id} search={request.search} /> : null;
}

function AppCard({ option, index, checked, onSelect, onOpen, lastUsed }: { option: Option; index: number; checked: boolean; onSelect: () => void; onOpen: () => void; lastUsed: boolean }) {
  const { app, project } = option;
  const icon = useIcon(app.icon);
  const id = useId();
  return (
    <div
      role="radio"
      aria-checked={checked}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-where ${id}-tech`}
      tabIndex={checked ? 0 : -1}
      data-autofocus={checked ? '' : undefined}
      className={`app-card${checked ? ' is-checked' : ''}`}
      title={app.evidence.length ? t.apps.foundFrom(app.evidence) : undefined}
      style={{ '--i': index } as CSSProperties}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <span className="app-card__icon">
        <AppIcon src={icon} name={app.name || project.name} seed={`${project.dir}|${app.id}`} size={44} />
        <span className="app-card__glyph">
          <Icon name={appGlyph(app)} size={12} />
        </span>
      </span>
      <span className="app-card__text">
        <span className="app-card__title" id={`${id}-title`}>
          {appKind(app)}
          {app.status === 'setup' && <Badge tone="caution">{t.apps.setup}</Badge>}
          {lastUsed && <Badge tone="accent">{t.apps.lastUsed}</Badge>}
        </span>
        <span className="app-card__where" id={`${id}-where`}>
          {app.status === 'setup' && app.hint ? <Rich text={tidy(app.hint)} /> : t.apps.where[app.id]}
        </span>
        <span className="app-card__tech" id={`${id}-tech`}>
          {appTech(app, project.name)}
        </span>
      </span>
      <span className="app-card__radio" aria-hidden="true" />
    </div>
  );
}

/** A project with nothing CapMac runs yet: named, so people know CapMac saw it. */
function LaterRow({ project }: { project: DetectedProject }) {
  const icon = useIcon(project.apps.find((a) => a.icon)?.icon);
  const framework = t.apps.framework[project.framework] ?? project.framework;
  return (
    <li className="app-later__row">
      <AppIcon src={icon} name={project.name} seed={project.dir} size={24} />
      <span className="app-later__name truncate">{project.name}</span>
      <span className="app-later__what truncate">{t.apps.notYetApp(framework, platformsLabel(project.apps))}</span>
      {project.rel && <span className="app-later__rel truncate">{project.rel}</span>}
    </li>
  );
}

function AppChooser({ search }: { search: AppSearch }) {
  const answer = useChooser((s) => s.answer);
  const recents = useApp((s) => s.settings?.recentProjects);
  const groups = useMemo(() => search.projects.map((project) => ({ project, apps: project.apps.filter(canRun) })).filter((g) => g.apps.length > 0), [search]);
  const options = useMemo<Option[]>(() => groups.flatMap((g) => g.apps.map((app) => ({ project: g.project, app }))), [groups]);
  const later = search.projects.filter((p) => !p.apps.some(canRun));
  const suggested = options.findIndex((o) => o.project.dir === search.suggested?.dir && o.app.id === search.suggested?.app);
  const [selected, setSelected] = useState(Math.max(0, suggested));
  const list = useRef<HTMLDivElement>(null);
  const several = groups.length > 1;
  const choice = options[selected];
  const known = new Set((recents ?? []).map((r) => projectKey(r.path)));

  const submit = () => {
    if (choice) answer({ dir: choice.project.dir, app: choice.app.id as RunnableApp });
  };
  const move = (to: number) => {
    const next = (to + options.length) % options.length;
    setSelected(next);
    list.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') move(selected + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') move(selected - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(options.length - 1);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= options.length) move(Number(e.key) - 1);
    else if (e.key === 'Enter') submit();
    else if (e.key !== ' ') return;
    e.preventDefault();
  };

  const title = several || !groups[0] ? t.apps.titleFound(options.length) : t.apps.title(groups[0].project.name, options.length);
  let index = -1;
  return (
    <Dialog
      open
      className="app-chooser"
      title={title}
      onClose={() => answer(null)}
      onSubmit={submit}
      footer={
        <>
          <Button type="submit" variant="accent" disabled={!choice}>
            {choice ? t.apps.open(several ? choice.project.name : appKind(choice.app)) : t.common.continue}
          </Button>
          <Button onClick={() => answer(null)}>{t.common.cancel}</Button>
        </>
      }
    >
      <p className="app-chooser__lead">{several ? t.apps.subtitleFound : t.apps.subtitle}</p>
      <div ref={list} role="radiogroup" aria-label={t.apps.list} className="app-choices" onKeyDown={onKeyDown}>
        {groups.map((group) => (
          <div key={group.project.dir} className="app-choices__group" role={several ? 'group' : undefined} aria-label={several ? group.project.name : undefined}>
            {several && (
              <div className="app-choices__project">
                <span className="app-choices__name truncate">{group.project.name}</span>
                <span className="app-choices__rel truncate">{group.project.rel || t.apps.thisFolder}</span>
                {known.has(projectKey(group.project.dir)) && <Badge>{t.apps.added}</Badge>}
              </div>
            )}
            {group.apps.map((app) => {
              index += 1;
              const i = index;
              return (
                <AppCard
                  key={`${group.project.dir}|${app.id}`}
                  option={{ project: group.project, app }}
                  index={i}
                  checked={i === selected}
                  lastUsed={group.project.chosen === app.id && (several || group.apps.length > 1)}
                  onSelect={() => move(i)}
                  onOpen={() => answer({ dir: group.project.dir, app: app.id as RunnableApp })}
                />
              );
            })}
          </div>
        ))}
      </div>
      {later.length > 0 && (
        <section className="app-later" aria-label={t.apps.notYet}>
          <div className="app-later__title">
            <Icon name="info" size={14} />
            {t.apps.notYet}
          </div>
          <ul className="app-later__list">
            {later.map((project) => (
              <LaterRow key={project.dir} project={project} />
            ))}
          </ul>
          <p className="app-later__hint">{t.apps.notYetHint}</p>
        </section>
      )}
      {search.truncated && <p className="app-chooser__more">{t.apps.more}</p>}
    </Dialog>
  );
}
