import { useEffect, useRef, useState } from 'react';
import type { Check, DiscoveredMac, ErrorInfo } from '../../../shared/contract';
import { openProject, pickProject, startSession } from '../../state/actions';
import { toast, useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { useMacs } from '../../state/macs';
import { useRemote } from '../../state/remote';
import { signalUrlProblem } from '@capmac/core/shared/remote';
import { Logo } from '../../ui/AppIcon';
import { Button } from '../../ui/Button';
import { InfoBar, Spinner } from '../../ui/Feedback';
import { PasswordField, Switch, TextField } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { CheckList } from '../macs/CheckList';
import './onboarding.css';

type Step = 'welcome' | 'prepare' | 'find' | 'signin' | 'health' | 'done';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'find', label: 'Find' },
  { id: 'signin', label: 'Sign in' },
  { id: 'health', label: 'Check' },
  { id: 'done', label: 'Run' },
];

function Stepper({ step }: { step: Step }) {
  const index = STEPS.findIndex((s) => s.id === step);
  if (index < 0) return <span />;
  return (
    <ol className="ob-stepper" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className={i < index ? 'is-done' : i === index ? 'is-current' : ''} aria-current={i === index ? 'step' : undefined}>
          <span className="ob-stepper__dot">{i < index ? <Icon name="check" size={12} /> : i + 1}</span>
          <span className="ob-stepper__label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function HeroArt() {
  return (
    <svg className="ob-hero" viewBox="0 0 360 150" aria-hidden="true">
      {/* Windows laptop */}
      <rect x="18" y="34" width="112" height="72" rx="7" className="hero-device" />
      <rect x="26" y="42" width="96" height="56" rx="3" className="hero-screen" />
      <path d="M8 112h132l-8 8H16z" className="hero-device" />
      <rect x="34" y="52" width="40" height="5" rx="2.5" className="hero-line" />
      <rect x="34" y="62" width="64" height="5" rx="2.5" className="hero-line" />
      <rect x="34" y="72" width="28" height="5" rx="2.5" className="hero-line hero-line--accent" />
      {/* link */}
      <path d="M142 74h56" className="hero-link" />
      <circle cx="170" cy="74" r="13" className="hero-badge" />
      <path d="M164.5 74h11M172 70.5l3.5 3.5-3.5 3.5" className="hero-badge-glyph" />
      {/* Mac */}
      <rect x="206" y="28" width="96" height="66" rx="6" className="hero-device" />
      <rect x="213" y="35" width="82" height="52" rx="3" className="hero-screen" />
      <path d="M244 94h20l4 16h-28z" className="hero-device" />
      <rect x="232" y="110" width="44" height="4" rx="2" className="hero-device" />
      {/* iPhone */}
      <rect x="296" y="50" width="46" height="88" rx="10" className="hero-phone" />
      <rect x="301" y="56" width="36" height="76" rx="6" className="hero-phone-screen" />
      <path d="M315 85v18l14-9z" className="hero-play" />
    </svg>
  );
}

function Welcome({ next }: { next: () => void }) {
  return (
    <div className="ob-page ob-page--welcome">
      <HeroArt />
      <h1 className="ob-title ob-title--display">Build and run your iOS&nbsp;app from Windows</h1>
      <p className="ob-lead">CapMac Studio pairs this PC with a Mac on your network. Your Capacitor app is built there with Xcode and shows up here, live, on the iOS simulator.</p>
      <div className="ob-actions ob-actions--center">
        <Button size="lg" variant="accent" onClick={next} data-autofocus>
          Get started
        </Button>
      </div>
      <p className="ob-fine">Takes about two minutes. You need a Mac with Xcode on the same network.</p>
    </div>
  );
}

function Prepare({ next, back }: { next: () => void; back: () => void }) {
  return (
    <div className="ob-page">
      <h1 className="ob-title">Prepare your Mac</h1>
      <p className="ob-lead">Two settings on the Mac, once.</p>
      <div className="ob-cards">
        <div className="ob-card">
          <span className="ob-card__icon">
            <Icon name="plugConnected" size={20} />
          </span>
          <div>
            <div className="ob-card__title">Turn on Remote Login</div>
            <div className="ob-card__text">
              System Settings › General › Sharing › <strong>Remote Login</strong>. CapMac talks to the Mac over SSH; nothing else is installed.
            </div>
          </div>
        </div>
        <div className="ob-card">
          <span className="ob-card__icon">
            <Icon name="mac" size={20} />
          </span>
          <div>
            <div className="ob-card__title">Stay signed in to the Mac</div>
            <div className="ob-card__text">iOS simulators only run inside a desktop session. On a Mac without a screen, turn on automatic login.</div>
          </div>
        </div>
      </div>
      <InfoBar tone="info" title="Windows may ask about network access">
        To find Macs, CapMac Studio listens for them on your local network. If Windows asks, allow it on <strong>private networks</strong>.
      </InfoBar>
      <div className="ob-actions">
        <Button variant="subtle" onClick={back}>
          Back
        </Button>
        <Button variant="accent" onClick={next} iconRight="arrowRight">
          Find my Mac
        </Button>
      </div>
    </div>
  );
}

function Find({ next, back }: { next: (mac: { host: string; port: number; label?: string }) => void; back: () => void }) {
  const [state, setState] = useState<'scanning' | 'done'>('scanning');
  const [found, setFound] = useState<DiscoveredMac[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(false);
  const scan = async () => {
    setState('scanning');
    try {
      const list = await call('macs.discover', { timeoutMs: 3500 });
      setFound(list);
      if (list.length === 1) setSelected(list[0]!.host);
      if (list.length === 0) setShowManual(true);
    } catch {
      setFound([]);
      setShowManual(true);
    } finally {
      setState('done');
    }
  };
  useEffect(() => {
    void scan();
  }, []);
  const chosen = found.find((m) => m.host === selected);
  const manualValue = manual.trim();
  const canContinue = showManual ? Boolean(manualValue) : Boolean(chosen);
  return (
    <div className="ob-page">
      <h1 className="ob-title">Find your Mac</h1>
      <p className="ob-lead">Macs with Remote Login on your network.</p>
      <div className="ob-list" role="radiogroup" aria-label="Macs found" aria-busy={state === 'scanning'}>
        {found.map((m) => (
          <button
            key={`${m.host}:${m.port}`}
            type="button"
            role="radio"
            aria-checked={selected === m.host && !showManual}
            className={`ob-mac${selected === m.host && !showManual ? ' is-selected' : ''}`}
            onClick={() => {
              setSelected(m.host);
              setShowManual(false);
            }}
            onDoubleClick={() => next({ host: m.host, port: m.port, label: m.name })}
          >
            <span className="ob-mac__icon">
              <Icon name="mac" size={20} />
            </span>
            <span className="ob-mac__text">
              <span className="ob-mac__name">{m.name}</span>
              <span className="ob-mac__host mono">
                {m.host}
                {m.addresses[0] ? ` · ${m.addresses[0]}` : ''}
              </span>
            </span>
            {selected === m.host && !showManual && <Icon name="checkCircle" size={20} filled className="ob-mac__check" />}
          </button>
        ))}
        {state === 'scanning' && (
          <div className="ob-scanning">
            <span className="ob-radar" aria-hidden="true" />
            Looking for Macs…
          </div>
        )}
        {state === 'done' && found.length === 0 && (
          <div className="ob-empty">
            <strong>No Macs found.</strong> Check that Remote Login is on and that both computers are on the same network (a VPN can hide the Mac). You can also type its address.
          </div>
        )}
      </div>
      {showManual ? (
        <TextField label="Mac address" placeholder="ik-macbook.local or 192.168.1.20" value={manual} onChange={(e) => setManual(e.target.value)} hint="The Mac’s name from System Settings › General › Sharing, or its IP address." data-autofocus />
      ) : (
        <button type="button" className="btn btn--ghost btn--sm ob-manual" onClick={() => setShowManual(true)}>
          Enter an address instead
        </button>
      )}
      <div className="ob-actions">
        <Button variant="subtle" onClick={back}>
          Back
        </Button>
        <span className="ob-actions__spacer" />
        <Button icon="refresh" onClick={() => void scan()} disabled={state === 'scanning'}>
          Scan again
        </Button>
        <Button
          variant="accent"
          disabled={!canContinue}
          iconRight="arrowRight"
          onClick={() => {
            if (showManual) {
              const m = manualValue.match(/^(?:[^@]+@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
              next({ host: (m?.[1] ?? manualValue).replace(/^\[|\]$/g, ''), port: m?.[2] ? Number(m[2]) : 22 });
            } else if (chosen) next({ host: chosen.host, port: chosen.port, label: chosen.name });
          }}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function SignIn({ mac, back, paired }: { mac: { host: string; port: number; label?: string }; back: () => void; paired: (name: string) => void }) {
  const info = useApp((s) => s.info);
  const steps = useMacs((s) => s.pairing);
  const [user, setUser] = useState(info?.userName ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  // Remote access: off unless asked for (it can be turned on later in Macs).
  const server = useRemote((s) => s.server);
  const [remote, setRemote] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  // Progress from an earlier pairing does not belong to this one.
  useEffect(() => {
    useMacs.setState({ pairing: [] });
    void useRemote.getState().loadServer();
  }, []);
  const needsServer = remote && !server?.url;
  const submit = async () => {
    if (!user || busy) return;
    if (needsServer) {
      const problem = signalUrlProblem(serverUrl);
      if (problem) {
        setServerError(problem);
        return;
      }
    }
    setBusy(true);
    setError(null);
    useMacs.setState({ pairing: [] });
    try {
      if (needsServer) await useRemote.getState().setServer(serverUrl.trim());
      const result = await call('macs.pair', { host: mac.host, port: mac.port, username: user, password: password || undefined, label: mac.label, remote: remote || undefined });
      setPassword('');
      if (result.remote?.ok === false) {
        toast({ tone: 'caution', title: 'Paired, but remote access is not on yet', body: `${result.remote.error?.message ?? ''} Turn it on later in Macs.`.trim(), timeout: 0 });
      } else if (result.remote?.ok) {
        const test = result.remote.test;
        toast({ tone: 'success', title: 'Remote access is on', body: test?.ok && test.route ? `Tested: ${test.route === 'relay' ? 'through the relay' : 'peer to peer over the internet'}, ${test.ms} ms.` : undefined });
      }
      paired(result.mac.name);
    } catch (err) {
      setError(errorInfo(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="ob-page"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="ob-title">Sign in to {mac.label ?? mac.host}</h1>
      <p className="ob-lead">Your Mac password is used once, to install CapMac’s own SSH key. It is never stored.</p>
      <div className="ob-form">
        <TextField label="Mac user name" value={user} onChange={(e) => setUser(e.target.value.trim())} hint={<>The short name, as shown by <code>whoami</code> in Terminal on the Mac.</>} autoComplete="off" data-autofocus disabled={busy} />
        <PasswordField label="Password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        <Switch
          checked={remote}
          onChange={setRemote}
          disabled={busy}
          label="Reach this Mac from anywhere"
          description="Also build and run on it when you’re away from its network, over the internet. You can turn this on later in Macs."
        />
        {needsServer && (
          <TextField
            label="Your signaling server"
            placeholder="wss://signal.example.com"
            value={serverUrl}
            disabled={busy}
            error={serverError}
            hint="Remote access goes through a small server of your own (see services/signal). CapMac remembers it."
            onChange={(e) => {
              setServerUrl(e.target.value);
              setServerError(null);
            }}
          />
        )}
      </div>
      {busy || steps.length > 0 ? (
        <ul className="ob-progress" aria-live="polite">
          {steps.map((s) => (
            <li key={s.id} className={`is-${s.status}`}>
              {s.status === 'running' ? <Spinner size={16} /> : s.status === 'ok' ? <Icon name="checkCircle" size={16} filled /> : <Icon name="errorCircle" size={16} filled />}
              <span>{s.title}</span>
              {s.detail && <span className="faint">{s.detail}</span>}
            </li>
          ))}
          {busy && steps.length === 0 && (
            <li className="is-running">
              <Spinner size={16} />
              <span>Connecting…</span>
            </li>
          )}
        </ul>
      ) : null}
      {error && (
        <InfoBar tone="critical" title={error.message} live>
          {error.hint}
        </InfoBar>
      )}
      <div className="ob-actions">
        <Button variant="subtle" onClick={back} disabled={busy}>
          Back
        </Button>
        <Button type="submit" variant="accent" busy={busy} disabled={!user}>
          Pair
        </Button>
      </div>
    </form>
  );
}

function Health({ name, next }: { name: string; next: () => void }) {
  const health = useMacs((s) => s.health[name]);
  const runHealth = useMacs((s) => s.runHealth);
  const mac = useMacs((s) => s.macs.find((m) => m.name === name));
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runHealth(name);
  }, [name, runHealth]);
  const checks: Check[] = health?.checks.filter((c) => c.group === 'mac') ?? [];
  const failing = checks.filter((c) => c.level === 'fail');
  return (
    <div className="ob-page ob-page--wide">
      <h1 className="ob-title">Checking {mac?.label ?? 'your Mac'}</h1>
      <p className="ob-lead">Xcode, simulators and tools. CapMac fixes what it can with one click.</p>
      <CheckList mac={name} checks={checks} checking={health?.status === 'checking'} />
      {health?.status === 'error' && health.error && (
        <InfoBar tone="critical" title={health.error.message}>
          {health.error.hint}
        </InfoBar>
      )}
      <div className="ob-actions">
        <Button icon="refresh" onClick={() => void runHealth(name)} disabled={health?.status === 'checking'}>
          Check again
        </Button>
        <span className="ob-actions__spacer" />
        <Button variant="accent" iconRight="arrowRight" onClick={next} disabled={health?.status === 'checking'}>
          {failing.length ? 'Continue anyway' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}

function Done({ name }: { name: string }) {
  const mac = useMacs((s) => s.macs.find((m) => m.name === name));
  const [busy, setBusy] = useState(false);
  const finish = () => void useApp.getState().updateSettings({ onboardingDone: true });
  const runSample = async () => {
    setBusy(true);
    try {
      const { path } = await call('projects.createSample', {});
      finish();
      if (await openProject(path)) void startSession(path, 'run');
    } catch (err) {
      toast({ tone: 'critical', title: 'Could not create the sample app', body: errorInfo(err).message });
      setBusy(false);
    }
  };
  return (
    <div className="ob-page ob-page--welcome">
      <div className="ob-success" aria-hidden="true">
        <Icon name="checkCircle" size={48} filled />
      </div>
      <h1 className="ob-title ob-title--display">You’re set</h1>
      <p className="ob-lead">
        {mac?.label ?? 'Your Mac'} is paired{mac?.xcode ? ` (Xcode ${mac.xcode})` : ''}. See it work: run the sample app on the iOS simulator.
      </p>
      <div className="ob-actions ob-actions--center">
        <Button size="lg" variant="accent" icon="play" iconFilled busy={busy} onClick={() => void runSample()} data-autofocus>
          Run the sample app
        </Button>
        <Button
          size="lg"
          icon="folderOpen"
          onClick={() => {
            finish();
            useApp.getState().navigate({ name: 'home' });
            void pickProject();
          }}
        >
          Open my app
        </Button>
      </div>
      <p className="ob-fine">The first run installs packages and builds on the Mac: about a minute. After that, changes take seconds.</p>
    </div>
  );
}

export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [mac, setMac] = useState<{ host: string; port: number; label?: string } | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const macs = useMacs((s) => s.macs);
  const navigate = useApp((s) => s.navigate);
  const skip = () => {
    void useApp.getState().updateSettings({ onboardingDone: true });
    navigate({ name: 'home' });
  };
  return (
    <div className="onboarding">
      <div className="ob-top">
        <Logo size={20} />
        <Stepper step={step} />
        <button type="button" className="btn btn--subtle btn--sm ob-skip" onClick={skip}>
          {macs.length ? 'Close' : 'Skip for now'}
        </button>
      </div>
      <main className="ob-main" key={step}>
        {step === 'welcome' && <Welcome next={() => setStep('prepare')} />}
        {step === 'prepare' && <Prepare next={() => setStep('find')} back={() => setStep('welcome')} />}
        {step === 'find' && (
          <Find
            back={() => setStep('prepare')}
            next={(m) => {
              setMac(m);
              setStep('signin');
            }}
          />
        )}
        {step === 'signin' && mac && (
          <SignIn
            mac={mac}
            back={() => setStep('find')}
            paired={(name) => {
              setPaired(name);
              setStep('health');
            }}
          />
        )}
        {step === 'health' && paired && <Health name={paired} next={() => setStep('done')} />}
        {step === 'done' && paired && <Done name={paired} />}
      </main>
    </div>
  );
}
