import { useEffect, useState, type ReactNode } from 'react';
import type { Settings as SettingsShape, TakeoverInfo } from '../../../shared/contract';
import { toast, useApp } from '../../state/app';
import { signalUrlProblem } from '@capmac/core/shared/remote';
import { errorInfo } from '../../state/engine';
import { useRemote } from '../../state/remote';
import { DEPLOY_GUIDE_URL } from '../macs/RemoteAccess';
import { AgentSkillsButton } from './AgentSkills';
import { Button } from '../../ui/Button';
import { Segmented, Select, TextField, Toggle } from '../../ui/Form';
import { Icon, type IconName } from '../../ui/Icon';
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
        ? { tone: 'success', title: 'Open a new terminal to use it', body: 'Restart VS Code too, so its terminals pick it up.' }
        : { tone: 'info', title: 'Capacitor runs on this PC again', body: 'In every terminal, starting now.' });
    } catch (err) {
      toast({ tone: 'critical', title: on ? 'Could not turn it on' : 'Could not turn it off', body: errorInfo(err).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="section-title">Terminal commands</h2>
      <Row
        icon="console"
        title={<>Run <code>npx cap run ios</code> on the Mac</>}
        description={
          <>
            <code>npx cap run ios</code>, <code>ionic capacitor run ios -l</code>, <code>cap open ios</code> and <code>cap build ios</code> typed in any terminal build and
            run on your Mac. Sync and Android stay on this PC. Set <code>CAPMAC_TAKEOVER=0</code> to skip it for one command.
            {info?.on && !info.bundled && info.cli && <span className="settings-takeover__note">Runs the CapMac CLI at {info.cli}.</span>}
            {info?.cliMissing && <span className="settings-takeover__note settings-takeover__note--warn">The CapMac CLI it used is gone: turn this off and on again.</span>}
          </>
        }
      >
        <Toggle label="Run Capacitor iOS commands on the Mac" checked={info?.on ?? false} loading={!info} disabled={!info || busy} onChange={(v) => void change(v)} />
      </Row>
      <Row icon="sparkle" title="AI coding agents" description="Let Claude Code, Codex, Copilot, Cursor and other agents build, run and check your iOS app with CapMac, in all your projects or one.">
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
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const next = await useRemote.getState().setServer(url || null);
      setValue(next.url ?? '');
      toast(next.url ? { tone: 'success', title: 'Signaling server saved', body: 'Turn remote access on for a Mac in Macs.' } : { tone: 'info', title: 'Signaling server cleared' });
    } catch (err) {
      setError(errorInfo(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 className="section-title">Remote access</h2>
      <Row
        icon="globe"
        title="Signaling server"
        description={
          <>
            Your own server, which lets CapMac reach your Macs over the internet: peer to peer when the networks allow it, else through its relay. It never sees inside a connection.{' '}
            <a href={DEPLOY_GUIDE_URL} onClick={(e) => {
              e.preventDefault();
              void window.capmac.invoke('app:open-external', { url: DEPLOY_GUIDE_URL });
            }}>How to deploy it</a>
            {fromEnvironment && <span className="settings-takeover__note">Set by the CAPMAC_SIGNAL_URL environment variable.</span>}
            {server?.source === 'built-in' && <span className="settings-takeover__note">The server this build of CapMac Studio came with.</span>}
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
            aria-label="Signaling server"
            placeholder="wss://signal.example.com"
            value={value}
            disabled={fromEnvironment || busy}
            error={error}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" disabled={!dirty || fromEnvironment} busy={busy}>
            Save
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
            <h1 className="page__title">Settings</h1>
          </div>
        </header>

        <h2 className="section-title">Appearance</h2>
        <Row icon="theme" title="Theme" description="Follow Windows, or always light or dark.">
          <Segmented
            label="Theme"
            value={settings.theme}
            onChange={set('theme')}
            options={[
              { value: 'system', label: 'System', icon: 'desktop' },
              { value: 'light', label: 'Light', icon: 'sun' },
              { value: 'dark', label: 'Dark', icon: 'moon' },
            ]}
          />
        </Row>
        <Row icon="phone" title="Device frame" description="Draw a phone bezel around the simulator screen.">
          <Toggle label="Device frame" checked={settings.deviceFrame} onChange={set('deviceFrame')} />
        </Row>
        <Row
          icon="flash"
          title="Simulator stream"
          description="Smooth streams the screen as video, up to 60 frames a second. Compatible sends a few screenshots a second; CapMac switches to it by itself when the smooth stream can’t run."
        >
          <Segmented
            label="Simulator stream"
            value={settings.simulatorStream}
            onChange={set('simulatorStream')}
            options={[
              { value: 'smooth', label: 'Smooth' },
              { value: 'compatible', label: 'Compatible' },
            ]}
          />
        </Row>

        <h2 className="section-title">Editor</h2>
        <Row icon="code" title="Open problems in" description="Clicking a build error opens the file at the right line.">
          <Select
            label="Editor"
            value={settings.editor}
            onChange={set('editor')}
            width={200}
            options={[
              { value: 'vscode', label: 'Visual Studio Code' },
              { value: 'cursor', label: 'Cursor' },
              { value: 'system', label: 'Default app' },
            ]}
          />
        </Row>

        <TerminalCommands />

        <RemoteAccessSettings />

        <h2 className="section-title">Console</h2>
        <Row icon="console" title="Line limit" description="Older lines are dropped beyond this; memory stays bounded.">
          <Select
            label="Line limit"
            value={String(settings.consoleLimit)}
            onChange={(v) => set('consoleLimit')(Number(v))}
            width={160}
            options={[
              { value: '50000', label: '50,000 lines' },
              { value: '100000', label: '100,000 lines' },
              { value: '200000', label: '200,000 lines' },
              { value: '500000', label: '500,000 lines' },
            ]}
          />
        </Row>
        <Row icon="clock" title="Timestamps" description="Show when each line arrived.">
          <Toggle label="Timestamps" checked={settings.consoleTimestamps} onChange={set('consoleTimestamps')} />
        </Row>
        <Row icon="text" title="Wrap long lines">
          <Toggle label="Wrap long lines" checked={settings.consoleWrap} onChange={set('consoleWrap')} />
        </Row>
        <Row icon="document" title="System logs" description="Also show NSLog and os_log output, like Xcode’s console. Applies to the next run.">
          <Toggle label="System logs" checked={settings.osLogs} onChange={set('osLogs')} />
        </Row>

        <h2 className="section-title">Builds</h2>
        <Row icon="warning" title="Warnings from dependencies" description="Show warnings from Pods, Swift packages and node_modules in Problems.">
          <Toggle label="Warnings from dependencies" checked={settings.dependencyWarnings} onChange={set('dependencyWarnings')} />
        </Row>
        <Row icon="braces" title="Full tool output" description="Stream raw xcodebuild and npm output into the console (verbose).">
          <Toggle label="Full tool output" checked={settings.verbose} onChange={set('verbose')} />
        </Row>

        <h2 className="section-title">Behaviour</h2>
        <Row icon="info" title="Notifications" description="Tell me when a build finishes or fails while CapMac Studio is in the background.">
          <Toggle label="Notifications" checked={settings.notifications} onChange={set('notifications')} />
        </Row>
        <Row icon="pin" title="Keep running in the tray" description="Closing the window during a session keeps your app running; quit from the tray icon.">
          <Toggle label="Keep running in the tray" checked={settings.keepInTray} onChange={set('keepInTray')} />
        </Row>

        <h2 className="section-title">About</h2>
        <div className="settings-card settings-about">
          <div className="settings-about__grid">
            <span>CapMac Studio</span>
            <strong className="tabular">{info?.version}</strong>
            <span>Mac agent</span>
            <strong className="tabular">{info?.agent}</strong>
            <span>Electron</span>
            <strong className="tabular">{info?.electron}</strong>
            <span>Chromium</span>
            <strong className="tabular">{info?.chrome}</strong>
            <span>Node.js</span>
            <strong className="tabular">{info?.node}</strong>
            <span>Windows</span>
            <strong className="tabular">{info?.osRelease}</strong>
          </div>
          <UpdatesPanel />
          <div className="settings-about__actions">
            <Button icon="folderOpen" onClick={() => info && void window.capmac.invoke('app:open-path', { path: info.configDir })}>
              Open CapMac folder
            </Button>
            <span className="faint">Paired Macs and CapMac’s SSH key are shared with the CapMac CLI.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
