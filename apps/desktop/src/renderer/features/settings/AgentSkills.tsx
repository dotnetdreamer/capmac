import { useCallback, useEffect, useState } from 'react';
import type { AgentSkillStatus, SkillChange, SkillScope } from '@capmac/core/shared/skills';
import type { SkillsInfo } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { toast, useApp } from '../../state/app';
import { errorInfo } from '../../state/engine';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Badge, InfoBar, Spinner } from '../../ui/Feedback';
import { Segmented, Select } from '../../ui/Form';
import { Rich } from '../../ui/Rich';
import './agent-skills.css';

/** Settings › Terminal commands: opens the dialog that adds the capmac skill to AI coding agents. */
export function AgentSkillsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="sparkle" onClick={() => setOpen(true)}>
        {t.skills.setUp}
      </Button>
      {open && <AgentSkillsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function stateOf(agent: AgentSkillStatus, scope: SkillScope): { label: string; tone: 'success' | 'caution' | 'outline' } | null {
  const place = scope === 'global' ? agent.global : agent.project;
  const seen = scope === 'global' ? agent.seenGlobal : agent.seenInProject;
  if (!place) return null;
  if (place.state === 'installed') return { label: t.skills.state.added, tone: 'success' };
  if (place.state === 'outdated') return { label: t.skills.state.outdated, tone: 'caution' };
  if (place.state === 'foreign') return { label: t.skills.state.foreign, tone: 'caution' };
  return seen ? { label: t.skills.state.shared, tone: 'outline' } : null;
}

function summary(changes: SkillChange[]): string {
  const agents = [...new Set(changes.filter((c) => c.result !== 'absent' && c.result !== 'skipped-foreign').flatMap((c) => c.agents))];
  return agents.length > 4 ? t.skills.andMore(agents.slice(0, 4).join(', '), agents.length - 4) : agents.join(', ');
}

function AgentSkillsDialog({ onClose }: { onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const projects = settings?.recentProjects ?? [];
  const [scope, setScope] = useState<SkillScope>('global');
  const [projectDir, setProjectDir] = useState<string | null>(settings?.lastProject ?? projects[0]?.path ?? null);
  const [info, setInfo] = useState<SkillsInfo | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<'add' | 'remove' | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'caution'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.capmac.invoke('app:skills-status', scope === 'project' && projectDir ? { projectDir } : {});
    setInfo(next);
    // Agents found on this PC start ticked.
    setSelected((current) => current ?? new Set(next.agents.filter((a) => a.detected).map((a) => a.id)));
  }, [scope, projectDir]);

  useEffect(() => {
    refresh().catch((err) => setResult({ tone: 'caution', text: tidy(errorInfo(err).message) }));
  }, [refresh]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = info?.agents.filter((a) => selected?.has(a.id)) ?? [];
  const needsProject = scope === 'project' && !projectDir;
  const canRemove = chosen.some((a) => {
    const place = scope === 'global' ? a.global : a.project;
    return place?.state === 'installed' || place?.state === 'outdated';
  });
  const anyOutdated = chosen.some((a) => (scope === 'global' ? a.global : a.project)?.state === 'outdated');

  const [commandBusy, setCommandBusy] = useState(false);
  const setCommand = async (install: boolean) => {
    setCommandBusy(true);
    try {
      await window.capmac.invoke('app:capmac-command', { install });
      toast(install
        ? { tone: 'success', title: t.skills.commandAdded, body: t.skills.commandAddedBody }
        : { tone: 'info', title: t.skills.commandRemoved });
      await refresh();
    } catch (err) {
      toast({ tone: 'critical', title: install ? t.skills.addCommandFailed : t.skills.removeCommandFailed, body: tidy(errorInfo(err).message) });
    } finally {
      setCommandBusy(false);
    }
  };

  const pickFolder = async () => {
    const dir = await window.capmac.invoke('app:pick-folder');
    if (dir) setProjectDir(dir);
  };

  const run = async (action: 'add' | 'remove') => {
    if (!chosen.length || needsProject) return;
    setBusy(action);
    setResult(null);
    const target = { agents: chosen.map((a) => a.id), scope, ...(scope === 'project' && projectDir ? { projectDir } : {}) };
    try {
      const changes = action === 'add' ? await window.capmac.invoke('app:skills-install', target) : await window.capmac.invoke('app:skills-remove', target);
      const foreign = changes.filter((c) => c.result === 'skipped-foreign');
      const who = summary(changes);
      if (action === 'add') {
        setResult(
          foreign.length
            ? { tone: 'caution', text: t.skills.foreign(foreign.map((c) => c.dir).join(', ')) }
            : { tone: 'success', text: t.skills.added(who, scope === 'project') },
        );
        if (!foreign.length) toast({ tone: 'success', title: t.skills.addedToast, body: who });
      } else {
        setResult({ tone: 'success', text: changes.some((c) => c.result === 'removed') ? t.skills.removed(who) : t.skills.nothingToRemove });
      }
      await refresh();
    } catch (err) {
      setResult({ tone: 'caution', text: tidy(errorInfo(err).message) });
    } finally {
      setBusy(null);
    }
  };

  const projectOptions = [
    ...projects.map((p) => ({ value: p.path, label: p.name, hint: p.path })),
    ...(projectDir && !projects.some((p) => p.path === projectDir) ? [{ value: projectDir, label: projectDir.split(/[\\/]/).pop() || projectDir, hint: projectDir }] : []),
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon="sparkle"
      title={t.skills.title}
      footer={
        <>
          <Button variant="subtle" icon="delete" disabled={!canRemove || busy !== null} busy={busy === 'remove'} onClick={() => void run('remove')}>
            {t.common.remove}
          </Button>
          <span className="agent-skills__spacer" />
          <Button onClick={onClose}>{t.common.close}</Button>
          <Button variant="accent" icon="add" disabled={!chosen.length || needsProject || busy !== null} busy={busy === 'add'} onClick={() => void run('add')}>
            {anyOutdated ? t.skills.update : t.skills.add}
          </Button>
        </>
      }
    >
      <p className="agent-skills__intro">
        <Rich text={t.skills.intro} />
      </p>
      {info && !info.command.found && (
        <InfoBar
          tone="caution"
          className="agent-skills__command"
          title={t.skills.needCommand}
          actions={
            <Button busy={commandBusy} onClick={() => void setCommand(true)}>
              {t.skills.addCommand}
            </Button>
          }
        >
          <Rich text={t.skills.needCommandBody} />
        </InfoBar>
      )}
      {info?.command.ours && (
        <p className="agent-skills__hint faint">
          <Rich text={t.skills.commandOurs} />{' '}
          <button type="button" className="agent-skills__inline-link" disabled={commandBusy} onClick={() => void setCommand(false)}>
            {t.skills.removeCommand}
          </button>
        </p>
      )}

      <div className="agent-skills__where">
        <Segmented
          label={t.skills.where}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'global', label: t.skills.global, icon: 'desktop' },
            { value: 'project', label: t.skills.project, icon: 'folderOpen' },
          ]}
        />
        {scope === 'project' && (
          <div className="agent-skills__project">
            {projectOptions.length > 0 && (
              <Select label={t.skills.projectLabel} value={projectDir ?? ''} onChange={setProjectDir} options={projectOptions} width={260} />
            )}
            <Button icon="folderOpen" onClick={() => void pickFolder()}>
              {t.skills.chooseFolder}
            </Button>
          </div>
        )}
      </div>
      <p className="agent-skills__hint faint">
        {scope === 'global'
          ? t.skills.globalHint
          : info?.projectRoot
            ? t.skills.projectHint(info.projectRoot)
            : t.skills.pickProject}
      </p>

      <div className="agent-skills__list-head">
        <span>{t.skills.agents}</span>
        <span className="agent-skills__quick">
          <button type="button" className="link" onClick={() => setSelected(new Set(info?.agents.filter((a) => a.detected).map((a) => a.id)))}>
            {t.skills.foundHere}
          </button>
          <button type="button" className="link" onClick={() => setSelected(new Set(info?.agents.map((a) => a.id)))}>
            {t.skills.all}
          </button>
          <button type="button" className="link" onClick={() => setSelected(new Set())}>
            {t.skills.none}
          </button>
        </span>
      </div>
      {!info ? (
        <div className="agent-skills__loading">
          <Spinner label={t.skills.looking} />
        </div>
      ) : (
        <ul className="agent-skills__list">
          {info.agents.map((agent) => {
            const state = stateOf(agent, scope);
            return (
              <li key={agent.id}>
                <label className="agent-skills__row">
                  <input type="checkbox" checked={selected?.has(agent.id) ?? false} onChange={() => toggle(agent.id)} />
                  <span className="agent-skills__name">{agent.name}</span>
                  {agent.detected && <span className="faint">{t.skills.foundTag}</span>}
                  <span className="agent-skills__spacer" />
                  {state && <Badge tone={state.tone}>{state.label}</Badge>}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {result && (
        <InfoBar tone={result.tone} className="agent-skills__result" live>
          {result.text}
        </InfoBar>
      )}
    </Dialog>
  );
}
