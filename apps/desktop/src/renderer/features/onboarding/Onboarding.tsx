import { useEffect, useRef, useState } from 'react';
import type { Check, DiscoveredMac, ErrorInfo } from '../../../shared/contract';
import { openProject, pickProject, preferThisPc, startSession } from '../../state/actions';
import { toast, useApp } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { useMacs } from '../../state/macs';
import { useRemote } from '../../state/remote';
import { signalUrlProblem } from '@capmac/core/shared/remote';
import { t, tidy } from '../../../shared/i18n';
import { Logo } from '../../ui/AppIcon';
import { Button } from '../../ui/Button';
import { Badge, InfoBar, Spinner } from '../../ui/Feedback';
import { PasswordField, Switch, TextField } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { CheckList } from '../macs/CheckList';
import { Rich } from '../../ui/Rich';
import './onboarding.css';

type Step = 'welcome' | 'prepare' | 'find' | 'signin' | 'health' | 'done';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'prepare', label: t.onboarding.steps.prepare },
  { id: 'find', label: t.onboarding.steps.find },
  { id: 'signin', label: t.onboarding.steps.signin },
  { id: 'health', label: t.onboarding.steps.health },
  { id: 'done', label: t.onboarding.steps.done },
];

function Stepper({ step }: { step: Step }) {
  const index = STEPS.findIndex((s) => s.id === step);
  if (index < 0) return <span />;
  return (
    <ol className="ob-stepper" aria-label={t.onboarding.stepsLabel}>
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

function Welcome({ next, noMac }: { next: () => void; noMac: () => void }) {
  return (
    <div className="ob-page ob-page--welcome">
      <HeroArt />
      <h1 className="ob-title ob-title--display">{t.onboarding.welcome.title}</h1>
      <p className="ob-lead">{t.onboarding.welcome.lead}</p>
      <div className="ob-actions ob-actions--center">
        <Button size="lg" variant="accent" onClick={next} data-autofocus>
          {t.onboarding.welcome.start}
        </Button>
        <Button size="lg" variant="subtle" icon="desktop" onClick={noMac}>
          {t.pc.welcome}
        </Button>
      </div>
      <p className="ob-fine">{t.onboarding.welcome.fine}</p>
    </div>
  );
}

function Prepare({ next, back }: { next: () => void; back: () => void }) {
  return (
    <div className="ob-page">
      <h1 className="ob-title">{t.onboarding.prepare.title}</h1>
      <p className="ob-lead">{t.onboarding.prepare.lead}</p>
      <div className="ob-cards">
        <div className="ob-card">
          <span className="ob-card__icon">
            <Icon name="plugConnected" size={20} />
          </span>
          <div>
            <div className="ob-card__title">{t.onboarding.prepare.remoteLoginTitle}</div>
            <div className="ob-card__text">
              <Rich text={t.onboarding.prepare.remoteLoginText} />
            </div>
          </div>
        </div>
        <div className="ob-card">
          <span className="ob-card__icon">
            <Icon name="mac" size={20} />
          </span>
          <div>
            <div className="ob-card__title">{t.onboarding.prepare.stayTitle}</div>
            <div className="ob-card__text">{t.onboarding.prepare.stayText}</div>
          </div>
        </div>
      </div>
      <InfoBar tone="info" title={t.onboarding.prepare.networkTitle}>
        <Rich text={t.onboarding.prepare.networkText} />
      </InfoBar>
      <div className="ob-actions">
        <Button variant="subtle" onClick={back}>
          {t.common.back}
        </Button>
        <Button variant="accent" onClick={next} iconRight="arrowRight">
          {t.onboarding.prepare.findMac}
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
      <h1 className="ob-title">{t.onboarding.find.title}</h1>
      <p className="ob-lead">{t.onboarding.find.lead}</p>
      <div className="ob-list" role="radiogroup" aria-label={t.onboarding.find.listLabel} aria-busy={state === 'scanning'}>
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
              <span className="ob-mac__name">
                {m.name}
                {m.via === 'tailscale' && <Badge tone="outline">{t.onboarding.find.tailscale}</Badge>}
              </span>
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
            {t.onboarding.find.scanning}
          </div>
        )}
        {state === 'done' && found.length === 0 && (
          <div className="ob-empty">
            <strong>{t.onboarding.find.noneTitle}</strong> {t.onboarding.find.noneBody}
          </div>
        )}
      </div>
      {showManual ? (
        <TextField label={t.onboarding.find.addressLabel} placeholder={t.onboarding.find.addressPlaceholder} value={manual} onChange={(e) => setManual(e.target.value)} hint={t.onboarding.find.addressHint} data-autofocus />
      ) : (
        <button type="button" className="btn btn--ghost btn--sm ob-manual" onClick={() => setShowManual(true)}>
          {t.onboarding.find.typeAddress}
        </button>
      )}
      <div className="ob-actions">
        <Button variant="subtle" onClick={back}>
          {t.common.back}
        </Button>
        <span className="ob-actions__spacer" />
        <Button icon="refresh" onClick={() => void scan()} disabled={state === 'scanning'}>
          {t.onboarding.find.searchAgain}
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
          {t.common.continue}
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
        setServerError(tidy(problem));
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
        toast({ tone: 'caution', title: t.onboarding.signIn.pairedNoRemote, body: t.onboarding.signIn.pairedNoRemoteBody(tidy(result.remote.error?.message) ?? ''), timeout: 0 });
      } else if (result.remote?.ok) {
        const test = result.remote.test;
        toast({ tone: 'success', title: t.onboarding.signIn.remoteOn, body: test?.ok && test.route ? t.remote.toast.testPassed(test.route, test.ms) : undefined });
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
      <h1 className="ob-title">{t.onboarding.signIn.title(mac.label ?? mac.host)}</h1>
      <p className="ob-lead">{t.onboarding.signIn.lead}</p>
      <div className="ob-form">
        <TextField label={t.onboarding.signIn.user} value={user} onChange={(e) => setUser(e.target.value.trim())} hint={<Rich text={t.onboarding.signIn.userHint} />} autoComplete="off" data-autofocus disabled={busy} />
        <PasswordField label={t.onboarding.signIn.password} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        <Switch
          checked={remote}
          onChange={setRemote}
          disabled={busy}
          label={t.onboarding.signIn.remote}
          description={t.onboarding.signIn.remoteDesc}
        />
        {needsServer && (
          <TextField
            label={t.onboarding.signIn.server}
            placeholder={t.remote.server.placeholder}
            value={serverUrl}
            disabled={busy}
            error={serverError}
            hint={t.onboarding.signIn.serverHint}
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
              <span>{tidy(s.title)}</span>
              {s.detail && <span className="faint">{tidy(s.detail)}</span>}
            </li>
          ))}
          {busy && steps.length === 0 && (
            <li className="is-running">
              <Spinner size={16} />
              <span>{t.common.connecting}</span>
            </li>
          )}
        </ul>
      ) : null}
      {error && (
        <InfoBar tone="critical" title={tidy(error.message)} live>
          {tidy(error.hint)}
        </InfoBar>
      )}
      <div className="ob-actions">
        <Button variant="subtle" onClick={back} disabled={busy}>
          {t.common.back}
        </Button>
        <Button type="submit" variant="accent" busy={busy} disabled={!user}>
          {t.onboarding.signIn.pair}
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
      <h1 className="ob-title">{t.onboarding.health.title(mac?.label ?? t.common.yourMac)}</h1>
      <p className="ob-lead">{t.onboarding.health.lead}</p>
      <CheckList mac={name} checks={checks} checking={health?.status === 'checking'} />
      {health?.status === 'error' && health.error && (
        <InfoBar tone="critical" title={tidy(health.error.message)}>
          {tidy(health.error.hint)}
        </InfoBar>
      )}
      <div className="ob-actions">
        <Button icon="refresh" onClick={() => void runHealth(name)} disabled={health?.status === 'checking'}>
          {t.onboarding.health.checkAgain}
        </Button>
        <span className="ob-actions__spacer" />
        <Button variant="accent" iconRight="arrowRight" onClick={next} disabled={health?.status === 'checking'}>
          {failing.length ? t.onboarding.health.continueAnyway : t.common.continue}
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
      toast({ tone: 'critical', title: t.home.sampleFailed, body: errorInfo(err).message });
      setBusy(false);
    }
  };
  return (
    <div className="ob-page ob-page--welcome">
      <div className="ob-success" aria-hidden="true">
        <Icon name="checkCircle" size={48} filled />
      </div>
      <h1 className="ob-title ob-title--display">{t.onboarding.done.title}</h1>
      <p className="ob-lead">{t.onboarding.done.lead(mac?.label ?? t.common.yourMacTitle, mac?.xcode)}</p>
      <div className="ob-actions ob-actions--center">
        <Button size="lg" variant="accent" icon="play" iconFilled busy={busy} onClick={() => void runSample()} data-autofocus>
          {t.onboarding.done.runSample}
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
          {t.onboarding.done.openApp}
        </Button>
      </div>
      <p className="ob-fine">{t.onboarding.done.fine}</p>
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
          {macs.length ? t.common.close : t.onboarding.skip}
        </button>
      </div>
      <main className="ob-main" key={step}>
        {step === 'welcome' && (
          <Welcome
            next={() => setStep('prepare')}
            noMac={() => {
              // No Mac: the app opened next builds on this PC. Pick it right away.
              preferThisPc();
              skip();
              toast({ tone: 'info', title: t.pc.welcome, body: t.pc.welcomeHint });
              void pickProject();
            }}
          />
        )}
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
