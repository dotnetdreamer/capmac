import React from 'react';
import {AbsoluteFill, Html5Audio, Img, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {AppIcon, BloomDesktop, BloomPhone, BLOOM_GREETING, Handset, HomeScreen, MacWindow, Phone, PULSE_ACCENT, PulsePhone, WinWindow} from './Apps';
import {Atmosphere, BEAT, Brand, C, Caption, Check, Chip, Chrome, Cuts, FRAMEWORKS, FontGate, KeyCap, Note, Prompt, Sfx, Vignette, W, body, ease, mono, r} from './Film';
import {Camera, Cursor, Lift, Sheen, Words, type CameraKey} from './Motion';
import {PluggedIPhone, TwinsPipeline} from './NoMac';
import {DevicePane, Dialog, DialogButton, Glyph, Menu, PC_STEPS, ProblemPanel, RUN_DETAILS, RUN_STEPS, SOURCE, SetupSteps, SimulatorStage, StudioWindow, monoFont, stepsAt, type LogRow, type SetupStep, type StudioView} from './ProductVisuals';
import {Codicon, CodeEditor, DebugConsole, FileIcon, Panel, Row, ScreenTab, Section, StepIcon, Tabs, VSCodeWindow, VS, type ConsoleLine} from './VSCode';

// A shot holds until an interaction gives the camera a reason to move; cuts land on the music's bars
export const CHAPTERS = [
  {from: 0, duration: 240, label: 'Build iPhone apps on Windows'},
  {from: 240, duration: 240, label: 'Pair once and keep your commands'},
  {from: 480, duration: 240, label: 'Live in CapMac Studio'},
  {from: 720, duration: 240, label: 'Save and the app updates'},
  {from: 960, duration: 120, label: 'No Mac? Still fine'},
  {from: 1080, duration: 300, label: 'Set up this PC and run on an iPhone'},
  {from: 1380, duration: 120, label: 'Open-source twins'},
  {from: 1500, duration: 180, label: 'Mac and Windows apps'},
  {from: 1680, duration: 180, label: 'Logs and errors'},
  {from: 1860, duration: 180, label: 'Studio, VS Code or the terminal'},
  {from: 2040, duration: 180, label: 'Built for AI agents'},
  {from: 2220, duration: 150, label: 'Ready to ship'},
  {from: 2370, duration: 150, label: 'Get CapMac'},
] as const;
export const DURATION = 2520;

const gradient = (from: string, to: string): React.CSSProperties => ({backgroundImage: `linear-gradient(90deg, ${from}, ${to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent'});
const HEADLINE: React.CSSProperties = {fontSize: 100, fontWeight: 600, letterSpacing: -3.6, lineHeight: 1.06, justifyContent: 'center'};
const WIDE: CameraKey = {at: 0, x: 960, y: 595, scale: 1};
const at = (frame: number, key: CameraKey = WIDE): CameraKey => ({...key, at: frame});
const Dim = ({children}: {children: React.ReactNode}) => <span style={{color: '#8a91a6', marginLeft: 12}}>{children}</span>;

/* ---------- 1. The promise ---------- */

// The first frame is the thumbnail GitHub shows, so the promise is on screen from it and the title only drifts
const Hook = () => {
  const f = useCurrentFrame();
  const lift = ease(f, 168, 224);
  return <AbsoluteFill>
    <div style={{position: 'absolute', left: 78, top: 56}}><Brand/></div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 296 - lift * 220, transform: `scale(${(1 - lift * .4) * (1 + Math.min(f, 168) / 4200)})`, transformOrigin: '50% 0', opacity: 1 - r(f, 190, 222)}}>
      <Words frame={f} from={-60} text="Build iPhone apps" style={HEADLINE}/>
      <Words frame={f} from={-60} text="on Windows" style={HEADLINE} wordStyle={(_, i) => gradient(i ? '#cfd3f6' : '#dccfff', i ? '#9fe6c6' : '#cfd3f6')}/>
      <Words frame={f} from={-60} text="With your Mac, or with no Mac at all" style={{fontSize: 36, color: '#ebe7ef', marginTop: 34, justifyContent: 'center', letterSpacing: -.4}} wordStyle={(_, i) => i >= 5 ? {color: C.mint} : undefined}/>
      <div style={{display: 'flex', justifyContent: 'center', gap: 14, marginTop: 50}}>
        {FRAMEWORKS.map((framework, i) => {const p = ease(f, 18 + i * 7, 34 + i * 7); return <Chip key={framework.name} dot={framework.dot} style={{opacity: p, transform: `translateY(${(1 - p) * 16}px) scale(${.94 + p * .06})`}}>{framework.name}</Chip>;})}
      </div>
    </div>
    <Lift frame={f} from={172} duration={52} style={{position: 'absolute', left: W.left, top: W.top}}><PairTerminal t={0}/></Lift>
  </AbsoluteFill>;
};

/* ---------- 2. Pair once, then your usual commands ---------- */

const Line = ({top, show, children, size = 24}: {top: number; show: number; children: React.ReactNode; size?: number}) => <div style={{position: 'absolute', left: 56, top, opacity: show, transform: `translateY(${(1 - show) * 8}px)`, fontSize: size, whiteSpace: 'nowrap'}}>{children}</div>;

const PairTerminal = ({t}: {t: number}) => <Chrome title="Windows PowerShell">
  <div style={{position: 'relative', height: 641}}>
    <div style={{position: 'absolute', left: 56, top: 40}}><Prompt frame={t} start={4} text="capmac pair"/></div>
    <Line top={98} show={r(t, 20, 27)}><Check mark="◇" color="#a9b0ff">Looking for Macs with Remote Login on your network<Dim>1 found</Dim></Check></Line>
    <Line top={142} show={r(t, 34, 41)}><Check mark="◆" color={C.violet}>Which Mac? <span style={{color: C.text, fontWeight: 500}}>Mac mini</span><Dim>mac-mini.local · 192.168.1.20</Dim></Check></Line>
    <Line top={186} show={r(t, 50, 57)}><Check>Paired with <span style={{color: C.text, fontWeight: 600}}>Mac mini</span> as "mac-mini" (default)</Check></Line>
    <div style={{position: 'absolute', left: 56, top: 268, opacity: r(t, 84, 90)}}><Prompt frame={t} start={92} text="npx cap run ios"/></div>
    {[['Web build', '0.6 s'], ['Syncing Orbit to Mac mini', '12 files · 0.4 s'], ['Running Xcode build', '18 s'], ['Launching Orbit', '2.7 s']].map(([step, time], i) => <Line key={step} top={326 + i * 40} show={r(t, 114 + i * 12, 120 + i * 12)}><Check>{step}<Dim>{time}</Dim></Check></Line>)}
    <div style={{position: 'absolute', left: 56, top: 500, opacity: r(t, 166, 175), display: 'flex', alignItems: 'center', gap: 24, width: 1040, height: 104, padding: '0 30px', boxSizing: 'border-box', border: '1px solid #9bd7bc2a', borderRadius: 9, background: '#24403355'}}>
      <svg width="40" height="58" viewBox="0 0 47 63"><rect x="9" y="1" width="30" height="61" rx="7" fill="#262d35" stroke="#abc0b2" strokeWidth="2"/><path d="M20 7h8M21 55h6" stroke="#abc0b2" strokeWidth="2"/></svg>
      <div><div style={{fontSize: 27, fontWeight: 500}}><span style={{color: C.mint, marginRight: 12}}>●</span>Orbit is running on iPhone 17 Pro</div><div style={{fontSize: 19, color: '#9fb7a8', marginTop: 8}}>The iPhone simulator on Mac mini, its screen on this PC</div></div>
    </div>
  </div>
</Chrome>;

const PAIR_KEYS: CameraKey[] = [
  at(0), {at: 8, x: 960, y: 595, scale: 1},
  {at: 24, x: 820, y: 410, scale: 1.5}, {at: 74, x: 830, y: 415, scale: 1.52, drift: true},
  {at: 96, x: 800, y: 640, scale: 1.5}, {at: 150, x: 800, y: 660, scale: 1.52, drift: true},
  {at: 176, x: 800, y: 800, scale: 1.55}, {at: 226, x: 805, y: 802, scale: 1.75, drift: true}, {at: 240, x: 810, y: 804, scale: 1.85, drift: true},
];
const PairScene = () => {const f = useCurrentFrame(); return <AbsoluteFill>
  <Camera frame={f} keys={PAIR_KEYS}><div style={{position: 'absolute', left: W.left, top: W.top}}><PairTerminal t={f}/></div></Camera>
  <Caption frame={f < 86 ? f : f - 86} text={f < 86 ? 'Pair your Mac once' : 'Then keep your usual commands'} detail={f < 86 ? 'CapMac finds it on your network' : 'npx cap run ios · ionic cap run ios -l'} code={f >= 86}/>
  <Note>Mac with Xcode and Remote Login on · Remote access reaches it from anywhere</Note>
</AbsoluteFill>;};

/* ---------- 3. Live, on the drop ---------- */

const ORBIT_ROWS: LogRow[] = [
  {source: 'CM', color: SOURCE.cm, text: 'Connected to Mac mini · direct connection', at: '09:41:00'},
  {source: 'WEB', color: SOURCE.web, text: 'VITE ready · Local: http://localhost:5173/', at: '09:41:01'},
  {source: 'CAP', color: SOURCE.cap, text: 'Syncing iOS plugins and native project', at: '09:41:02'},
  {source: 'iOS', color: SOURCE.ios, text: 'Build succeeded · Launching on iPhone 17 Pro', at: '09:41:03'},
  {source: 'JS', color: SOURCE.js, text: 'Orbit mounted', at: '09:41:04', object: true},
  {source: 'CAP', color: SOURCE.cap, text: 'To Native → Haptics.impact', at: '09:41:05'},
  {source: 'iOS', color: SOURCE.ios, text: 'WebView did finish navigation', at: '09:41:05'},
  {source: 'JS', color: SOURCE.js, text: '[vite] hot updated: /src/theme.ts', at: '09:41:08', hot: true},
];
const NOW = ['Starting the dev server', 'Copying to the Mac', 'Installing packages', 'Running cap sync', 'Building', 'Starting the simulator', 'Installing', 'Opening the app'];

/** Orbit on the Mac's simulator; `t` runs from the press of Live */
const orbitView = (frame: number, t: number, patch: Partial<StudioView> = {}): StudioView => {
  const steps = stepsAt(t, 0, BEAT, RUN_STEPS, RUN_DETAILS, [0, 2, 5]);
  const running = steps.findIndex(step => step.state === 'running');
  const launched = t >= 8 * BEAT;
  const arrivals = [0, 15, 60, 95, 126, 140, 150];
  return {
    frame, mac: {title: 'Mac mini', sub: 'Connected · direct', icon: 'mac'}, target: {title: 'iPhone 17 Pro', sub: 'Simulator · iOS 26.5', icon: 'phone'},
    live: {active: t >= 0, pressed: t >= 0 && t < 6},
    bar: {mode: t >= 0 ? 'live' : 'ready', url: 'localhost:5173', peer: 'Mac mini', status: t < 0 ? 'Ready to run' : launched ? 'Ready for changes' : NOW[Math.max(0, running)]},
    pane: {title: 'Simulator', sub: 'iPhone 17 Pro · iOS 26.5', content: <SimulatorStage>{launched ? <Phone frame={t - 120} scale={.745} view={t >= 185 ? 'activity' : 'home'} tapFrame={t - 185} sheen={{frame: t, at: 122}}/> : <div style={{transform: 'scale(.745)', transformOrigin: 'top left'}}><HomeHandset/></div>}</SimulatorStage>},
    timeline: {run: 'Run #3', badge: 'Live', status: t < 0 ? 'Ready to run' : launched ? 'App running' : 'In progress', tone: launched ? 'ok' : t < 0 ? 'idle' : 'busy', steps},
    console: {tab: 'console', rows: ORBIT_ROWS.filter((_, i) => i < 7 && t >= arrivals[i])},
    ...patch,
  };
};
const HomeHandset = () => <Handset dark screen="#000"><HomeScreen/></Handset>;

const BUILD_KEYS: CameraKey[] = [
  {at: 0, x: 1347, y: 332, scale: 2.2}, {at: 8, x: 1347, y: 332, scale: 2.2},
  {at: 28, x: 1196, y: 468, scale: 1.55}, {at: 116, x: 1196, y: 470, scale: 1.6, drift: true},
  {at: 138, x: 560, y: 640, scale: 1.55}, {at: 204, x: 545, y: 650, scale: 1.62, drift: true},
  {at: 232, x: 960, y: 595, scale: 1}, at(240),
];
const BuildScene = () => {const f = useCurrentFrame(); return <AbsoluteFill>
  <Camera frame={f} keys={BUILD_KEYS}><div style={{position: 'absolute', left: W.left, top: W.top}}><StudioWindow view={orbitView(f, f)}/></div>
    <Cursor frame={f} size={22} keys={[{at: 0, x: 1340, y: 326}, {at: 10, x: 1340, y: 326}, {at: 40, x: 1250, y: 560}, {at: 120, x: 1210, y: 600}, {at: 160, x: 600, y: 760}, {at: 177, x: 480, y: 853}, {at: 210, x: 480, y: 853}]} clicks={[2, 185]}/>{[2, 185].map(click => <Sfx key={click} at={click}/>)}
  </Camera>
  <Caption frame={f < 128 ? f : f - 128} text={f < 128 ? 'Press Live in CapMac Studio' : 'The simulator, on your PC'} detail={f < 128 ? 'Every build step, as it happens' : 'Smooth video at about 60 frames a second · click, drag, scroll and type'}/>
</AbsoluteFill>;};

/* ---------- 4. Save, and every framework updates ---------- */

type Card = {framework: string; dot: string; mode: string; file: string; lead: string; before: string; after: string; tail: string; result: string; phone: (done: boolean, t: number) => React.ReactNode};
const CARDS: Card[] = [
  {framework: 'Capacitor and Ionic', dot: '#53b9ff', mode: 'Live reload', file: 'src/theme.ts', lead: 'accent: ', before: "'#C5B5EC'", after: "'#A1DDBD'", tail: ',', result: '[vite] hot updated: /src/theme.ts', phone: (done, t) => <Phone frame={70} scale={.92} variant={done ? 'mint' : 'violet'} sheen={{frame: t, at: 90}}/>},
  {framework: 'Flutter', dot: '#5fd3f6', mode: 'Hot reload', file: 'lib/home.dart', lead: 'Text(', before: `'${BLOOM_GREETING[0]}'`, after: `'${BLOOM_GREETING[1]}'`, tail: '),', result: 'Reloaded 1 of 844 libraries', phone: (done, t) => <BloomPhone frame={70} scale={.92} reloaded={done} flash={done ? t - 105 : -1}/>},
  {framework: 'React Native', dot: '#7fe7ff', mode: 'Fast Refresh', file: 'App.tsx', lead: 'accent = ', before: `'${PULSE_ACCENT[0].toUpperCase()}'`, after: `'${PULSE_ACCENT[1].toUpperCase()}'`, tail: ';', result: 'Refreshed at 09:42:31', phone: (done, t) => <PulsePhone frame={70} scale={.92} refreshed={done} sheen={{frame: t, at: 120}}/>},
];
const RELOAD_AT = [90, 105, 120];

const ReloadCard = ({card, index, t}: {card: Card; index: number; t: number}) => {
  const enter = ease(t, index * 6, index * 6 + 26);
  const typeStart = 36 + index * 8;
  const typed = Math.max(0, Math.floor((t - typeStart) * 1.4));
  const selecting = t >= typeStart - 12 && t < typeStart;
  const value = t < typeStart ? card.before : card.after.slice(0, typed);
  const done = t >= RELOAD_AT[index];
  return <div style={{position: 'absolute', left: 140 + index * 560, top: 178 + (1 - enter) * 60, width: 520, height: 846, opacity: enter, borderRadius: 18, background: '#13161fe8', border: '1px solid #ffffff1c', boxShadow: '0 30px 80px #0007', overflow: 'hidden'}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 11, padding: '22px 26px 0', fontSize: 22, fontWeight: 600}}><span style={{width: 10, height: 10, borderRadius: 5, background: card.dot, boxShadow: `0 0 12px ${card.dot}`}}/>{card.framework}<span style={{marginLeft: 'auto', fontSize: 17, fontWeight: 500, color: done ? C.mint : '#a2a8bb'}}>{card.mode}</span></div>
    <div style={{margin: '18px 22px 0', padding: '14px 18px', borderRadius: 10, background: '#0c0e14', border: '1px solid #ffffff12', fontFamily: mono, fontSize: 18, lineHeight: 1.6}}>
      <div style={{color: '#7f879b', fontSize: 14}}>{card.file}</div>
      <div style={{whiteSpace: 'nowrap', color: '#d4d4d4'}}>{card.lead}<span style={{color: '#ce9178', background: selecting ? '#264f78' : undefined}}>{value}</span>{t >= typeStart && t < typeStart + 20 && <span style={{color: C.violet}}>▌</span>}{card.tail}</div>
    </div>
    <div style={{position: 'absolute', left: (520 - 276) / 2, top: 186}}>{card.phone(done, t)}</div>
    <div style={{position: 'absolute', left: 26, right: 26, bottom: 24, height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderRadius: 8, background: done ? '#1f3a2e' : '#1a1d27', border: `1px solid ${done ? '#9bd7bc44' : '#ffffff10'}`, fontFamily: mono, fontSize: 15.5, color: done ? '#c8ecd8' : '#6f7689', opacity: done ? 1 : .6}}><span style={{color: done ? C.mint : '#6f7689'}}>{done ? '↻' : '…'}</span>{done ? card.result : 'Waiting for a save'}</div>
  </div>;
};

const RELOAD_KEYS: CameraKey[] = [{at: 0, x: 960, y: 548, scale: .97}, {at: 30, x: 960, y: 548, scale: 1}, {at: 130, x: 960, y: 552, scale: 1.02, drift: true}, {at: 165, x: 680, y: 590, scale: 1.3}, {at: 238, x: 1240, y: 590, scale: 1.3, drift: true}];
const ReloadScene = () => {const f = useCurrentFrame(); return <AbsoluteFill>
  <Camera frame={f} keys={RELOAD_KEYS}>{CARDS.map((card, i) => <ReloadCard key={card.framework} card={card} index={i} t={f}/>)}</Camera>
  <div style={{position: 'absolute', left: 0, right: 0, bottom: 36, display: 'flex', justifyContent: 'center', opacity: r(f, 64, 70) * (1 - r(f, 104, 114))}}><KeyCap down={f >= 75 && f < 82}>Ctrl + S</KeyCap></div><Sfx at={75} sound="key"/>
  <Caption frame={f} text="Save, and your app updates" detail="Live reload for Capacitor and Ionic · hot reload for Flutter · Fast Refresh for React Native"/>
</AbsoluteFill>;};

/* ---------- 5 and 6. No Mac: set up this PC, then run on an iPhone ---------- */

const PC_MENU = [
  {label: 'Mac mini', hint: 'Connected · direct', icon: 'mac' as const, checked: true},
  {label: 'This PC (no Mac)', hint: 'Builds here and runs on your iPhone over USB', icon: 'desktop' as const, separator: true},
  {label: 'Manage Macs', icon: 'settings' as const, separator: true},
];

const NoMacScene = () => {
  const f = useCurrentFrame();
  const focus = ease(f, 52, 70);
  const pc = f >= 92;
  const view = orbitView(f, 400, {
    mac: pc ? {title: 'This PC', sub: 'Needs setup', icon: 'desktop', tone: 'warn'} : {title: 'Mac mini', sub: 'Connected · direct', icon: 'mac'},
    menuOpen: false, live: {active: false}, bar: {mode: 'ready', peer: pc ? 'This PC' : 'Mac mini', status: 'Ready to run', url: 'localhost:5173'},
    overlay: <>
      {f >= 62 && f < 96 && <Menu items={PC_MENU} highlight={f >= 80 ? 1 : 0} left={310} top={64} width={330} opacity={r(f, 62, 68)}/>}
      {pc && <div style={{position: 'absolute', left: 0, right: 0, top: 104, height: 52, display: 'flex', alignItems: 'center', gap: 14, padding: '0 22px', background: '#1e2440', borderBottom: '1px solid #8fa7ff33', opacity: r(f, 96, 104), fontFamily: '"Segoe UI", sans-serif', zIndex: 12}}>
        <Glyph name="desktop" size={18} color="#a9b8ff"/><div><div style={{fontSize: 13, fontWeight: 650}}>Set up this PC to build without a Mac</div><div style={{fontSize: 11.5, color: '#a9adc6', marginTop: 2}}>CapMac installs the build tools, signs in to Apple once and downloads Xcode. The first time takes a while</div></div>
        <span style={{marginLeft: 'auto'}}><DialogButton accent pressed={f >= 112 && f < 118}>Set up</DialogButton></span>
      </div>}
    </>,
  });
  const camera: CameraKey[] = [{at: 0, x: 960, y: 560, scale: 1.04}, {at: 52, x: 960, y: 560, scale: 1.06}, {at: 72, x: 720, y: 400, scale: 1.75}, {at: 100, x: 720, y: 400, scale: 1.75}, {at: 118, x: 960, y: 520, scale: 1.28}];
  return <AbsoluteFill>
    <Camera frame={f} keys={camera}>
      <div style={{position: 'absolute', left: W.left, top: W.top, filter: `blur(${(1 - focus) * 14}px) brightness(${.55 + focus * .45})`}}><StudioWindow view={view}/></div>
      {f >= 54 && <Cursor frame={f} size={22} keys={[{at: 54, x: 1000, y: 520}, {at: 64, x: 700, y: 336}, {at: 72, x: 700, y: 336}, {at: 86, x: 690, y: 441}, {at: 98, x: 690, y: 441}, {at: 110, x: 1612, y: 427}, {at: 120, x: 1612, y: 427}]} clicks={[66, 92, 113]}/>}{[66, 92, 113].map(click => <Sfx key={click} at={click}/>)}
    </Camera>
    <AbsoluteFill style={{display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: 1 - r(f, 50, 64), transform: `scale(${1 + r(f, 50, 64) * .06})`}}>
      <Words frame={f} from={2} stagger={5} text="No Mac?" style={{...HEADLINE, fontSize: 118}}/>
      <Words frame={f} from={16} stagger={5} text="Still fine" style={{...HEADLINE, fontSize: 118}} wordStyle={(_, i) => gradient(i ? '#b9ecd6' : '#d6f5e8', i ? '#86d9b5' : '#b9ecd6')}/>
      <Words frame={f} from={30} stagger={2} text="CapMac builds, signs and installs your iPhone app from Windows alone" style={{fontSize: 30, color: '#e6efea', marginTop: 30, justifyContent: 'center'}}/>
    </AbsoluteFill>
  </AbsoluteFill>;
};

const SETUP: {title: string; desc: string; from: number; to: number}[] = [
  {title: 'Build tools', desc: 'Installs the tools that build your app. The longest step on a new PC', from: 6, to: 30},
  {title: 'iPhone connection', desc: 'Lets this PC reach your iPhone over USB, with Apple’s free Apple Devices app', from: 30, to: 42},
  {title: 'Apple sign-in', desc: 'Your Apple developer account, so CapMac can sign your app', from: 42, to: 82},
  {title: 'Signing', desc: 'Apple’s permission for your app to run on your iPhone', from: 82, to: 94},
  {title: 'Xcode download', desc: 'Xcode 26.6 from Apple, about 3 GB. CapMac keeps only the iPhone parts', from: 94, to: 124},
  {title: 'iPhone SDK', desc: 'Takes the iPhone parts out of Xcode', from: 124, to: 138},
];
const setupSteps = (t: number): SetupStep[] => SETUP.map(step => {
  const state = t >= step.to ? 'done' : t >= step.from ? 'running' : 'waiting';
  const progress = r(t, step.from, step.to);
  if (step.title === 'Xcode download') return {...step, state, progress, note: `${(progress * 2.3).toFixed(1)} GB of 2.3 GB`};
  if (step.title === 'iPhone SDK') return {...step, state, progress, note: `${Math.round(progress * 100)}%`};
  return {...step, state};
});

const SignInChoice = ({t}: {t: number}) => <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: '#08091099', zIndex: 40, opacity: r(t, 0, 6) * (1 - r(t, 26, 32))}}>
  <div style={{width: 560, borderRadius: 11, background: '#20233a', border: '1px solid #ffffff24', boxShadow: '0 30px 80px #000c', padding: '20px 22px', fontFamily: '"Segoe UI", sans-serif'}}>
    <div style={{fontSize: 16, fontWeight: 650}}>Sign in to Apple</div>
    <div style={{fontSize: 12.5, color: '#a9abc2', marginTop: 6}}>CapMac needs your Apple developer account to sign your app. Who should do the Apple part?</div>
    {[['Let CapMac do it (recommended)', 'Sign in once on Apple’s website in Microsoft Edge. CapMac remembers it and does the rest, the certificate too'], ['Do it myself', 'Sign in here in CapMac. You may need to make the certificate yourself on Apple’s website']].map(([label, hint], i) => <div key={label} style={{marginTop: 12, padding: '12px 14px', borderRadius: 8, border: `1px solid ${i === 0 ? '#bcaafa88' : '#ffffff18'}`, background: i === 0 ? (t >= 18 ? '#4a3d78' : '#33294f') : '#262a40'}}>
      <div style={{fontSize: 13.5, fontWeight: 600}}>{label}</div><div style={{fontSize: 11.5, color: '#b3b4c8', marginTop: 4}}>{hint}</div>
    </div>)}
  </div>
</div>;

const pcRows = (t: number): LogRow[] => [
  {source: 'CM', color: SOURCE.cm, text: 'Building on this PC, with no Mac', at: '09:52:10'},
  {source: 'WEB', color: SOURCE.web, text: 'VITE ready · Local: http://localhost:5173/', at: '09:52:11'},
  {source: 'CM', color: SOURCE.cm, text: 'Native project ready · Swift packages up to date', at: '09:52:12'},
  {source: 'CM', color: SOURCE.cm, text: 'Built and signed for iPhone 15 Pro', at: '09:52:31'},
  {source: 'CM', color: SOURCE.cm, text: 'Installed on iPhone 15 Pro over USB', at: '09:52:36'},
  {source: 'JS', color: SOURCE.js, text: 'Orbit mounted  ›  { platform: "ios", ready: true }', at: '09:52:38'},
  {source: 'CM', color: SOURCE.cm, text: 'iPhone 15 Pro is on Wi-Fi now · USB unplugged', at: '09:52:44'},
  {source: 'JS', color: SOURCE.js, text: '[vite] hot updated: /src/theme.ts', at: '09:52:51', hot: true},
].filter((_, i) => t >= [0, 12, 24, 54, 64, 80, 110, 124][i]);

/** Orbit built on this PC; `t` runs from the press of Live */
const pcView = (frame: number, t: number, wifi: boolean, patch: Partial<StudioView> = {}): StudioView => {
  const steps = stepsAt(t, 0, 16, PC_STEPS, ['dev server', 'up to date', 'signed', 'over USB', 'running'], [0, 1]);
  const launched = t >= 5 * 16;
  return orbitView(frame, 400, {
    mac: {title: 'This PC', sub: 'Ready', icon: 'desktop'},
    target: {title: 'iPhone 15 Pro', sub: wifi ? 'Connected · Wi-Fi' : 'Connected · USB', icon: 'phone'},
    live: {active: t >= 0, pressed: t >= 0 && t < 6},
    bar: {mode: t >= 0 ? 'live' : 'ready', url: 'localhost:5173', peer: 'iPhone 15 Pro', status: t < 0 ? 'Ready to run' : launched ? 'Ready for changes' : ['Building web files', 'Preparing the native project', 'Building and signing', 'Installing', 'Opening the app'][Math.max(0, steps.findIndex(step => step.state === 'running'))]},
    pane: {title: 'iPhone', sub: 'iPhone 15 Pro · iOS 26', content: <DevicePane name="iPhone 15 Pro" os={wifi ? 'iOS 26 · Wi-Fi' : 'iOS 26 · USB'} running={launched}/>, foot: <Glyph name={wifi ? 'wifi' : 'plug'} size={15}/>},
    timeline: {run: 'Run #1', badge: 'Live', status: t < 0 ? 'Ready to run' : launched ? 'App running' : 'In progress', tone: launched ? 'ok' : t < 0 ? 'idle' : 'busy', steps},
    console: {tab: 'console', rows: pcRows(t)},
    ...patch,
  });
};

const SETUP_KEYS: CameraKey[] = [
  {at: 0, x: 960, y: 560, scale: 1.28}, {at: 12, x: 960, y: 600, scale: 1.42}, {at: 140, x: 960, y: 600, scale: 1.44, drift: true},
  {at: 156, x: 960, y: 590, scale: 1}, {at: 178, x: 700, y: 560, scale: 1.38}, {at: 230, x: 700, y: 560, scale: 1.4, drift: true},
  {at: 250, x: 960, y: 580, scale: 1}, {at: 300, x: 960, y: 580, scale: 1.03, drift: true},
];
const PcScene = () => {
  const f = useCurrentFrame();
  const split = ease(f, 150, 176);
  const t = f - 166;
  const wifi = f >= 276;
  const dialog = <Dialog title="Build on this PC" icon="desktop" opacity={r(f, 0, 8) * (1 - r(f, 148, 154))} footer={f >= 140 ? <><DialogButton icon="health">Check this PC</DialogButton><DialogButton accent pressed={f >= 147}>Done</DialogButton></> : <><DialogButton icon="stop">Stop setup</DialogButton><DialogButton icon="health">Check this PC</DialogButton><DialogButton>Close</DialogButton></>}>
    <div style={{fontSize: 12.5, color: '#a9abc2', marginBottom: 10}}>CapMac builds and signs your iPhone app on this PC, then installs it on your iPhone over USB. No Mac needed</div>
    {f >= 140 && <div style={{display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 7, background: '#1f3a2e', border: '1px solid #6fcf9f44', color: '#c5ecd7', fontSize: 13, marginBottom: 8}}><Glyph name="check" size={15} color="#6fcf9f"/>This PC is ready to build your app</div>}
    <SetupSteps frame={f} steps={setupSteps(f)}/>
  </Dialog>;
  const view = f < 150 ? orbitView(f, 400, {mac: {title: 'This PC', sub: 'Setting up…', icon: 'desktop', tone: 'warn'}, live: {active: false}, bar: {mode: 'ready', peer: 'This PC', status: 'Ready to run', url: 'localhost:5173'}, overlay: <>{dialog}{f >= 46 && f < 80 && <SignInChoice t={f - 46}/>}</>}) : pcView(f, t, wifi);
  return <AbsoluteFill>
    <Camera frame={f} keys={SETUP_KEYS}>
      <div style={{position: 'absolute', left: W.left - split * 200, top: W.top, transform: `scale(${1 - split * .2})`, transformOrigin: '0 50%'}}><StudioWindow view={view}/></div>
      <div style={{position: 'absolute', left: 1388, top: 236, opacity: split, transform: `translateX(${(1 - split) * 120}px)`}}><PluggedIPhone frame={f} launchAt={166 + 80} variant={f >= 290 ? 'mint' : 'violet'} cable={1 - r(f, 262, 276)} wifi={r(f, 270, 282)} scale={1.12}/></div>
      <Cursor frame={f} size={22} keys={[{at: 0, x: 1180, y: 700}, {at: 52, x: 960, y: 622}, {at: 62, x: 960, y: 622}, {at: 112, x: 1120, y: 770}, {at: 141, x: 1262, y: 826}, {at: 150, x: 1262, y: 826}, {at: 164, x: 926, y: 386}, {at: 210, x: 940, y: 400}]} clicks={[62, 147, 166]}/>{[62, 147, 166].map(click => <Sfx key={click} at={click}/>)}
    </Camera>
    <Caption frame={f < 156 ? f : f < 250 ? f - 156 : f - 250} text={f < 156 ? 'One setup, one Apple sign-in' : f < 250 ? 'Press Live. This PC builds it' : 'Your app, on your iPhone'} detail={f < 156 ? 'CapMac installs the tools, signs your app and gets the iPhone SDK' : f < 250 ? 'Built and signed on Windows, installed over USB' : 'It reloads as you save, over USB or Wi-Fi'}/>
    <Note>{f < 150 ? 'Sped up · The first setup takes a while' : 'Experimental · Needs WSL 2, an iPhone and a paid Apple Developer Program membership'}</Note>
  </AbsoluteFill>;
};

/* ---------- 7. How it works without Xcode ---------- */

const TwinsScene = () => {const f = useCurrentFrame(); return <AbsoluteFill style={{transform: `scale(${1 + f / 3000})`}}>
  <div style={{position: 'absolute', left: 0, right: 0, top: 150, textAlign: 'center'}}>
    <Words frame={f} from={0} stagger={3} text="Every Xcode job has an open-source twin" style={{fontSize: 60, fontWeight: 600, letterSpacing: -1.8, justifyContent: 'center'}}/>
    <Words frame={f} from={14} stagger={2} text="CapMac runs them in its own Ubuntu, in WSL. No Linux to learn" style={{fontSize: 26, color: '#dfe9e4', marginTop: 20, justifyContent: 'center'}}/>
  </div>
  <div style={{position: 'absolute', left: 119, top: 410}}><TwinsPipeline frame={f} start={12} every={11}/></div>
  <div style={{position: 'absolute', left: 0, right: 0, top: 720, textAlign: 'center', fontSize: 22, color: '#bfe8d3', opacity: r(f, 86, 96)}}>Flutter apps too. CapMac builds Dart’s iPhone compiler from Dart’s own source</div>
</AbsoluteFill>;};

/* ---------- 8. Mac and Windows apps ---------- */

const DesktopScene = () => {
  const f = useCurrentFrame();
  const enter = (delay: number) => ease(f, delay, delay + 28);
  const saved = f >= 96;
  const label = (text: string, sub: string, show: number) => <div style={{opacity: show, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, fontSize: 22, color: '#f1eef4'}}><Glyph name={text.startsWith('Mac') ? 'mac' : 'desktop'} size={22} color={C.mint}/>{text}<span style={{color: '#b9b4c4', fontSize: 18}}>{sub}</span></div>;
  return <AbsoluteFill>
    <div style={{position: 'absolute', left: 70, top: 200, opacity: enter(0), transform: `translateY(${(1 - enter(0)) * 50}px) perspective(1800px) rotateY(${(1 - enter(0)) * 10}deg)`}}>
      {label('Mac app', '· its window, streamed from your Mac', r(f, 18, 30))}
      <MacWindow title="Bloom" width={900} height={590}><BloomDesktop width={900} height={560} reloaded={saved} flash={saved ? f - 96 : -1}/></MacWindow>
    </div>
    <div style={{position: 'absolute', left: 948, top: 300, opacity: enter(14), transform: `translateY(${(1 - enter(14)) * 50}px)`}}>
      {label('Windows app', '· runs on this PC, no Mac', r(f, 32, 44))}
      <WinWindow title="Bloom" width={900} height={590} icon={<AppIcon app="bloom" size={16}/>}><BloomDesktop width={900} height={558} reloaded={saved} flash={saved ? f - 100 : -1}/></WinWindow>
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 40, display: 'flex', justifyContent: 'center', gap: 14, opacity: r(f, 60, 72)}}>
      <Chip dot="#5fd3f6">Flutter</Chip><Chip dot="#7fe7ff">React Native</Chip><Chip dot="#a9b4ff">Electron on the Mac</Chip>
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 136, display: 'flex', justifyContent: 'center', opacity: r(f, 84, 90) * (1 - r(f, 118, 126))}}><KeyCap down={f >= 92 && f < 99}>Ctrl + S</KeyCap></div><Sfx at={92} sound="key"/>
    <Caption frame={f} text="Mac and Windows apps too" detail="One save hot-reloads both, from the same Flutter code"/>
  </AbsoluteFill>;
};

/* ---------- 9. Logs and errors ---------- */

const INSPECT_KEYS: CameraKey[] = [
  at(0), {at: 8, x: 960, y: 595, scale: 1},
  {at: 26, x: 1157, y: 760, scale: 1.85}, {at: 54, x: 1157, y: 760, scale: 1.85},
  {at: 70, x: 1070, y: 786, scale: 2.05}, {at: 84, x: 1070, y: 786, scale: 2.05},
  {at: 104, x: 1140, y: 735, scale: 1.7}, {at: 128, x: 1140, y: 735, scale: 1.7},
  {at: 146, x: 1200, y: 694, scale: 1.7}, {at: 168, x: 1200, y: 694, scale: 1.7}, at(180),
];
const InspectScene = () => {
  const f = useCurrentFrame();
  const problems = f >= 88;
  const view = orbitView(f + 240, 400, problems
    ? {timeline: {run: 'Run #4', badge: 'Live', status: 'Build failed', tone: 'failed', steps: RUN_STEPS.map((label, i) => ({label, state: i < 4 ? 'done' : i === 4 ? 'failed' : 'pending', detail: i < 4 ? RUN_DETAILS[i] : i === 4 ? 'failed' : undefined}))}, bar: {mode: 'failed', url: 'localhost:5173', peer: 'Mac mini', status: 'Build failed'}, console: {tab: 'problems', rows: [], errors: 1, problems: <ProblemPanel frame={(f - 88) * 1.3 + 40}/>}}
    : {console: {tab: 'console', rows: ORBIT_ROWS.slice(4, f >= 60 ? 8 : 7), filter: f >= 32 ? 'JS' : undefined, json: f >= 58}});
  return <AbsoluteFill>
    <Camera frame={f} keys={INSPECT_KEYS}>
      <div style={{position: 'absolute', left: W.left, top: W.top}}><StudioWindow view={view}/></div>
      <Cursor frame={f} size={21} keys={[{at: 0, x: 1300, y: 615}, {at: 24, x: 746, y: 655}, {at: 32, x: 746, y: 655}, {at: 48, x: 846, y: 688}, {at: 80, x: 846, y: 688}, {at: 88, x: 843, y: 617}, {at: 104, x: 1020, y: 732}, {at: 126, x: 1020, y: 732}, {at: 160, x: 1085, y: 719}]} clicks={[30, 58, 88, 127]}/>{[30, 58, 88, 127].map(click => <Sfx key={click} at={click}/>)}
      {f >= 128 && <div style={{position: 'absolute', left: 920, top: 510, width: 596, height: 357, opacity: r(f, 128, 138), transform: 'translateY(' + (1 - ease(f, 128, 142)) * 25 + 'px)', background: '#20242d', border: '1px solid #ffffff25', borderRadius: 8, boxShadow: '0 18px 50px #0007', overflow: 'hidden'}}>
        <div style={{height: 42, padding: '11px 19px', fontSize: 17, color: '#a8b1c3', background: '#292e3a'}}>AppDelegate.swift <span style={{float: 'right'}}>Line 24</span></div>
        <div style={{fontFamily: mono, fontSize: 18, lineHeight: 2, padding: '28px 22px', color: '#c6ccd7'}}>
          <div><span style={{color: '#6b7487', marginRight: 18}}>22</span><span style={{color: '#b496d3'}}>func</span> applicationDidBecomeActive() {'{'}</div>
          <div><span style={{color: '#6b7487', marginRight: 18}}>23</span>  <span style={{color: '#737f90'}}>// Resume app state</span></div>
          <div style={{background: '#92515022', borderLeft: '2px solid #da9e90', margin: '0 -22px', padding: '0 20px'}}><span style={{color: '#da9e90', marginRight: 18}}>24</span>  analytics.track(<span style={{color: '#acc59c'}}>"app_open"</span>)</div>
          <div><span style={{color: '#6b7487', marginRight: 18}}>25</span>{'}'}</div>
          <div style={{marginTop: 18, fontSize: 16, color: '#d99d91'}}>Cannot find 'analytics' in scope</div>
        </div>
      </div>}
    </Camera>
    <Caption frame={problems ? f - 88 : f} text={problems ? 'Errors you can click' : 'Read your app’s logs'} detail={problems ? 'Xcode, Swift and Dart errors open at the line on your PC' : 'JavaScript, Dart and native output, filtered and searchable'}/>
  </AbsoluteFill>;
};

/* ---------- 10. Studio, VS Code or the terminal ---------- */

const MINI_STEPS = ['Web build', 'Copy to Mac', 'Packages', 'cap sync', 'Xcode build', 'Simulator', 'Install', 'Open app'];
const MINI_DETAILS = ['dev server', '0.3 s · 1 file uploaded', '1.4 s', '0.4 s', '18 s', 'already on', '2.1 s', '2.7 s'];
const MINI_CONSOLE: ConsoleLine[] = [
  {kind: 'start', text: 'Live Orbit on iPhone 17 Pro'},
  {kind: 'step', text: 'Syncing Orbit to Mac mini', detail: '1 file uploaded · 0.3 s'},
  {kind: 'step', text: 'Running Xcode build', detail: '18 s'},
  {kind: 'step', text: 'Launching Orbit', detail: '2.7 s'},
  {kind: 'running', text: 'Orbit is running on iPhone 17 Pro'},
  {kind: 'app', tag: 'js', text: 'Orbit mounted { platform: "ios", ready: true }'},
  {kind: 'app', tag: 'web', text: '[vite] hot updated: /src/theme.ts'},
];
const THEME_TS = ["import { createApp } from 'vue'", "import App from './App.vue'", '', 'export const theme = {', "  accent: '#A1DDBD',", "  background: '#F5F3ED',", '}', '', 'createApp(App)', "  .provide('theme', theme)", "  .mount('#app')"];

/** CapMac for VS Code with Orbit running live: the Run view, the code, the screen beside it and the Debug Console */
export const VSCodeLive = ({frame}: {frame: number}) => <VSCodeWindow view={{
  frame, title: 'orbit', activity: 'capmac', sideTitle: 'CapMac', debugging: true, errors: 0,
  status: [{icon: 'package', text: 'Orbit · iPhone and iPad'}, {icon: 'device-mobile', text: 'iPhone 17 Pro'}, {icon: 'zap', text: 'Live on iPhone 17 Pro'}],
  debugToolbar: {opacity: 1, left: 520},
  side: <>
    <Section title="Run" desc="Orbit">
      <Row icon={<AppIcon app="orbit" size={16}/>} label="Orbit" desc="Capacitor · iOS app"/>
      <Row icon={<Codicon name="device-mobile"/>} label="iPhone 17 Pro" desc="Mac mini · auto · iOS 26.5"/>
      <Row twistie="open" icon={<Codicon name="zap" color="#73c991"/>} label="Live on iPhone 17 Pro" desc="Updated at 09:41:08"/>
      {MINI_STEPS.map((label, i) => <Row key={label} depth={1} icon={<StepIcon state={[0, 5].includes(i) ? 'skipped' : 'done'}/>} label={label} desc={MINI_DETAILS[i]}/>)}
    </Section>
    <Section title="Apps"><Row icon={<AppIcon app="orbit" size={16}/>} label="Orbit" desc="Capacitor · iPhone and iPad"/><Row icon={<AppIcon app="orbit" size={16}/>} label="Orbit" desc="Electron · Mac desktop"/></Section>
    <Section title="Devices"><Row twistie="open" icon={<Codicon name="vm" color="#73c991"/>} label="Mac mini" desc="Connected · 24 ms · default"/><Row depth={1} twistie="open" icon={<Codicon name="device-mobile"/>} label="Simulators" desc="1 booted"/><Row depth={2} icon={<Codicon name="device-mobile"/>} label="iPhone 17 Pro" desc="iOS 26.5 · Running"/><Row depth={2} icon={<Codicon name="device-mobile"/>} label="iPhone Air" desc="iOS 26.5 · Off"/></Section>
  </>,
  editor: <>
    <div style={{width: 620, borderRight: `1px solid ${VS.border}`, display: 'flex', flexDirection: 'column'}}>
      <Tabs tabs={[{label: 'theme.ts', icon: <FileIcon lang="ts"/>}, {label: 'capacitor.config.ts', icon: <FileIcon lang="ts"/>}]} active={0}/>
      <div style={{height: 22, display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', fontSize: 12.5, color: VS.dim}}>src<Codicon name="chevron-right" size={14}/>theme.ts</div>
      <CodeEditor lines={THEME_TS} lang="ts" frame={frame} active={5}/>
    </div>
    <div style={{flex: 1, display: 'flex', flexDirection: 'column'}}>
      <Tabs tabs={[{label: 'iPhone 17 Pro', icon: <Codicon name="device-mobile" size={14}/>}]} active={0}/>
      <ScreenTab name="iPhone 17 Pro" fps={60} width={584} height={538} phoneScale={.78} frame={frame}><Phone frame={70} variant="mint" outline/></ScreenTab>
    </div>
  </>,
  panel: <Panel tab="Debug Console" height={270}><DebugConsole lines={MINI_CONSOLE} height={232}/></Panel>,
}}/>;

const TerminalDev = () => <Chrome title="Windows PowerShell" height={690}>
  <div style={{padding: '40px 56px', fontSize: 24}}>
    <Prompt frame={99} start={0} text="capmac dev"/>
    {[['Dev server', 'http://localhost:5173'], ['Syncing Orbit to Mac mini', '0.3 s'], ['Running Xcode build', '18 s'], ['Launching Orbit', '2.7 s']].map(([step, detail]) => <div key={step} style={{marginTop: 20}}><Check>{step}<Dim>{detail}</Dim></Check></div>)}
    <div style={{marginTop: 26, fontSize: 26}}><span style={{color: C.mint, marginRight: 12}}>●</span>Orbit is running on iPhone 17 Pro</div>
    <div style={{marginTop: 22, fontFamily: mono, fontSize: 21, color: '#9fb7a8'}}>Watching for changes · r reload · s screenshot · q quit</div>
  </div>
</Chrome>;

/** Three front ends side by side, angled like a curved display, each running the same app */
const FrontEndsScene = () => {
  const f = useCurrentFrame();
  const item = (delay: number) => ease(f, delay, delay + 30);
  const drift = f / 180;
  const panel = (delay: number, left: number, top: number, width: number, height: number, turn: number, origin: string, label: string, content: React.ReactNode) => <div style={{position: 'absolute', left, top, width, height, opacity: item(delay), transformOrigin: origin, transform: `translateY(${(1 - item(delay)) * 50}px) rotateY(${turn * (1 - drift * .25)}deg)`}}>
    {content}
    <div style={{position: 'absolute', left: 0, right: 0, top: height + 26, textAlign: 'center', fontSize: 25, color: '#f2eff6', opacity: r(f, delay + 26, delay + 38)}}>{label}</div>
  </div>;
  return <AbsoluteFill>
    <Camera frame={f} keys={[{at: 0, x: 960, y: 560, scale: .97}, {at: 180, x: 960, y: 556, scale: 1.07, drift: true}]} blur={false}>
      <AbsoluteFill style={{perspective: 2200, perspectiveOrigin: '50% 45%'}}>
        {panel(8, 14, 380, 650, 312, 17, '100% 50%', 'CapMac Studio', <div style={{transform: `scale(${650 / 1440})`, transformOrigin: '0 0'}}><StudioWindow view={orbitView(f + 300, 300, {console: {tab: 'console', rows: ORBIT_ROWS.slice(0, 8)}})}/></div>)}
        {panel(0, 610, 340, 700, 402, 0, '50% 50%', 'CapMac for VS Code', <div style={{transform: `scale(${700 / 1600})`, transformOrigin: '0 0'}}><VSCodeLive frame={f}/></div>)}
        {panel(16, 1256, 380, 650, 312, -17, '0 50%', 'The capmac command', <div style={{transform: `scale(${650 / 1440})`, transformOrigin: '0 0'}}><TerminalDev/></div>)}
      </AbsoluteFill>
    </Camera>
    <Caption frame={f} text="Studio, VS Code or the terminal" detail="One engine and one set of settings, so you can switch any time"/>
  </AbsoluteFill>;
};

/* ---------- 11. AI agents ---------- */

const AGENTS = ['Claude Code', 'Codex', 'GitHub Copilot', 'Cursor', 'Gemini CLI', 'and ten more'];
const AgentScene = () => {
  const f = useCurrentFrame();
  const step = (t: number, icon: React.ReactNode, command: string, result: React.ReactNode, top: number) => <div style={{position: 'absolute', left: 48, right: 48, top, opacity: r(f, t, t + 8), transform: `translateY(${(1 - r(f, t, t + 8)) * 10}px)`}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 14, fontFamily: mono, fontSize: 23, color: '#e9e6f1'}}>{icon}{command}</div>
    <div style={{marginLeft: 40, marginTop: 10, fontSize: 20, color: '#a9b5ad'}}>{result}</div>
  </div>;
  return <AbsoluteFill>
    <div style={{position: 'absolute', left: 290, top: 236, width: 1010, height: 650, borderRadius: 14, background: '#15171ff2', border: '1px solid #ffffff22', boxShadow: '0 40px 100px #0008', overflow: 'hidden', opacity: r(f, 0, 12), transform: `translateY(${(1 - ease(f, 0, 20)) * 40}px)`}}>
      <div style={{height: 50, display: 'flex', alignItems: 'center', gap: 12, padding: '0 22px', background: '#1d2029', borderBottom: '1px solid #ffffff10', fontSize: 18, color: '#b9bccb'}}><span style={{fontFamily: mono, color: C.violet}}>&gt;_</span>AI coding agent<span style={{marginLeft: 'auto', fontSize: 15, color: '#7f8597'}}>C:\code\orbit</span></div>
      <div style={{position: 'absolute', left: 48, top: 84, right: 48, padding: '16px 20px', borderRadius: 10, background: '#272a3a', fontSize: 23, color: '#f1eef8', opacity: r(f, 6, 14)}}>Run the app and check the Activity screen</div>
      {step(26, <Dot2 color={C.violet}/>, 'capmac run --for 15', 'Orbit runs on iPhone 17 Pro · no errors in its console', 180)}
      {step(58, <Dot2 color={C.violet}/>, 'capmac screenshot', <div style={{display: 'flex', alignItems: 'center', gap: 18}}><div style={{width: 92, height: 184, borderRadius: 14, overflow: 'hidden', boxShadow: '0 10px 24px #0007'}}><div style={{transform: 'scale(.3067)', transformOrigin: '0 0'}}><Phone frame={70} variant="mint" view="activity" tapFrame={40}/></div></div><span style={{fontFamily: mono, fontSize: 17, color: '#8d96a8'}}>C:\Users\sam\AppData\Local\Temp\capmac-shot.png</span></div>, 300)}
      <div style={{position: 'absolute', left: 48, right: 48, top: 560, fontSize: 24, color: '#f3f1f8', lineHeight: 1.5, opacity: r(f, 104, 114)}}><span style={{color: C.mint, marginRight: 12}}>✓</span>The Activity screen looks right, and the console is clean</div>
    </div>
    <div style={{position: 'absolute', left: 1380, top: 250, display: 'flex', flexDirection: 'column', gap: 16}}>
      <div style={{fontSize: 20, color: '#c9c5d4', marginBottom: 6, opacity: r(f, 20, 30)}}>Works with</div>
      {AGENTS.map((agent, i) => {const p = ease(f, 30 + i * 8, 44 + i * 8); return <Chip key={agent} dot={i < 5 ? C.violet : undefined} style={{opacity: p, transform: `translateX(${(1 - p) * 30}px)`, alignSelf: 'flex-start', color: i < 5 ? '#eeebf2' : '#b9b4c4'}}>{agent}</Chip>;})}
    </div>
    <Caption frame={f} text="Built for AI agents" detail="They build, run, read the logs and take screenshots through CapMac"/>
    <Note>capmac skill add teaches CapMac to your agents · CapMac for VS Code adds it by itself</Note>
  </AbsoluteFill>;
};
const Dot2 = ({color}: {color: string}) => <span style={{width: 12, height: 12, borderRadius: 6, background: color, boxShadow: `0 0 10px ${color}`}}/>;

/* ---------- 12. Ship ---------- */

const ShipTerminal = ({t}: {t: number}) => <Chrome title="Windows PowerShell">
  <div style={{position: 'relative', height: 641}}>
    <div style={{position: 'absolute', left: 56, top: 40}}><Prompt frame={t} start={4} text="capmac build --upload"/></div>
    {[['Web build', '0.9 s'], ['Archive on Mac mini', '1 min 12 s'], ['Upload to App Store Connect', '38 s']].map(([step, time], i) => <Line key={step} top={110 + i * 44} show={r(t, 34 + i * 14, 40 + i * 14)}><Check>{step}<Dim>{time}</Dim></Check></Line>)}
    <div style={{position: 'absolute', left: 56, top: 290, width: 1040, padding: '26px 32px', boxSizing: 'border-box', borderRadius: 10, border: '1px solid #a1cbb22b', background: '#25453444', opacity: r(t, 82, 92)}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 16, fontSize: 29, color: '#d5efe0'}}><AppIcon app="orbit" size={40}/>Orbit 1.4 is on its way to TestFlight</div>
      <div style={{fontFamily: mono, fontSize: 20, color: '#93b4a0', marginTop: 14}}>App Store Connect · build 27 · uploaded from Mac mini</div>
    </div>
  </div>
</Chrome>;
const SHIP_KEYS: CameraKey[] = [at(0), {at: 10, x: 960, y: 595, scale: 1}, {at: 30, x: 840, y: 470, scale: 1.45}, {at: 78, x: 850, y: 480, scale: 1.47, drift: true}, {at: 100, x: 860, y: 570, scale: 1.3}, {at: 150, x: 870, y: 575, scale: 1.34, drift: true}];
const ShipScene = () => {const f = useCurrentFrame(); return <AbsoluteFill>
  <Camera frame={f} keys={SHIP_KEYS}><div style={{position: 'absolute', left: W.left, top: W.top}}><ShipTerminal t={f}/></div></Camera>
  <Caption frame={f} text="Ready to ship" detail="Export a signed IPA, or send a build to TestFlight from your Mac"/>
  <Note>Apple signing credentials required</Note>
</AbsoluteFill>;};

/* ---------- 13. Get CapMac ---------- */

const Finale = () => {
  const f = useCurrentFrame();
  const icon = ease(f, 14, 32);
  const cta = (delay: number) => ease(f, delay, delay + 16);
  return <AbsoluteFill>
    <div style={{position: 'absolute', left: W.left, top: W.top, opacity: 1 - r(f, 0, 24), filter: 'blur(' + r(f, 0, 24, 0, 20) + 'px)', transform: 'scale(' + r(f, 0, 24, 1, .8) + ')', transformOrigin: 'center center'}}><ShipTerminal t={150}/></div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 236, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{position: 'relative', width: 128, height: 128, opacity: icon, transform: `scale(${.7 + icon * .3})`}}>
        <Img src={staticFile('capmac-icon.svg')} style={{width: 128, height: 128, filter: 'drop-shadow(0 18px 40px #5b4bf088)'}}/>
        <div style={{position: 'absolute', inset: 8, borderRadius: 30, overflow: 'hidden'}}><Sheen frame={f} at={30} duration={30} strength={.5}/></div>
      </div>
      <Words frame={f} from={30} stagger={3} text="CapMac" style={{fontSize: 72, fontWeight: 600, letterSpacing: -2.4, marginTop: 22}}/>
      <Words frame={f} from={38} stagger={3} text="Build iPhone apps on Windows" style={{fontSize: 44, fontWeight: 500, letterSpacing: -1.2, marginTop: 6, color: '#f1eef6'}}/>
      <Words frame={f} from={46} stagger={2} text="With your Mac, or with no Mac at all" style={{fontSize: 27, color: '#d9d4e2', marginTop: 14}} wordStyle={(_, i) => i >= 5 ? {color: C.mint} : undefined}/>
      <div style={{display: 'flex', gap: 16, marginTop: 52}}>
        {[[<Glyph key="d" name="download" size={20} color={C.violet}/>, 'CapMac Studio'], [<Codicon key="v" name="vscode" size={19} color="#58a8f5"/>, 'CapMac for VS Code'], [<span key="c" style={{color: C.violet, fontFamily: mono}}>&gt;</span>, <span key="n" style={{fontFamily: mono, fontSize: 20}}>npm install -g capmac</span>]].map(([glyph, label], i) => <span key={i} style={{display: 'inline-flex', alignItems: 'center', gap: 12, height: 54, padding: '0 24px', borderRadius: 27, background: '#ffffff12', border: '1px solid #ffffff2c', fontSize: 21, opacity: cta(58 + i * 6), transform: `translateY(${(1 - cta(58 + i * 6)) * 14}px)`}}>{glyph}{label}</span>)}
      </div>
      <div style={{marginTop: 40, fontSize: 19, color: '#bdb8c9', opacity: r(f, 84, 96)}}>Free and open source · github.com/dotnetdreamer/capmac</div>
    </div>
  </AbsoluteFill>;
};

const PLATES = [['cool', 0, 0], ['violet', 430, 520], ['mint', 940, 1000], ['warm', 1480, 1540], ['violet', 1840, 1900], ['cool', 2350, 2420]] as const;

export const CapMacIntro = () => {
  const f = useCurrentFrame();
  const scenes = [Hook, PairScene, BuildScene, ReloadScene, NoMacScene, PcScene, TwinsScene, DesktopScene, InspectScene, FrontEndsScene, AgentScene, ShipScene, Finale];
  return <AbsoluteFill style={{fontFamily: body, color: C.text, overflow: 'hidden'}}>
    <FontGate/><Atmosphere frame={f} plates={PLATES}/><Vignette/><Html5Audio src={staticFile('intro-background.wav')} volume={.7}/>
    {CHAPTERS.map((chapter, i) => {const Scene = scenes[i]; return <Sequence key={chapter.label} from={chapter.from} durationInFrames={chapter.duration} name={chapter.label}><Scene/></Sequence>;})}
    <Cuts frame={f} at={CHAPTERS.slice(1).map(chapter => chapter.from)}/>
    <AbsoluteFill style={{pointerEvents: 'none', background: '#0d0d18', opacity: r(f, DURATION - 18, DURATION - 2)}}/>
  </AbsoluteFill>;
};

/** The README's picture of the film, linked to the video: the poster with a play button */
export const CapMacReadme = () => <AbsoluteFill>
  <CapMacPoster/>
  <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
    <div style={{width: 168, height: 168, borderRadius: 84, display: 'grid', placeItems: 'center', background: 'rgba(14,15,24,.6)', border: '2px solid rgba(255,255,255,.72)', backdropFilter: 'blur(10px)', boxShadow: '0 20px 60px #000a'}}>
      <svg width="68" height="68" viewBox="0 0 24 24" style={{marginLeft: 8}}><path d="M7 4.5v15l12.5-7.5z" fill="#fff"/></svg>
    </div>
  </AbsoluteFill>
</AbsoluteFill>;

export const CapMacPoster = () => <AbsoluteFill style={{fontFamily: body, color: C.text, overflow: 'hidden'}}>
  <FontGate/><Atmosphere frame={540} plates={[['violet', 0, 0]]}/><Vignette/>
  <div style={{position: 'absolute', left: 78, top: 56}}><Brand/></div>
  <div style={{position: 'absolute', left: 0, right: 0, top: 70, textAlign: 'center', fontSize: 62, fontWeight: 600, letterSpacing: -2}}>Build iPhone apps on Windows</div>
  <div style={{position: 'absolute', left: 0, right: 0, top: 160, textAlign: 'center', fontSize: 28, color: '#ebe7ee'}}>With your Mac, or with <span style={{color: C.mint}}>no Mac at all</span> · Capacitor · Ionic · Flutter · React Native · Electron</div>
  <div style={{position: 'absolute', left: W.left, top: W.top}}><StudioWindow view={orbitView(400, 150, {console: {tab: 'console', rows: ORBIT_ROWS}, pane: {title: 'Simulator', sub: 'iPhone 17 Pro · iOS 26.5', content: <SimulatorStage><Phone frame={30} scale={.745} variant="mint"/></SimulatorStage>}})}/></div>
</AbsoluteFill>;
