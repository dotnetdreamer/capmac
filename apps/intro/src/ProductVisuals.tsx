import React, {type CSSProperties, type ReactNode} from 'react';
import {Img, interpolate, staticFile} from 'remotion';
import {AppIcon} from './Apps';

const uiFont = '"Segoe UI Variable", "Segoe UI", sans-serif';
export const monoFont = '"Cascadia Code", "JetBrains Mono", Consolas, monospace';
export const lavender = '#c2adff';
export const mint = '#91e2c1';
const hairline = '1px solid rgba(255,255,255,0.075)';
const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

export type IconName = 'home' | 'mac' | 'phone' | 'settings' | 'play' | 'flash' | 'box' | 'code' | 'search' | 'chevron' | 'check' | 'stop' | 'refresh' | 'more' | 'lock' | 'arrow' | 'chart' | 'card' | 'desktop' | 'wrench' | 'key' | 'download' | 'plug' | 'wifi' | 'history' | 'sync' | 'health' | 'window' | 'close' | 'circle' | 'clock';

export function Glyph({name, size = 20, color = 'currentColor', style}: {name: IconName; size?: number; color?: string; style?: CSSProperties}) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11h5v-6h3v6h5V9"/></>,
    mac: <><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6m-3-4v4"/></>,
    phone: <><rect x="6.5" y="2" width="11" height="20" rx="2.5"/><path d="M10 5h4m-3 14h2"/></>,
    settings: <><path d="m9.5 3-1 2.5-2.6.5-1.4 2.4.9 2.5-1.8 2 .7 2.7 2.6.7 1 2.5h3l1-2.5 2.6-.7.7-2.7-1.8-2 .9-2.5L16.9 6l-2.6-.5-1-2.5z" transform="translate(1 0)"/><circle cx="12" cy="11" r="3"/></>,
    play: <path d="m8 4 12 8-12 8z" fill="currentColor" stroke="none"/>,
    flash: <path d="m13 2-8 12h6l-1 8 9-13h-6z" fill="currentColor" stroke="none"/>,
    box: <><path d="m12 3 9 5-9 5-9-5z"/><path d="M3 8v10l9 5 9-5V8M12 13v10m-4.5-17.5 9 5"/></>,
    code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    check: <path d="m5.5 12 4.5 4.5 8.5-9"/>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>,
    refresh: <><path d="M20 8V3m0 5h-5M4 16v5m0-5h5"/><path d="M19 7a8 8 0 0 0-13.6-1M5 17a8 8 0 0 0 13.6 1"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
    arrow: <><path d="M5 19 19 5m-9 0h9v9"/></>,
    chart: <><path d="M4 20V4m0 16h16M8 15l4-5 4 2 5-7"/></>,
    card: <><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20m-16 5h4"/></>,
    desktop: <><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/><path d="M3 13h18"/></>,
    wrench: <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-1-1-3z"/>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 2 2m-4 0 1.5 1.5"/></>,
    download: <><path d="M12 4v11m-5-5 5 5 5-5"/><path d="M5 20h14"/></>,
    plug: <><path d="M9 2v5m6-5v5M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/></>,
    wifi: <><path d="M3 9a14 14 0 0 1 18 0M6 12.5a9 9 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r=".9" fill="currentColor"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
    sync: <><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4M6 21v-4h4"/></>,
    health: <path d="M3 12h4l2-5 4 10 2-5h6"/>,
    window: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    circle: <circle cx="12" cy="12" r="8"/>,
    clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" style={{display: 'block', flexShrink: 0, ...style}}>{paths[name]}</svg>;
}

export function Dot({color = mint, size = 6, glow = false}: {color?: string; size?: number; glow?: boolean}) {
  return <span style={{display: 'inline-block', width: size, height: size, flexShrink: 0, borderRadius: '50%', background: color, boxShadow: glow ? `0 0 9px ${color}55` : undefined}}/>;
}

/** A working step's spinner: an arc that turns with the frame */
export function Spinner({frame, size = 14, color = lavender}: {frame: number; size?: number; color?: string}) {
  return <svg width={size} height={size} viewBox="0 0 16 16" style={{display: 'block', flexShrink: 0, transform: `rotate(${frame * 14}deg)`}}><circle cx="8" cy="8" r="6" fill="none" stroke="#ffffff1c" strokeWidth="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"/></svg>;
}

function StudioButton({children, icon, accent = false, active = false, pressed = false, style}: {children?: ReactNode; icon: IconName; accent?: boolean; active?: boolean; pressed?: boolean; style?: CSSProperties}) {
  return <div style={{height: 33, padding: children ? '0 13px' : '0 8px', display: 'flex', alignItems: 'center', gap: 7, borderRadius: 5, border: accent ? `1px solid ${active ? '#d6c7ff' : '#ccb8ff'}` : hairline, background: accent ? pressed ? '#a18bcc' : active ? '#c3aff4' : '#b29edf' : pressed ? '#30334a' : '#242635', color: accent ? '#1e1631' : '#e7e7ee', fontSize: 13, fontWeight: accent ? 650 : 500, transform: pressed ? 'translateY(1px) scale(.97)' : undefined, boxShadow: pressed ? 'inset 0 2px 6px #442b7455' : active && accent ? '0 0 0 2px #c3aff419' : undefined, boxSizing: 'border-box', ...style}}><Glyph name={icon} size={16}/>{children}{active ? <Dot size={5} color={accent ? '#315944' : mint}/> : null}</div>;
}

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export type Step = {label: string; state: StepState; detail?: string};

/**
 * Steps that finish one after another: the first is working from `start` and each one finishes `every` frames
 * after the one before. `details` say how each finished; a skipped step names why.
 */
export function stepsAt(t: number, start: number, every: number, labels: readonly string[], details: readonly string[], skipped: readonly number[] = []): Step[] {
  return labels.map((label, i) => {
    const done = start + (i + 1) * every;
    const state: StepState = t >= done ? skipped.includes(i) ? 'skipped' : 'done' : t >= start + i * every ? 'running' : 'pending';
    return {label, state, detail: state === 'done' || state === 'skipped' ? details[i] : state === 'running' ? 'in progress' : undefined};
  });
}

export const RUN_STEPS = ['Web build', 'Copy to Mac', 'Packages', 'cap sync', 'Xcode build', 'Simulator', 'Install', 'Open app'] as const;
export const RUN_DETAILS = ['dev server', 'synced', 'up to date', 'synced', 'built', 'already on', 'installed', 'running'] as const;
/** Built on this PC: no copy to a Mac, no cap sync, no simulator */
export const PC_STEPS = ['Web build', 'Native project', 'Build and sign', 'Install', 'Open app'] as const;

export type LogRow = {source: string; color: string; text: string; at: string; hot?: boolean; object?: boolean};
export const SOURCE = {cm: '#93b8ff', web: '#91ded8', cap: lavender, ios: '#b4b5c0', js: '#9dc7ff', dart: '#7fd3f7', app: '#c9b6f2'};

export type Picker = {title: string; sub: string; icon: IconName | 'orbit' | 'bloom'; tone?: 'ok' | 'warn' | 'none'};

/** Everything a Studio window shows at one moment; scenes build one per frame */
export type StudioView = {
  frame: number;
  project?: {name: string; id: string; app: 'orbit' | 'bloom' | 'pulse'};
  appPicker?: Picker;
  mac: Picker;
  target: Picker;
  live: {active: boolean; pressed?: boolean};
  runPressed?: boolean;
  menuOpen?: boolean;
  bar: {mode: 'live' | 'ready' | 'failed'; url?: string; peer: string; status: string; linked?: boolean};
  pane: {title: string; sub: string; content: ReactNode; foot?: ReactNode};
  timeline: {run: string; badge: 'Live' | 'Run'; status: string; tone: 'ok' | 'busy' | 'failed' | 'idle'; steps: Step[]};
  console: {tab: 'console' | 'problems'; rows: LogRow[]; filter?: string; json?: boolean; problems?: ReactNode; errors?: number};
  overlay?: ReactNode;
};

function PickerButton({picker}: {picker: Picker}) {
  const icon = picker.icon === 'orbit' || picker.icon === 'bloom' ? <AppIcon app={picker.icon} size={22}/> : <Glyph name={picker.icon} color="#b9bacb" size={22}/>;
  return <div style={{display: 'flex', gap: 10, alignItems: 'center', minWidth: 161}}>
    <div style={{position: 'relative'}}>{icon}{picker.tone !== 'none' && <span style={{position: 'absolute', right: -2, bottom: -2}}><Dot size={5} color={picker.tone === 'warn' ? '#e8c27c' : mint}/></span>}</div>
    <div><div style={{fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap'}}>{picker.title}</div><div style={{fontSize: 10, color: picker.tone === 'warn' ? '#d9b779' : '#888ba2', marginTop: 3, whiteSpace: 'nowrap'}}>{picker.sub}</div></div>
    <Glyph name="chevron" style={{transform: 'rotate(90deg)', marginLeft: 'auto'}} color="#8a8ba0" size={13}/>
  </div>;
}

const phaseColor = (step: Step) => step.state === 'failed' ? '#e99eaf' : step.state === 'done' || step.state === 'skipped' ? '#dedee9' : step.state === 'running' ? '#d0c3f3' : '#72778d';

function Timeline({view}: {view: StudioView}) {
  const {steps} = view.timeline;
  const pulse = .55 + .45 * Math.sin(view.frame / 13);
  const finished = steps.filter(step => step.state === 'done' || step.state === 'skipped').length;
  const edge = 50 / steps.length;
  const toneColor = view.timeline.tone === 'failed' ? '#e692a6' : view.timeline.tone === 'ok' ? mint : view.timeline.tone === 'busy' ? lavender : '#9699ad';
  return <div style={{height: 198, borderBottom: '3px solid #10121d', boxSizing: 'border-box'}}>
    <div style={{height: 36, display: 'flex', alignItems: 'center', padding: '0 17px', borderBottom: hairline, fontSize: 12, fontWeight: 600}}>Timeline<span style={{marginLeft: 'auto', fontSize: 10, color: '#73778b', fontWeight: 400}}>Build steps</span></div>
    <div style={{padding: '16px 24px 0'}}>
      <div style={{display: 'flex', gap: 10, alignItems: 'center', fontSize: 12}}><span style={{fontWeight: 600}}>{view.timeline.run}</span><span style={{fontSize: 10, padding: '2px 7px', borderRadius: 4, color: view.live.active ? mint : '#9699ad', background: view.live.active ? '#23372f' : '#242636', border: view.live.active ? '1px solid #304e40' : hairline}}>{view.timeline.badge}</span><span style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: view.timeline.tone === 'failed' ? '#e692a6' : view.timeline.tone === 'ok' ? '#a8c9b5' : '#a0a2b5'}}><Dot size={5} color={toneColor}/>{view.timeline.status}</span></div>
      <div style={{position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${steps.length},minmax(0,1fr))`, marginTop: 23}}>
        <div style={{position: 'absolute', left: `${edge}%`, right: `${edge}%`, height: 1, top: 13, background: '#383849'}}/>
        <div style={{position: 'absolute', left: `${edge}%`, width: `${Math.min(100 - 2 * edge, Math.max(0, (finished - 1) * (100 / steps.length)))}%`, height: 1, top: 13, background: '#729780'}}/>
        {steps.map(step => {
          const done = step.state === 'done' || step.state === 'skipped';
          const active = step.state === 'running';
          const failed = step.state === 'failed';
          return <div key={step.label} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, position: 'relative'}}>
            <div style={{width: 26, height: 26, boxSizing: 'border-box', borderRadius: '50%', border: `1px solid ${failed ? '#bd6b7d' : done ? '#587965' : active ? '#9683c9' : '#3f4153'}`, color: failed ? '#efadbc' : done ? '#b8e0c8' : active ? lavender : '#6d6e85', background: failed ? '#432a35' : done ? '#263b31' : '#171926', display: 'grid', placeItems: 'center', boxShadow: active ? `0 0 ${9 + pulse * 8}px #bba4ff22` : undefined}}>{failed ? <span style={{fontSize: 18, lineHeight: 1}}>×</span> : done ? <Glyph name="check" size={13}/> : active ? <span style={{width: 7, height: 7, borderRadius: '50%', background: lavender, opacity: .55 + pulse * .45}}/> : <span style={{width: 5, height: 5, borderRadius: '50%', border: '1px solid #4f5266'}}/>}</div>
            <span style={{fontSize: 11.5, color: phaseColor(step), whiteSpace: 'nowrap'}}>{step.label}</span>
            <span style={{fontSize: 9.5, color: failed ? '#c88495' : '#72788d', whiteSpace: 'nowrap'}}>{step.detail ?? ''}</span>
          </div>;
        })}
      </div>
    </div>
  </div>;
}

export function ProblemPanel({frame}: {frame: number}) {
  const selected = frame >= 80;
  const path = 'C:\\code\\orbit\\ios\\App\\App\\AppDelegate.swift';
  return <div style={{height: 285, background: '#151724', fontSize: 12, overflow: 'hidden'}}>
    <div style={{height: 38, display: 'flex', alignItems: 'center', padding: '0 17px', gap: 9, borderBottom: hairline, background: '#1b1d2a'}}><span style={{padding: '3px 7px', borderRadius: 4, fontSize: 10, background: '#462b35', color: '#f1a7b3'}}>1 error</span><span style={{marginLeft: 'auto', color: '#9b9db1', fontSize: 11}}>Copy all</span></div>
    <div style={{height: 38, display: 'flex', alignItems: 'center', gap: 8, padding: '0 17px', borderBottom: hairline, background: '#1d2030'}}><Glyph name="chevron" size={12} style={{transform: 'rotate(90deg)'}} color="#949ab1"/><Glyph name="code" size={15} color="#bcaddb"/><span style={{fontWeight: 600}}>AppDelegate.swift</span><span style={{fontFamily: monoFont, color: '#81869d', fontSize: 11}}>ios\App\App</span><span style={{marginLeft: 'auto', color: '#ee9aa9', borderRadius: 4, padding: '2px 6px', background: '#422c36', fontSize: 10}}>1</span></div>
    <div style={{padding: '13px 22px 0', background: selected ? '#272338' : '#1a1b29', borderLeft: '2px solid #de7e91'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 9, height: 22}}><span style={{width: 15, height: 15, borderRadius: '50%', color: '#19202b', background: '#df8194', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 11}}>×</span><span style={{fontWeight: 600, color: '#e4dce8'}}>Cannot find 'analytics' in scope</span><span style={{marginLeft: 'auto', fontFamily: monoFont, fontSize: 11, color: '#9794ae'}}>24:9</span></div>
      <div style={{display: 'flex', alignItems: 'center', gap: 5, margin: '10px 0 12px 24px', fontFamily: monoFont, fontSize: 11.5, color: selected ? '#d2bcff' : '#a99cca', textDecoration: 'underline', textDecorationColor: '#6d5b8c', textUnderlineOffset: 3}}>{path}:24:9<Glyph name="arrow" size={12}/></div>
      <pre style={{fontFamily: monoFont, margin: '0 0 0 24px', padding: '11px 12px', background: '#121520', border: hairline, borderRadius: 4, color: '#c3c5d7', fontSize: 12, lineHeight: 1.7}}><span style={{color: '#626981'}}>24   </span>analytics.track("app_open"){'\n'}<span style={{color: '#626981'}}>     </span><span style={{color: '#ec99a6'}}>^^^^^^^^^</span></pre>
      <div style={{height: 40, display: 'flex', alignItems: 'center', marginLeft: 24, gap: 12, color: '#737c95', fontSize: 10}}><span>Swift</span><span style={{width: 1, height: 10, background: '#3a3d51'}}/><span>xcodebuild</span><span style={{marginLeft: 'auto', marginRight: 4, border: hairline, background: selected ? '#3c3052' : '#242637', color: '#c9bddc', borderRadius: 4, padding: '4px 8px', fontSize: 10}}>Open in editor</span><span style={{color: '#9597ad'}}>Copy</span></div>
    </div>
    <div style={{height: 27, padding: '0 18px', display: 'flex', alignItems: 'center', fontFamily: monoFont, fontSize: 10, color: selected ? '#bdacd8' : '#626c87'}}>{selected ? `${path}:24:9` : '1 diagnostic in project code'}</div>
  </div>;
}

function JsonLog({expanded}: {expanded: boolean}) {
  return <div style={{fontFamily: monoFont, paddingTop: 5, paddingBottom: 4, fontSize: 12, lineHeight: 1.45, color: '#bfc4d7'}}>
    <div style={{display: 'flex', gap: 7, alignItems: 'center'}}><Glyph name="chevron" size={11} color="#9e97b4" style={{transform: expanded ? 'rotate(90deg)' : undefined}}/><span style={{color: '#c4c9db'}}>Orbit mounted</span><span style={{color: '#9d9eb1'}}>{expanded ? '{' : '{ platform: "ios", ready: true, session: {…} }'}</span></div>
    {expanded && <div style={{marginLeft: 18, paddingLeft: 12, borderLeft: '1px solid #3a354e', paddingBottom: 4}}>
      <div><span style={{color: '#b8a7d6'}}>platform</span>: <span style={{color: '#accaae'}}>"ios"</span>,</div>
      <div><span style={{color: '#b8a7d6'}}>ready</span>: <span style={{color: '#d5b288'}}>true</span>,</div>
      <div><span style={{color: '#b8a7d6'}}>session</span>: {'{'}</div>
      <div style={{paddingLeft: 18}}><span style={{color: '#b8a7d6'}}>device</span>: <span style={{color: '#accaae'}}>"iPhone 17 Pro"</span>,</div>
      <div style={{paddingLeft: 18}}><span style={{color: '#b8a7d6'}}>live</span>: <span style={{color: '#d5b288'}}>true</span></div>
      <div>{'}'}</div>
      <div style={{display: 'flex', justifyContent: 'space-between', maxWidth: 350}}><span>{'}'}</span><span style={{fontFamily: uiFont, fontSize: 10, color: '#a9a1bb', background: '#252537', padding: '1px 7px', border: hairline, borderRadius: 4}}>Copy JSON</span></div>
    </div>}
  </div>;
}

function ConsolePane({view}: {view: StudioView}) {
  const {console: pane} = view;
  const problems = pane.tab === 'problems';
  const errors = pane.errors ?? 0;
  return <div style={{height: 344}}>
    <div style={{height: 36, borderBottom: hairline, display: 'flex', alignItems: 'center', gap: 23, padding: '0 17px', boxSizing: 'border-box'}}>
      <div style={{height: '100%', display: 'flex', alignItems: 'center', fontSize: 12, fontWeight: problems ? 400 : 600, color: problems ? '#9698ad' : '#f3f2f8', position: 'relative'}}>Console{!problems && <span style={{position: 'absolute', left: 2, right: 2, bottom: 0, height: 2, background: lavender, borderRadius: 2}}/>}</div>
      <span style={{height: '100%', display: 'flex', alignItems: 'center', position: 'relative', fontSize: 12, color: problems ? '#f3f2f8' : '#9698ad', fontWeight: problems ? 600 : 400}}>Problems<span style={{fontSize: 9, color: errors ? '#e696a7' : '#68758a', marginLeft: 7}}>{errors}</span>{problems && <span style={{position: 'absolute', left: 2, right: 2, bottom: 0, height: 2, background: lavender, borderRadius: 2}}/>}</span>
      <span style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: errors ? '#d88e9e' : '#809184', fontSize: 10}}>{!errors && <Glyph name="check" size={12}/>} {errors ? `${errors} error` : 'No errors'}</span>
    </div>
    {problems ? pane.problems : <>
      <div style={{height: 40, display: 'flex', alignItems: 'center', gap: 7, padding: '0 13px', borderBottom: hairline, background: '#1b1d2a', fontSize: 10.5, boxSizing: 'border-box'}}>
        {[['JS', SOURCE.js], ['Capacitor', SOURCE.cap], ['Native', SOURCE.ios], ['Bridge', '#788ca6'], ['Dev server', SOURCE.web], ['CapMac', SOURCE.cm]].map(([name, color]) => {
          const on = pane.filter === name;
          return <span key={name} style={{height: 22, display: 'flex', alignItems: 'center', gap: 5, padding: '0 7px', border: on ? '1px solid #6e94ca' : hairline, background: on ? '#28416a' : '#242636', borderRadius: 12, color: on ? '#d2e3ff' : '#c2c2d0'}}><Dot color={color} size={4}/>{name}</span>;
        })}
        <span style={{marginLeft: 'auto', color: '#8d90a6'}}>All levels ⌄</span>
        <div style={{height: 24, width: 95, padding: '0 7px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 5, border: hairline, borderRadius: 4, color: '#74798d', background: '#131522'}}><Glyph name="search" size={11}/>Find</div>
      </div>
      <div style={{paddingTop: 8, height: 245, overflow: 'hidden', background: '#151724', boxSizing: 'border-box'}}>
        {pane.rows.map(row => <div key={row.text} style={{display: 'flex', alignItems: row.object ? 'flex-start' : 'center', gap: 12, minHeight: 29, fontFamily: monoFont, padding: '0 16px', borderLeft: row.hot ? '2px solid #a8cbb7' : row.object && pane.json ? '2px solid #6889b9' : '2px solid transparent', background: row.hot ? '#203229' : row.object && pane.json ? '#1b2030' : 'transparent', boxSizing: 'border-box', fontSize: 11.5, whiteSpace: 'nowrap'}}>
          <span style={{fontSize: 10, color: '#656b83', paddingTop: row.object ? 8 : 0}}>{row.at}</span><span style={{width: 34, flexShrink: 0, fontSize: 10, fontWeight: 700, color: row.color, paddingTop: row.object ? 8 : 0}}>{row.source}</span>{row.object ? <JsonLog expanded={Boolean(pane.json)}/> : <span style={{color: row.hot ? '#c5e4cf' : '#d1d2df'}}>{row.text}</span>}
        </div>)}
        <div style={{padding: '10px 18px', fontFamily: monoFont, color: '#515770', fontSize: 11}}><span style={{color: '#8878b4'}}>›</span><span style={{marginLeft: 8, opacity: view.frame % 30 < 20 ? .9 : .2}}>▍</span></div>
      </div>
      <div style={{height: 23, padding: '0 16px', display: 'flex', alignItems: 'center', fontSize: 9.5, color: '#656b81', borderTop: hairline}}><span>Your app's JavaScript and native output, together</span><span style={{marginLeft: 'auto'}}>Following output ↓</span></div>
    </>}
  </div>;
}

/** Faithful Studio pane hierarchy, enlarged for legibility in a film */
export function StudioWindow({view}: {view: StudioView}) {
  const project = view.project ?? {name: 'Orbit', id: 'com.example.orbit', app: 'orbit' as const};
  const {bar} = view;
  const live = bar.mode === 'live';
  return <div style={{position: 'relative', width: 1440, height: 690, borderRadius: 13, overflow: 'hidden', border: '1px solid rgba(218,209,255,.22)', background: '#10121d', color: '#f3f2f8', fontFamily: uiFont, boxSizing: 'border-box', boxShadow: '0 40px 100px rgba(0,0,0,.48), 0 0 0 1px rgba(0,0,0,.3)'}}>
    <div style={{height: 42, borderBottom: hairline, display: 'flex', alignItems: 'center', paddingLeft: 15, background: 'linear-gradient(90deg,#202131,#181b28)', fontSize: 13, gap: 9}}>
      <Img src={staticFile('capmac-icon.svg')} style={{width: 21, height: 21}}/>
      <span style={{fontWeight: 600}}>CapMac Studio</span><Glyph name="chevron" size={13} color="#656679"/><span style={{color: '#a7a6b5'}}>{project.name}</span>
      <div style={{position: 'absolute', left: 570, top: 8, width: 347, height: 27, display: 'flex', gap: 9, alignItems: 'center', padding: '0 10px', borderRadius: 5, border: hairline, background: '#141621', color: '#9998ab', boxSizing: 'border-box', fontSize: 12}}><Glyph name="search" size={14}/><span>Search or run a command</span><span style={{marginLeft: 'auto', fontSize: 10, padding: '1px 4px', border: hairline, borderRadius: 3}}>Ctrl K</span></div>
      <div style={{marginLeft: 'auto', height: '100%', display: 'flex', alignItems: 'center'}}><div style={{width: 46, height: 42, display: 'grid', placeItems: 'center'}}><span style={{width: 11, height: 1, background: '#b9b8c3'}}/></div><div style={{width: 46, height: 42, display: 'grid', placeItems: 'center'}}><span style={{width: 9, height: 9, border: '1px solid #b9b8c3'}}/></div><div style={{width: 46, height: 42, display: 'grid', placeItems: 'center', fontSize: 20, color: '#b9b8c3', fontWeight: 300}}>×</div></div>
    </div>

    <div style={{display: 'flex', height: 646}}>
      <div style={{width: 56, flexShrink: 0, background: '#141621', borderRight: hairline, paddingTop: 13, boxSizing: 'border-box', display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 10}}>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6'}}><Glyph name="home" size={20}/></div>
        <div style={{position: 'relative', width: 39, height: 39, borderRadius: 6, background: '#2b263e', border: '1px solid #403550', display: 'grid', placeItems: 'center'}}><div style={{position: 'absolute', left: -8, width: 3, height: 20, borderRadius: 2, background: lavender}}/><AppIcon app={project.app} size={26}/><span style={{position: 'absolute', right: 3, bottom: 2}}><Dot size={5}/></span></div>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6', marginTop: 16}}><Glyph name="phone"/></div>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6'}}><Glyph name="mac"/></div>
        <div style={{flex: 1}}/>
        <div style={{position: 'relative', width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#a4a6bb'}}><Glyph name="mac"/><span style={{position: 'absolute', right: 4, bottom: 6}}><Dot size={5}/></span></div>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6', marginBottom: 13}}><Glyph name="settings"/></div>
      </div>

      <div style={{flex: 1, minWidth: 0, position: 'relative'}}>
        <div style={{height: 70, display: 'flex', alignItems: 'center', padding: '0 19px', gap: 13, borderBottom: hairline, background: '#1b1d2a', boxSizing: 'border-box'}}>
          <AppIcon app={project.app} size={37}/>
          <div style={{width: view.appPicker ? 150 : 228}}><div style={{fontSize: 17, fontWeight: 650, letterSpacing: '-.2px'}}>{project.name}</div><div style={{fontFamily: monoFont, fontSize: 10.5, marginTop: 5, color: '#898b9f'}}>{project.id}</div></div>
          {view.appPicker && <><PickerButton picker={view.appPicker}/><span style={{width: 1, height: 26, background: '#34364a'}}/></>}
          <PickerButton picker={view.mac}/>
          <Glyph name="chevron" color="#55596c" size={13}/>
          <PickerButton picker={view.target}/>
          <div style={{flex: 1}}/>
          <StudioButton icon="flash" accent active={view.live.active} pressed={view.live.pressed}>Live</StudioButton>
          <div style={{display: 'flex'}}><StudioButton icon="play" pressed={view.runPressed} style={{borderRadius: '5px 0 0 5px'}}>Run</StudioButton><div style={{width: 26, height: 33, display: 'grid', placeItems: 'center', borderRadius: '0 5px 5px 0', border: hairline, borderLeft: 'none', background: view.menuOpen ? '#30334a' : '#242635', boxSizing: 'border-box'}}><Glyph name="chevron" size={12} color="#c9c9d6" style={{transform: 'rotate(90deg)'}}/></div></div>
          <StudioButton icon="stop"/>
          <div style={{width: 1, height: 24, background: '#353646', margin: '0 3px'}}/>
          <Glyph name="box" color="#9396ac" size={19}/><Glyph name="code" color="#9396ac" size={19}/><Glyph name="more" color="#9396ac" size={19}/>
        </div>

        <div style={{height: 34, display: 'flex', alignItems: 'center', gap: 11, padding: '0 19px', borderBottom: hairline, background: live ? '#1b2328' : '#1b1d2a', boxSizing: 'border-box', fontSize: 11}}>
          <span style={{display: 'flex', alignItems: 'center', gap: 5, color: live ? mint : '#9294a7', fontWeight: 650}}><Glyph name="flash" size={13}/>{live ? 'Live' : 'Ready'}</span>
          {bar.url && <span style={{color: '#b8c7c7', fontFamily: monoFont, fontSize: 10.5}}>{bar.url}</span>}
          <span style={{display: 'flex', alignItems: 'center', gap: 6, color: bar.linked === false ? '#6b7184' : '#748f87'}}><span style={{width: 26, height: 1, background: bar.linked === false ? '#3b3f52' : '#466456'}}/>link<span style={{width: 26, height: 1, background: bar.linked === false ? '#3b3f52' : '#466456'}}/></span>
          <span style={{display: 'flex', alignItems: 'center', gap: 5, color: '#b8c7c7'}}>{bar.peer}</span>
          <span style={{height: 13, width: 1, background: '#3a4a47', margin: '0 2px'}}/>
          <Dot size={5} glow={live} color={bar.mode === 'failed' ? '#e692a6' : live ? mint : '#697085'}/><span style={{color: bar.mode === 'failed' ? '#e9a3b3' : live ? '#a9c4b6' : '#858a9e'}}>{bar.status}</span>
          <span style={{marginLeft: 'auto', color: '#9baaaf'}}>↻ Restart app</span><span style={{marginLeft: 9, color: '#9baaaf'}}>⟳ Rebuild</span>
        </div>

        <div style={{height: 542, display: 'flex'}}>
          <div style={{width: 414, flexShrink: 0, borderRight: '3px solid #10121d', background: '#151823', position: 'relative', overflow: 'hidden'}}>
            <div style={{height: 36, display: 'flex', gap: 10, alignItems: 'center', padding: '0 16px', borderBottom: hairline, fontSize: 12, boxSizing: 'border-box'}}><span style={{fontWeight: 600}}>{view.pane.title}</span><span style={{fontSize: 10.5, color: '#85879d'}}>{view.pane.sub}</span><Glyph name="phone" color="#777b91" size={15} style={{marginLeft: 'auto'}}/></div>
            {view.pane.content}
            <div style={{position: 'absolute', bottom: 10, left: 17, right: 17, height: 24, display: 'flex', gap: 14, alignItems: 'center', color: '#8a8da3'}}>{view.pane.foot ?? <><Glyph name="home" size={15}/><Glyph name="lock" size={14}/><Glyph name="code" size={15}/></>}<span style={{marginLeft: 'auto', display: 'flex', gap: 5, alignItems: 'center', fontSize: 10, color: live ? '#9fb8ae' : '#7d8195'}}><Dot size={5} color={live ? mint : '#697085'}/>{live ? 'Live' : 'Idle'}</span></div>
          </div>
          <div style={{flex: 1, minWidth: 0, background: '#171926'}}>
            <Timeline view={view}/>
            <ConsolePane view={view}/>
          </div>
        </div>
        {view.overlay}
      </div>
    </div>
  </div>;
}

/** The simulator pane's phone, centered under a soft glow */
export function SimulatorStage({children}: {children: ReactNode}) {
  return <>
    <div style={{position: 'absolute', top: 46, left: 47, width: 319, height: 433, borderRadius: '50%', background: 'radial-gradient(ellipse,rgba(155,130,220,.14),transparent 70%)'}}/>
    <div style={{position: 'absolute', top: 50, left: (414 - 223.5) / 2, width: 223.5, height: 447}}>{children}</div>
  </>;
}

export type MenuItem = {label: string; hint?: string; icon: IconName; checked?: boolean; separator?: boolean};

/** One of Studio's menus, open under the button that opened it */
export function Menu({items, highlight, left, top, width = 300, opacity = 1}: {items: readonly MenuItem[]; highlight?: number; left: number; top: number; width?: number; opacity?: number}) {
  return <div style={{position: 'absolute', left, top, width, padding: 6, borderRadius: 9, background: '#1e2131', border: '1px solid #ffffff1c', boxShadow: '0 18px 44px #000a, 0 2px 8px #0006', zIndex: 20, opacity, transform: `translateY(${(1 - opacity) * -6}px)`, boxSizing: 'border-box', fontFamily: uiFont}}>
    {items.map((item, i) => <React.Fragment key={item.label}>
      {item.separator && <div style={{height: 1, background: '#ffffff12', margin: '5px 4px'}}/>}
      <div style={{display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, padding: '6px 10px', borderRadius: 6, background: highlight === i ? '#3a3256' : 'transparent', color: '#ecebf3', boxSizing: 'border-box'}}>
        <Glyph name={item.icon} size={17} color={highlight === i ? '#e2d8ff' : '#a9abc0'}/>
        <div style={{flex: 1}}><div style={{fontSize: 13, fontWeight: 500}}>{item.label}</div>{item.hint && <div style={{fontSize: 10.5, color: '#9a9cb1', marginTop: 2}}>{item.hint}</div>}</div>
        {item.checked && <Glyph name="check" size={15} color={lavender}/>}
      </div>
    </React.Fragment>)}
  </div>;
}

/** Studio's modal dialog over a dimmed window */
export function Dialog({title, icon, width = 640, children, footer, opacity = 1}: {title: string; icon: IconName; width?: number; children: ReactNode; footer: ReactNode; opacity?: number}) {
  return <div style={{position: 'absolute', inset: 0, background: `rgba(8,9,16,${.55 * opacity})`, display: 'grid', placeItems: 'center', zIndex: 30}}>
    <div style={{width, borderRadius: 11, background: '#1b1e2c', border: '1px solid #ffffff1f', boxShadow: '0 30px 80px #000c', opacity, transform: `translateY(${(1 - opacity) * 14}px) scale(${.98 + opacity * .02})`, fontFamily: uiFont, color: '#efeef6', overflow: 'hidden'}}>
      <div style={{height: 50, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', borderBottom: hairline}}><Glyph name={icon} size={18} color={lavender}/><span style={{fontSize: 15, fontWeight: 650}}>{title}</span><Glyph name="close" size={15} color="#8e90a6" style={{marginLeft: 'auto'}}/></div>
      <div style={{padding: '14px 20px 6px'}}>{children}</div>
      <div style={{display: 'flex', justifyContent: 'flex-end', gap: 9, padding: '12px 18px 16px'}}>{footer}</div>
    </div>
  </div>;
}

export function DialogButton({children, icon, accent = false, pressed = false}: {children: ReactNode; icon?: IconName; accent?: boolean; pressed?: boolean}) {
  return <span style={{height: 31, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '0 13px', borderRadius: 5, fontSize: 12.5, fontWeight: accent ? 650 : 500, border: accent ? '1px solid #ccb8ff' : hairline, background: accent ? pressed ? '#a18bcc' : '#b29edf' : '#262939', color: accent ? '#1e1631' : '#e7e7ee', transform: pressed ? 'scale(.97)' : undefined}}>{icon && <Glyph name={icon} size={15}/>}{children}</span>;
}

export type SetupStep = {title: string; desc: string; state: 'waiting' | 'running' | 'done'; note?: string; progress?: number};

/** Setting up this PC to build with no Mac, step by step, as Studio's setup screen shows it */
export function SetupSteps({frame, steps}: {frame: number; steps: readonly SetupStep[]}) {
  return <div style={{display: 'flex', flexDirection: 'column', gap: 2}}>
    {steps.map(step => <div key={step.title} style={{display: 'flex', gap: 12, padding: '9px 10px', borderRadius: 7, background: step.state === 'running' ? '#242339' : 'transparent'}}>
      <span style={{paddingTop: 2}}>{step.state === 'running' ? <Spinner frame={frame} size={16}/> : step.state === 'done' ? <span style={{width: 16, height: 16, borderRadius: 8, background: '#6fcf9f', display: 'grid', placeItems: 'center'}}><Glyph name="check" size={11} color="#10251a"/></span> : <Glyph name="circle" size={16} color="#5b5e75"/>}</span>
      <div style={{flex: 1}}>
        <div style={{display: 'flex', alignItems: 'baseline', gap: 10}}><span style={{fontSize: 13, fontWeight: 600, color: step.state === 'waiting' ? '#a4a6ba' : '#f1f0f7'}}>{step.title}</span><span style={{marginLeft: 'auto', fontSize: 11, color: step.state === 'done' ? '#8fd3ae' : step.state === 'running' ? '#cdbcff' : '#7e8197'}}>{step.state === 'done' ? 'Done' : step.state === 'running' ? 'Working' : 'Waiting'}</span></div>
        <div style={{fontSize: 11.5, color: '#9a9cb1', marginTop: 3}}>{step.desc}</div>
        {step.state === 'running' && step.progress !== undefined && <div style={{display: 'flex', alignItems: 'center', gap: 10, marginTop: 8}}>
          <div style={{flex: 1, height: 5, borderRadius: 3, background: '#2e3046', overflow: 'hidden'}}><div style={{width: `${Math.round(step.progress * 100)}%`, height: '100%', borderRadius: 3, background: 'linear-gradient(90deg,#9c86e8,#c2adff)'}}/></div>
          <span style={{fontSize: 10.5, color: '#b5a8de', fontFamily: monoFont, minWidth: 130, textAlign: 'right'}}>{step.note}</span>
        </div>}
      </div>
    </div>)}
  </div>;
}

/** Where the simulator shows when the app builds on this PC: the iPhone shows the app itself */
export function DevicePane({name, os, running}: {name: string; os: string; running: boolean}) {
  return <div style={{position: 'absolute', inset: '36px 0 44px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 40px'}}>
    <div style={{width: 64, height: 64, borderRadius: 32, background: '#20233a', border: '1px solid #ffffff14', display: 'grid', placeItems: 'center'}}><Glyph name="phone" size={30} color="#c8bdf0"/></div>
    <div style={{fontSize: 15, fontWeight: 650, marginTop: 16}}>{name}</div>
    <div style={{fontSize: 11, color: '#8a8da4', marginTop: 4}}>{os}</div>
    <div style={{fontSize: 12, color: '#c3c4d4', marginTop: 16, lineHeight: 1.5}}>Your app runs on your iPhone, not in a window here</div>
    {running && <div style={{fontSize: 11, color: '#8a8da4', marginTop: 6}}>Its logs show in the console below</div>}
  </div>;
}

export const frameRamp = (frame: number, from: number, to: number) => interpolate(frame, [from, to], [0, 1], clamp);
