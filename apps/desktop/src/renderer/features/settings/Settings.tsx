import type { ReactNode } from 'react';
import type { Settings as SettingsShape } from '../../../shared/contract';
import { useApp } from '../../state/app';
import { Button } from '../../ui/Button';
import { Segmented, Select } from '../../ui/Form';
import { Icon, type IconName } from '../../ui/Icon';
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="toggle-control">
      <span className="toggle-control__state" aria-hidden="true">
        {checked ? 'On' : 'Off'}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
        <span className="switch__thumb" />
      </button>
    </span>
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
          description="Smooth streams the screen as video, up to 60 frames a second. Compatible sends a few screenshots a second; capmac switches to it by itself when the smooth stream can’t run."
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
        <Row icon="info" title="Notifications" description="Tell me when a build finishes or fails while capmac Studio is in the background.">
          <Toggle label="Notifications" checked={settings.notifications} onChange={set('notifications')} />
        </Row>
        <Row icon="pin" title="Keep running in the tray" description="Closing the window during a session keeps your app running; quit from the tray icon.">
          <Toggle label="Keep running in the tray" checked={settings.keepInTray} onChange={set('keepInTray')} />
        </Row>

        <h2 className="section-title">About</h2>
        <div className="settings-card settings-about">
          <div className="settings-about__grid">
            <span>capmac Studio</span>
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
          <div className="settings-about__actions">
            <Button icon="folderOpen" onClick={() => info && void window.capmac.invoke('app:open-path', { path: info.configDir })}>
              Open capmac folder
            </Button>
            <span className="faint">Paired Macs and capmac’s SSH key are shared with the capmac CLI.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
