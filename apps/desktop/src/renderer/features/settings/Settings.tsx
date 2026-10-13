import { useEffect, useState, type ReactNode } from 'react';
import type { Settings as SettingsShape, TakeoverInfo } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { toast, useApp } from '../../state/app';
import { signalUrlProblem } from '@capmac/core/shared/remote';
import { errorInfo } from '../../state/engine';
import { useRemote } from '../../state/remote';
import { DEPLOY_GUIDE_URL } from '../macs/RemoteAccess';
import { AgentSkillsButton } from './AgentSkills';
import { Button } from '../../ui/Button';
import { Segmented, Select, TextField, Toggle } from '../../ui/Form';
import { Icon, type IconName } from '../../ui/Icon';
import { Rich } from '../../ui/Rich';
import { UpdatesPanel } from './Updates';
import './settings.css';

function Row({ icon, title, description, children }: { icon: IconName; title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-card">
      <Icon name={icon} size={20} className="settings-card__icon" />
      <div className="settings-card__text">
        <div className="settings-card__title">{title}</div>
        {description && <div className="settings-card__desc">{description}</div>}
      </div>
      <div className="settings-card__control">{children}</div>
    </div>
  );
}

/** Takeover: the Capacitor and Ionic commands people already type run on the Mac. */
function TerminalCommands() {
  const [info, setInfo] = useState<TakeoverInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    window.capmac.invoke('app:takeover-status').then((value) => live && setInfo(value), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const change = async (on: boolean) => {
    setBusy(true);
    try {
      setInfo(await window.capmac.invoke('app:takeover-set', { on }));
      toast(on
        ? { tone: 'success', title: t.settings.takeoverOn, body: t.settings.takeoverOnBody }
        : { tone: 'info', title: t.settings.takeoverOff, body: t.settings.takeoverOffBody });
    } catch (err) {
      toast({ tone: 'critical', title: on ? t.settings.turnOnFailed : t.settings.turnOffFailed, body: tidy(errorInfo(err).message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="section-title">{t.settings.terminal}</h2>
      <Row
        icon="console"
        title={<Rich text={t.settings.takeover} />}
        description={
          <>
            <Rich text={t.settings.takeoverDesc} />
            {info?.on && !info.bundled && info.cli && <span className="settings-takeover__note">{t.settings.takeoverCli(info.cli)}</span>}
            {info?.cliMissing && <span className="settings-takeover__note settings-takeover__note--warn">{t.settings.takeoverCliMissing}</span>}
          </>
        }
      >
        <Toggle label={t.settings.takeoverLabel} checked={info?.on ?? false} loading={!info} disabled={!info || busy} onChange={(v) => void change(v)} />
      </Row>
      <Row icon="sparkle" title={t.settings.agents} description={t.settings.agentsDesc}>
        <AgentSkillsButton />
      </Row>
    </>
  );
}

/** Remote access: your signaling server (the same setting as `capmac remote server`). */
function RemoteAccessSettings() {
  const server = useRemote((s) => s.server);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useRemote.getState().loadServer().then((s) => setValue(s?.url ?? ''));
  }, []);
  const fromEnvironment = server?.source === 'environment';
  const saved = server?.url ?? '';
  const dirty = value.trim() !== saved;
  const save = async () => {
    const url = value.trim();
    const problem = url ? signalUrlProblem(url) : null;
    if (problem) {
      setError(tidy(problem));
      return;
    }
    setBusy(true);
    try {
      const next = await useRemote.getState().setServer(url || null);
      setValue(next.url ?? '');
      toast(next.url ? { tone: 'success', title: t.settings.serverSaved, body: t.settings.serverSavedBody } : { tone: 'info', title: t.settings.serverCleared });
    } catch (err) {
      setError(tidy(errorInfo(err).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 className="section-title">{t.settings.remote}</h2>
      <Row
        icon="globe"
        title={t.settings.server}
        description={
          <>
            {t.settings.serverDesc}
            <span className="settings-takeover__note">
              <a href={DEPLOY_GUIDE_URL} onClick={(e) => {
                e.preventDefault();
                void window.capmac.invoke('app:open-external', { url: DEPLOY_GUIDE_URL });
              }}>{t.remote.server.howTo}</a>
            </span>
            {fromEnvironment && <span className="settings-takeover__note"><Rich text={t.settings.serverFromEnv} /></span>}
            {server?.source === 'built-in' && <span className="settings-takeover__note">{t.settings.serverBuiltIn}</span>}
          </>
        }
      >
        <form
          className="settings-server"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField
            aria-label={t.settings.server}
            placeholder={t.remote.server.placeholder}
            value={value}
            disabled={fromEnvironment || busy}
            error={error}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" disabled={!dirty || fromEnvironment} busy={busy}>
            {t.common.save}
          </Button>
        </form>
      </Row>
    </>
  );
}

export function Settings() {
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const update = useApp((s) => s.updateSettings);
  if (!settings) return null;
  const set = <K extends keyof SettingsShape>(key: K) => (value: SettingsShape[K]) => void update({ [key]: value } as Partial<SettingsShape>);

  return (
    <div className="page">
      <div className="page__inner settings">
        <header className="page__header">
          <div>
            <h1 className="page__title">{t.settings.title}</h1>
          </div>
        </header>

        <h2 className="section-title">{t.settings.appearance}</h2>
        <Row icon="theme" title={t.settings.theme} description={t.settings.themeDesc}>
          <Segmented
            label={t.settings.theme}
            value={settings.theme}
            onChange={set('theme')}
            options={[
              { value: 'system', label: t.settings.themes.system, icon: 'desktop' },
              { value: 'light', label: t.settings.themes.light, icon: 'sun' },
              { value: 'dark', label: t.settings.themes.dark, icon: 'moon' },
            ]}
          />
        </Row>
        <Row icon="phone" title={t.settings.frame} description={t.settings.frameDesc}>
          <Toggle label={t.settings.frame} checked={settings.deviceFrame} onChange={set('deviceFrame')} />
        </Row>
        <Row icon="flash" title={t.settings.stream} description={t.settings.streamDesc}>
          <Segmented
            label={t.settings.stream}
            value={settings.simulatorStream}
            onChange={set('simulatorStream')}
            options={[
              { value: 'smooth', label: t.settings.streams.smooth },
              { value: 'compatible', label: t.settings.streams.compatible },
            ]}
          />
        </Row>

        <h2 className="section-title">{t.settings.editorSection}</h2>
        <Row icon="code" title={t.settings.editor} description={t.settings.editorDesc}>
          <Select
            label={t.settings.editorLabel}
            value={settings.editor}
            onChange={set('editor')}
            width={200}
            options={[
              { value: 'vscode', label: t.settings.editors.vscode },
              { value: 'cursor', label: t.settings.editors.cursor },
              { value: 'system', label: t.settings.editors.system },
            ]}
          />
        </Row>

        <TerminalCommands />

        <RemoteAccessSettings />

        <h2 className="section-title">{t.settings.consoleSection}</h2>
        <Row icon="console" title={t.settings.lineLimit} description={t.settings.lineLimitDesc}>
          <Select
            label={t.settings.lineLimit}
            value={String(settings.consoleLimit)}
            onChange={(v) => set('consoleLimit')(Number(v))}
            width={160}
            options={[50_000, 100_000, 200_000, 500_000].map((n) => ({ value: String(n), label: t.settings.lineCount(n) }))}
          />
        </Row>
        <Row icon="clock" title={t.settings.timestamps} description={t.settings.timestampsDesc}>
          <Toggle label={t.settings.timestamps} checked={settings.consoleTimestamps} onChange={set('consoleTimestamps')} />
        </Row>
        <Row icon="text" title={t.settings.wrap}>
          <Toggle label={t.settings.wrap} checked={settings.consoleWrap} onChange={set('consoleWrap')} />
        </Row>
        <Row icon="document" title={t.settings.systemLogs} description={t.settings.systemLogsDesc}>
          <Toggle label={t.settings.systemLogs} checked={settings.osLogs} onChange={set('osLogs')} />
        </Row>

        <h2 className="section-title">{t.settings.builds}</h2>
        <Row icon="warning" title={t.settings.depWarnings} description={t.settings.depWarningsDesc}>
          <Toggle label={t.settings.depWarnings} checked={settings.dependencyWarnings} onChange={set('dependencyWarnings')} />
        </Row>
        <Row icon="braces" title={t.settings.verbose} description={t.settings.verboseDesc}>
          <Toggle label={t.settings.verbose} checked={settings.verbose} onChange={set('verbose')} />
        </Row>

        <h2 className="section-title">{t.settings.general}</h2>
        <Row icon="info" title={t.settings.notifications} description={t.settings.notificationsDesc}>
          <Toggle label={t.settings.notifications} checked={settings.notifications} onChange={set('notifications')} />
        </Row>
        <Row icon="pin" title={t.settings.tray} description={t.settings.trayDesc}>
          <Toggle label={t.settings.tray} checked={settings.keepInTray} onChange={set('keepInTray')} />
        </Row>

        <h2 className="section-title">{t.settings.about}</h2>
        <div className="settings-card settings-about">
          <div className="settings-about__grid">
            <span>{t.settings.aboutRows.studio}</span>
            <strong className="tabular">{info?.version}</strong>
            <span>{t.settings.aboutRows.agent}</span>
            <strong className="tabular">{info?.agent}</strong>
            <span>{t.settings.aboutRows.electron}</span>
            <strong className="tabular">{info?.electron}</strong>
            <span>{t.settings.aboutRows.chromium}</span>
            <strong className="tabular">{info?.chrome}</strong>
            <span>{t.settings.aboutRows.node}</span>
            <strong className="tabular">{info?.node}</strong>
            <span>{t.settings.aboutRows.windows}</span>
            <strong className="tabular">{info?.osRelease}</strong>
          </div>
          <UpdatesPanel />
          <div className="settings-about__actions">
            <Button icon="folderOpen" onClick={() => info && void window.capmac.invoke('app:open-path', { path: info.configDir })}>
              {t.settings.openFolder}
            </Button>
            <span className="faint">{t.settings.sharedNote}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
