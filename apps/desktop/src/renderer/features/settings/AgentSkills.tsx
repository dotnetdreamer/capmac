import { useCallback, useEffect, useState } from 'react';
import type { AgentSkillStatus, SkillChange, SkillScope } from '@capmac/core/shared/skills';
import type { SkillsInfo } from '../../../shared/contract';
import { toast, useApp } from '../../state/app';
import { errorInfo } from '../../state/engine';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Badge, InfoBar, Spinner } from '../../ui/Feedback';
import { Segmented, Select } from '../../ui/Form';
import './agent-skills.css';

/** Settings › Terminal commands: opens the dialog that adds the capmac skill to AI coding agents. */
export function AgentSkillsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="sparkle" onClick={() => setOpen(true)}>
        Set up…
      </Button>
      {open && <AgentSkillsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function stateOf(agent: AgentSkillStatus, scope: SkillScope): { label: string; tone: 'success' | 'caution' | 'outline' } | null {
  const place = scope === 'global' ? agent.global : agent.project;
  const seen = scope === 'global' ? agent.seenGlobal : agent.seenInProject;
  if (!place) return null;
  if (place.state === 'installed') return { label: 'Added', tone: 'success' };
  if (place.state === 'outdated') return { label: 'Update available', tone: 'caution' };
  if (place.state === 'foreign') return { label: 'Has its own “capmac” skill', tone: 'caution' };
  return seen ? { label: 'Added (shared folder)', tone: 'outline' } : null;
}

function summary(changes: SkillChange[]): string {
  const agents = [...new Set(changes.filter((c) => c.result !== 'absent' && c.result !== 'skipped-foreign').flatMap((c) => c.agents))];
  return agents.length > 4 ? `${agents.slice(0, 4).join(', ')} and ${agents.length - 4} more` : agents.join(', ');
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
    refresh().catch((err) => setResult({ tone: 'caution', text: errorInfo(err).message }));
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
        ? { tone: 'success', title: 'capmac command added', body: 'New terminals and agent sessions can run capmac.' }
        : { tone: 'info', title: 'capmac command removed' });
      await refresh();
    } catch (err) {
      toast({ tone: 'critical', title: install ? 'Could not add the capmac command' : 'Could not remove the capmac command', body: errorInfo(err).message });
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
            ? { tone: 'caution', text: `${foreign.map((c) => c.dir).join(', ')} already holds a “capmac” skill that CapMac did not write, so it was left alone.` }
            : { tone: 'success', text: `${who} can now use CapMac. Agents load skills when a session starts, so start a new one.${scope === 'project' ? ' Commit the new folders so your team gets it too.' : ''}` },
        );
        if (!foreign.length) toast({ tone: 'success', title: 'Skill added', body: who });
      } else {
        setResult({ tone: 'success', text: changes.some((c) => c.result === 'removed') ? `Removed. It was read by ${who}.` : 'Nothing to remove there.' });
      }
      await refresh();
    } catch (err) {
      setResult({ tone: 'caution', text: errorInfo(err).message });
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
      title="Teach your AI agents to use CapMac"
      footer={
        <>
          <Button variant="subtle" icon="delete" disabled={!canRemove || busy !== null} busy={busy === 'remove'} onClick={() => void run('remove')}>
            Remove
          </Button>
          <span className="agent-skills__spacer" />
          <Button onClick={onClose}>Close</Button>
          <Button variant="accent" icon="add" disabled={!chosen.length || needsProject || busy !== null} busy={busy === 'add'} onClick={() => void run('add')}>
            {anyOutdated ? 'Update skill' : 'Add skill'}
          </Button>
        </>
      }
    >
      <p className="agent-skills__intro">
        Adds a short skill to your coding agents. With it, an agent can build your iOS app on the Mac, run it, read its console, take a screenshot and fix build errors
        with the <code>capmac</code> command.
      </p>
      {info && !info.command.found && (
        <InfoBar
          tone="caution"
          className="agent-skills__command"
          title="Agents need the capmac command"
          actions={
            <Button busy={commandBusy} onClick={() => void setCommand(true)}>
              Add the capmac command
            </Button>
          }
        >
          New terminals on this PC can’t run <code>capmac</code> yet. CapMac Studio can add it; it runs the CLI that comes with Studio.
        </InfoBar>
      )}
      {info?.command.ours && (
        <p className="agent-skills__hint faint">
          The <code>capmac</code> command runs the CLI that comes with CapMac Studio.{' '}
          <button type="button" className="agent-skills__inline-link" disabled={commandBusy} onClick={() => void setCommand(false)}>
            Remove the command
          </button>
        </p>
      )}

      <div className="agent-skills__where">
        <Segmented
          label="Where"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'global', label: 'All my projects', icon: 'desktop' },
            { value: 'project', label: 'One project', icon: 'folderOpen' },
          ]}
        />
        {scope === 'project' && (
          <div className="agent-skills__project">
            {projectOptions.length > 0 && (
              <Select label="Project" value={projectDir ?? ''} onChange={setProjectDir} options={projectOptions} width={260} />
            )}
            <Button icon="folderOpen" onClick={() => void pickFolder()}>
              Choose folder…
            </Button>
          </div>
        )}
      </div>
      <p className="agent-skills__hint faint">
        {scope === 'global'
          ? 'Just for you, in each agent’s own folder in your user profile.'
          : info?.projectRoot
            ? `In ${info.projectRoot}, in the folders each agent reads. Commit them and your team’s agents get it too.`
            : 'Pick the project the skill should go into.'}
      </p>

      <div className="agent-skills__list-head">
        <span>Agents</span>
        <span className="agent-skills__quick">
          <button type="button" className="link" onClick={() => setSelected(new Set(info?.agents.filter((a) => a.detected).map((a) => a.id)))}>
            Found on this PC
          </button>
          <button type="button" className="link" onClick={() => setSelected(new Set(info?.agents.map((a) => a.id)))}>
            All
          </button>
          <button type="button" className="link" onClick={() => setSelected(new Set())}>
            None
          </button>
        </span>
      </div>
      {!info ? (
        <div className="agent-skills__loading">
          <Spinner label="Looking for agents" />
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
                  {agent.detected && <span className="faint">found on this PC</span>}
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
