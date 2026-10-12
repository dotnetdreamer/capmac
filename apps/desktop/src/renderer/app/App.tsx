import { lazy, Suspense, useEffect } from 'react';
import type { AppCommand } from '../../shared/contract';
import { useApp, usePrompts } from '../state/app';
import { openProject, startSession, stopAll } from '../state/actions';
import { setConsoleLimit } from '../state/console';
import { handleBatch } from '../state/dispatch';
import { call } from '../state/engine';
import { resolveMac, useMacs } from '../state/macs';
import { CommandPalette } from './CommandPalette';
import { DropOverlay } from './DropOverlay';
import { EngineBanner } from './EngineBanner';
import { PromptHost } from './PromptHost';
import { useShortcuts } from './shortcuts';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { Toaster } from './Toaster';
import { Home } from '../features/home/Home';
import { ErrorBoundary } from '../ui/ErrorBoundary';

// Views other than Home load on demand: a fast cold start.
const Workspace = lazy(() => import('../features/workspace/Workspace').then((m) => ({ default: m.Workspace })));
const Devices = lazy(() => import('../features/devices/Devices').then((m) => ({ default: m.Devices })));
const Macs = lazy(() => import('../features/macs/Macs').then((m) => ({ default: m.Macs })));
const SettingsPage = lazy(() => import('../features/settings/Settings').then((m) => ({ default: m.Settings })));
const Onboarding = lazy(() => import('../features/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })));

function applyAccent(accent: string | null) {
  if (accent) document.documentElement.style.setProperty('--sys-accent', accent);
}

function onCommand(command: AppCommand) {
  const app = useApp.getState();
  switch (command.type) {
    case 'open-project':
      void openProject(command.path);
      break;
    case 'start': {
      const path = command.projectPath ?? app.settings?.lastProject;
      if (path) {
        app.navigate({ name: 'project', path });
        void startSession(path, command.mode);
      }
      break;
    }
    case 'stop':
      void stopAll();
      break;
    case 'navigate':
      app.navigate({ name: command.to });
      break;
  }
}

let booted = false;

async function bootstrap() {
  if (booted) return;
  booted = true;
  const capmac = window.capmac;
  const [info, settings] = await Promise.all([capmac.invoke('app:info'), capmac.invoke('app:get-settings')]);
  document.documentElement.dataset.mica = String(info.mica);
  applyAccent(info.accent);
  setConsoleLimit(settings.consoleLimit);
  capmac.onEvents(handleBatch);
  capmac.onPrompt((prompt) => usePrompts.getState().push(prompt));
  capmac.onEngineStatus((engine) => {
    useApp.setState({ engine });
    if (engine.state === 'ready') void useMacs.getState().refresh();
  });
  capmac.onSettings((next) => {
    setConsoleLimit(next.consoleLimit);
    useApp.setState({ settings: next });
  });
  capmac.onCommand(onCommand);
  capmac.onAccent(applyAccent);
  useApp.setState({ info, settings });
  capmac.ready();

  await useMacs.getState().refresh();
  const macs = useMacs.getState().macs;
  if (!settings.onboardingDone && macs.length === 0) {
    useApp.getState().navigate({ name: 'onboarding' });
    return;
  }
  // Say hello to the default Mac in the background: the status chip shows how it went.
  const mac = resolveMac(macs);
  if (mac) void call('macs.connect', { name: mac.name }).catch(() => undefined);
}

function View() {
  const route = useApp((s) => s.route);
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'project':
      return <Workspace key={route.path.toLowerCase()} path={route.path} />;
    case 'devices':
      return <Devices />;
    case 'macs':
      return <Macs />;
    case 'settings':
      return <SettingsPage />;
    default:
      return null;
  }
}

export function App() {
  const ready = useApp((s) => Boolean(s.info && s.settings));
  const route = useApp((s) => s.route.name);
  const collapsed = useApp((s) => s.settings?.sidebarCollapsed ?? false);
  useEffect(() => {
    void bootstrap();
  }, []);
  useShortcuts();

  if (!ready) return <div className="app app--loading" aria-busy="true" />;
  if (route === 'onboarding') {
    return (
      <div className="app app--onboarding">
        <TitleBar minimal />
        <Suspense fallback={null}>
          <Onboarding />
        </Suspense>
        <PromptHost />
        <Toaster />
      </div>
    );
  }
  return (
    <div className={`app${collapsed ? ' app--sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <TitleBar />
      <div className="app__body">
        <Sidebar collapsed={collapsed} />
        <main id="main" className="layer" tabIndex={-1}>
          <EngineBanner />
          <ErrorBoundary label="This page">
            <Suspense fallback={<div className="view-loading" />}>
              <View />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette />
      <PromptHost />
      <Toaster />
      <DropOverlay />
    </div>
  );
}
