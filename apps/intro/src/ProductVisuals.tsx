import React, {type CSSProperties, type ReactNode} from 'react';
import {Img, interpolate, staticFile} from 'remotion';

const uiFont = '"Segoe UI Variable", "Segoe UI", sans-serif';
const monoFont = '"Cascadia Code", "JetBrains Mono", Consolas, monospace';
const lavender = '#c2adff';
const mint = '#91e2c1';
const hairline = '1px solid rgba(255,255,255,0.075)';
const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

type IconName = 'home' | 'mac' | 'phone' | 'settings' | 'play' | 'flash' | 'box' | 'code' | 'search' | 'chevron' | 'check' | 'stop' | 'refresh' | 'more' | 'lock' | 'arrow' | 'chart' | 'card';

function Glyph({name, size = 20, color = 'currentColor', style}: {name: IconName; size?: number; color?: string; style?: CSSProperties}) {
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
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" style={{display: 'block', flexShrink: 0, ...style}}>{paths[name]}</svg>;
}

function Dot({color = mint, size = 6, glow = false}: {color?: string; size?: number; glow?: boolean}) {
  return <span style={{display: 'inline-block', width: size, height: size, flexShrink: 0, borderRadius: '50%', background: color, boxShadow: glow ? `0 0 9px ${color}55` : undefined}}/>;
}

function OrbitMark({size = 30, color = '#f7f4ee'}: {size?: number; color?: string}) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none"><ellipse cx="20" cy="20" rx="12" ry="12" stroke={color} strokeWidth="2.5"/><ellipse cx="20" cy="20" rx="18" ry="6" transform="rotate(-38 20 20)" stroke={color} strokeWidth="2"/><circle cx="30" cy="10" r="3" fill={color}/></svg>;
}

/** A deliberately fictional Capacitor demo app, drawn at a fixed 300 × 600. */
export function Phone({frame = 0, variant = 'violet', scale = 1, view = 'home', tapFrame = 0}: {frame?: number; variant?: 'violet' | 'mint'; scale?: number; view?: 'home' | 'activity'; tapFrame?: number}) {
  const isMint = variant === 'mint';
  const accent = isMint ? '#a1ddbd' : '#c5b5ec';
  const accentDeep = isMint ? '#265345' : '#58407e';
  const ring = interpolate(frame, [0, 65], [0.56, 0.64], clamp);
  const chartGrowth = interpolate(frame, [0, 50], [0.82, 1], clamp);
  const barHeights = [14, 25, 20, 31, 40, 33, 50, 41, 55, 47, 62, 70];
  const activityEntrance = interpolate(tapFrame, [0, 14], [0, 1], clamp);

  return <div style={{position: 'relative', width: 300, height: 600, flexShrink: 0, transform: `scale(${scale})`, transformOrigin: 'top left', borderRadius: 47, background: 'linear-gradient(150deg,#4b4b51 0%,#17181c 23%,#08090b 50%,#414146 100%)', boxShadow: '0 28px 65px rgba(0,0,0,.42), inset 0 0 0 1.5px rgba(255,255,255,.24), inset 0 0 0 4px #16171b', fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif', color: '#282830'}}>
    <div style={{position: 'absolute', left: -2, top: 116, width: 3, height: 25, borderRadius: '2px 0 0 2px', background: '#424249'}}/>
    <div style={{position: 'absolute', left: -2, top: 159, width: 3, height: 45, borderRadius: '2px 0 0 2px', background: '#424249'}}/>
    <div style={{position: 'absolute', left: -2, top: 213, width: 3, height: 45, borderRadius: '2px 0 0 2px', background: '#424249'}}/>
    <div style={{position: 'absolute', right: -2, top: 176, width: 3, height: 61, borderRadius: '0 2px 2px 0', background: '#424249'}}/>
    <div style={{position: 'absolute', inset: 9, overflow: 'hidden', borderRadius: 38, background: '#f5f3ed', boxShadow: 'inset 0 0 0 1px #000'}}>
      <div style={{position: 'absolute', top: 15, left: 23, fontSize: 12, fontWeight: 800, letterSpacing: '-.2px'}}>9:41</div>
      <div style={{position: 'absolute', left: 90, top: 10, width: 101, height: 27, borderRadius: 20, background: '#0a0a0c', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 9, boxSizing: 'border-box'}}><div style={{width: 7, height: 7, borderRadius: '50%', background: 'radial-gradient(circle at 36% 35%,#29304b,#0e1019 58%)'}}/></div>
      <svg width="48" height="14" viewBox="0 0 48 14" style={{position: 'absolute', right: 21, top: 18}}><path d="M1 11V9h2v2zm4 0V6h2v5zm4 0V4h2v7zm4 0V2h2v9z" fill="#262630"/><path d="M19 5c3-3 7-3 10 0M21 7c2-2 4-2 6 0" fill="none" stroke="#262630" strokeWidth="1.5" strokeLinecap="round"/><circle cx="24" cy="10" r="1.25" fill="#262630"/><rect x="33" y="3" width="12" height="8" rx="2" fill="none" stroke="#262630" strokeWidth="1"/><rect x="35" y="5" width="8" height="4" rx=".5" fill="#262630"/><path d="M47 5v4" stroke="#262630"/></svg>

      <div style={{position: 'absolute', top: 58, left: 20, right: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 7}}><OrbitMark size={26} color="#3b354b"/><span style={{fontSize: 23, fontWeight: 800, letterSpacing: '-1.1px'}}>Orbit</span></div>
        <div style={{width: 29, height: 29, borderRadius: '50%', background: '#e8e3d8', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 800, color: '#635a4c', border: '2px solid white'}}>JD</div>
      </div>

      <div style={{position: 'absolute', inset: 0, opacity: view === 'activity' ? 1 - activityEntrance : 1, transform: `translateX(${view === 'activity' ? -12 * activityEntrance : 0}px)`, pointerEvents: 'none'}}>
      <div style={{position: 'absolute', left: 20, top: 111, fontSize: 10, fontWeight: 600, color: '#8c8890', letterSpacing: '.7px'}}>YOUR BALANCE</div>
      <div style={{position: 'absolute', top: 127, left: 19, right: 20, display: 'flex', alignItems: 'center', gap: 9}}>
        <span style={{fontSize: 31, fontWeight: 800, letterSpacing: '-1.4px', lineHeight: 1.2}}>$12,840<span style={{fontSize: 18, color: '#99959c', fontWeight: 500}}>.00</span></span>
        <span style={{marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '5px 7px', borderRadius: 6, background: '#e2eee4', color: '#457b52'}}>↗ 8.2%</span>
      </div>

      <div style={{position: 'absolute', top: 180, left: 17, right: 17, height: 126, padding: 17, boxSizing: 'border-box', borderRadius: 20, background: accent, overflow: 'hidden'}}>
        <svg width="190" height="190" style={{position: 'absolute', left: -46, bottom: -119, opacity: .13}}><circle cx="95" cy="95" r="91" fill="none" stroke={accentDeep} strokeWidth="1.3"/><circle cx="95" cy="95" r="68" fill="none" stroke={accentDeep}/><circle cx="95" cy="95" r="45" fill="none" stroke={accentDeep}/></svg>
        <div style={{position: 'relative', fontSize: 10, color: accentDeep, fontWeight: 700}}>Savings goal</div>
        <div style={{position: 'relative', fontSize: 24, letterSpacing: '-.9px', fontWeight: 800, marginTop: 12}}>$320<span style={{fontSize: 12, fontWeight: 500, marginLeft: 5, color: accentDeep}}>saved</span></div>
        <div style={{position: 'relative', fontSize: 9, marginTop: 7, color: accentDeep}}>Weekend escape <span style={{opacity: .55}}> / $500 goal</span></div>
        <div style={{position: 'absolute', right: 12, top: 30, width: 80, height: 80}}>
          <svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="32" fill="none" stroke="rgba(255,255,255,.34)" strokeWidth="6"/><circle cx="40" cy="40" r="32" fill="none" stroke={accentDeep} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 32}`} strokeDashoffset={2 * Math.PI * 32 * (1 - ring)} transform="rotate(-90 40 40)"/></svg>
          <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 16, fontWeight: 800, letterSpacing: '-.5px'}}>{Math.round(ring * 100)}<span style={{position: 'absolute', top: 48, fontSize: 6, color: accentDeep, letterSpacing: '.5px'}}>PERCENT</span></div>
        </div>
      </div>

      <div style={{position: 'absolute', top: 319, left: 17, right: 17, height: 111, padding: '14px 15px 0', boxSizing: 'border-box', borderRadius: 17, background: '#fffefa', border: '1px solid #eae7e0'}}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}><span style={{fontSize: 10, fontWeight: 700}}>Monthly savings</span><span style={{fontSize: 8, color: '#98939b'}}>This month <span style={{marginLeft: 4}}>⌄</span></span></div>
        <div style={{display: 'flex', alignItems: 'flex-end', gap: 7, height: 64, marginTop: 10, paddingBottom: 6}}>{barHeights.map((height, i) => <div key={i} style={{width: 12, height: height * .72 * chartGrowth, borderRadius: '3px 3px 1px 1px', background: i === 11 ? accentDeep : i > 7 ? accent : '#eae7ef', opacity: i < 8 ? .85 : 1}}/>)}</div>
      </div>

      <div style={{position: 'absolute', top: 445, left: 21, right: 21, display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 800}}>Recent activity<span style={{fontSize: 8, fontWeight: 600, color: '#928c97'}}>See all →</span></div>
      <div style={{position: 'absolute', top: 470, left: 20, right: 20, display: 'flex', alignItems: 'center', gap: 10}}>
        <div style={{width: 31, height: 31, borderRadius: 10, background: '#ece6f6', display: 'grid', placeItems: 'center', color: '#695789'}}><Glyph name="card" size={16}/></div>
        <div style={{fontSize: 9, fontWeight: 700}}>Coffee & company<div style={{fontSize: 7, color: '#97909d', fontWeight: 500, marginTop: 4}}>Today · Card payment</div></div>
        <div style={{marginLeft: 'auto', fontSize: 10, fontWeight: 800}}>−$6.50</div>
      </div>
      </div>

      {view === 'activity' && <div style={{position: 'absolute', left: 20, right: 20, top: 109, opacity: activityEntrance, transform: `translateX(${12 * (1 - activityEntrance)}px)`}}>
        <div style={{fontSize: 23, fontWeight: 800, letterSpacing: '-.8px'}}>Activity</div>
        <div style={{fontSize: 10, color: '#8c8890', marginTop: 7}}>Your month at a glance</div>
        <div style={{marginTop: 18, borderRadius: 20, padding: 17, background: '#fffefa', border: '1px solid #eae7e0'}}>
          <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 700}}><span>Saved this month</span><span style={{color: '#98939b', fontSize: 8}}>October ⌄</span></div>
          <div style={{fontSize: 30, fontWeight: 800, letterSpacing: '-1px', marginTop: 10}}>$320<span style={{fontSize: 11, fontWeight: 500, color: '#98939b', marginLeft: 7}}>of $500</span></div>
          <div style={{display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 83, marginTop: 12, borderBottom: '1px solid #eeebe5', paddingBottom: 5}}>{[26, 38, 30, 49, 42, 57, 48, 69, 62, 80].map((height, i) => <div key={i} style={{width: 13, height: height * interpolate(tapFrame, [5 + i, 24 + i], [.1, 1], clamp), background: i === 9 ? accentDeep : i > 5 ? accent : '#e9e6ee', borderRadius: '4px 4px 0 0'}}/>)}</div>
          <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 7, color: '#aaa2ad', marginTop: 7}}><span>1 Oct</span><span>15 Oct</span><span>31 Oct</span></div>
        </div>
        <div style={{display: 'flex', justifyContent: 'space-between', marginTop: 19, fontSize: 10, fontWeight: 800}}>Transactions<span style={{fontSize: 8, color: '#98939b', fontWeight: 600}}>This week ⌄</span></div>
        {[{icon: 'card' as const, title: 'Coffee & company', detail: 'Today · Card payment', amount: '−$6.50'}, {icon: 'arrow' as const, title: 'Weekend escape', detail: 'Yesterday · Savings transfer', amount: '+$40.00'}].map((item, i) => <div key={item.title} style={{display: 'flex', alignItems: 'center', gap: 9, padding: '13px 0', borderBottom: i === 0 ? '1px solid #e8e4dd' : undefined}}><div style={{width: 30, height: 30, borderRadius: 10, background: i === 0 ? '#ece6f6' : '#e3eee5', display: 'grid', placeItems: 'center', color: i === 0 ? '#695789' : '#477357'}}><Glyph name={item.icon} size={15}/></div><div style={{fontSize: 9, fontWeight: 700}}>{item.title}<div style={{fontSize: 7, color: '#97909d', fontWeight: 500, marginTop: 4}}>{item.detail}</div></div><span style={{marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: i === 0 ? '#282830' : '#477357'}}>{item.amount}</span></div>)}
      </div>}

      <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 62, background: '#fffefa', borderTop: '1px solid #e8e5df', display: 'flex', padding: '10px 27px 0', justifyContent: 'space-between', boxSizing: 'border-box'}}>
        {(['home', 'chart', 'card', 'settings'] as const).map((name, i) => <div key={name} style={{position: 'relative', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center', color: i === (view === 'activity' ? 1 : 0) ? accentDeep : '#afa8b2'}}>{view === 'activity' && i === 1 && <span style={{position: 'absolute', inset: '-5px -11px', background: accent, opacity: .3, borderRadius: 12}}/>}<Glyph name={name} size={18}/><span style={{position: 'relative', fontSize: 6.5, fontWeight: 700}}>{['Home', 'Activity', 'Cards', 'You'][i]}</span></div>)}
      </div>
      <div style={{position: 'absolute', left: 101, bottom: 7, width: 81, height: 3.5, borderRadius: 10, background: '#26242b'}}/>
    </div>
    <div style={{position: 'absolute', inset: 5, borderRadius: 42, border: '1px solid rgba(255,255,255,.10)', pointerEvents: 'none'}}/>
  </div>;
}

function StudioButton({children, icon, accent = false, active = false, pressed = false}: {children?: ReactNode; icon: IconName; accent?: boolean; active?: boolean; pressed?: boolean}) {
  return <div style={{height: 33, padding: children ? '0 13px' : '0 8px', display: 'flex', alignItems: 'center', gap: 7, borderRadius: 5, border: accent ? `1px solid ${active ? '#d6c7ff' : '#ccb8ff'}` : hairline, background: accent ? pressed ? '#a18bcc' : active ? '#c3aff4' : '#b29edf' : '#242635', color: accent ? '#1e1631' : '#e7e7ee', fontSize: 13, fontWeight: accent ? 650 : 500, transform: pressed ? 'translateY(1px) scale(.97)' : undefined, boxShadow: pressed ? 'inset 0 2px 6px #442b7455' : active && accent ? '0 0 0 2px #c3aff419' : undefined}}><Glyph name={icon} size={16}/>{children}{active ? <Dot size={5} color={accent ? '#315944' : mint}/> : null}</div>;
}

const phases = ['Web build', 'Copy to Mac', 'Packages', 'cap sync', 'Xcode build', 'Simulator', 'Install', 'Open app'];
const phaseDetails = ['dev server', 'synced', 'up to date', 'synced', 'built', 'already on', 'installed', 'running'];

const logRows = [
  {source: 'CM', color: '#93b8ff', text: 'Connected to Mac mini · direct connection', at: '09:41:00'},
  {source: 'WEB', color: '#91ded8', text: 'VITE  ready · Local: http://localhost:5173/', at: '09:41:01'},
  {source: 'CAP', color: lavender, text: 'Syncing iOS plugins and native project', at: '09:41:02'},
  {source: 'iOS', color: '#b4b5c0', text: 'Build succeeded · Launching on iPhone 16 Pro', at: '09:41:03'},
  {source: 'JS', color: '#9dc7ff', text: 'Orbit mounted  ›  { platform: "ios", ready: true }', at: '09:41:04'},
  {source: 'CAP', color: lavender, text: 'To Native → Haptics.impact', at: '09:41:05'},
  {source: 'iOS', color: '#b4b5c0', text: 'WebView did finish navigation', at: '09:41:05'},
  {source: 'JS', color: '#9dc7ff', text: '[vite] hot updated: /src/App.tsx', at: '09:41:08'},
];

function ProblemPanel({frame}: {frame: number}) {
  const selected = frame >= 80;
  const path = 'C:\\projects\\orbit\\ios\\App\\App\\AppDelegate.swift';
  return <div style={{height: 285, background: '#151724', fontSize: 12, overflow: 'hidden'}}>
    <div style={{height: 38, display: 'flex', alignItems: 'center', padding: '0 17px', gap: 9, borderBottom: hairline, background: '#1b1d2a'}}><span style={{padding: '3px 7px', borderRadius: 4, fontSize: 10, background: '#462b35', color: '#f1a7b3'}}>1 error</span><span style={{marginLeft: 'auto', color: '#9b9db1', fontSize: 11}}>Copy all</span></div>
    <div style={{height: 38, display: 'flex', alignItems: 'center', gap: 8, padding: '0 17px', borderBottom: hairline, background: '#1d2030'}}><Glyph name="chevron" size={12} style={{transform: 'rotate(90deg)'}} color="#949ab1"/><Glyph name="code" size={15} color="#bcaddb"/><span style={{fontWeight: 600}}>AppDelegate.swift</span><span style={{fontFamily: monoFont, color: '#81869d', fontSize: 11}}>ios\App\App</span><span style={{marginLeft: 'auto', color: '#ee9aa9', borderRadius: 4, padding: '2px 6px', background: '#422c36', fontSize: 10}}>1</span></div>
    <div style={{padding: '13px 22px 0', background: selected ? '#272338' : '#1a1b29', borderLeft: '2px solid #de7e91'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 9, height: 22}}><span style={{width: 15, height: 15, borderRadius: '50%', color: '#19202b', background: '#df8194', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 11}}>×</span><span style={{fontWeight: 600, color: '#e4dce8'}}>Cannot find 'analytics' in scope</span><span style={{marginLeft: 'auto', fontFamily: monoFont, fontSize: 11, color: '#9794ae'}}>24:9</span></div>
      <button type="button" title="Open AppDelegate.swift at line 24, column 9" style={{display: 'flex', alignItems: 'center', gap: 5, margin: '10px 0 12px 24px', padding: 0, fontFamily: monoFont, fontSize: 11.5, color: selected ? '#d2bcff' : '#a99cca', border: 0, background: 'transparent', textDecoration: 'underline', textDecorationColor: '#6d5b8c', textUnderlineOffset: 3, cursor: 'pointer'}}>{path}:24:9<Glyph name="arrow" size={12}/></button>
      <pre style={{fontFamily: monoFont, margin: '0 0 0 24px', padding: '11px 12px', background: '#121520', border: hairline, borderRadius: 4, color: '#c3c5d7', fontSize: 12, lineHeight: 1.7}}><span style={{color: '#626981'}}>24   </span>analytics.track("app_open"){'\n'}<span style={{color: '#626981'}}>     </span><span style={{color: '#ec99a6'}}>^^^^^^^^^</span></pre>
      <div style={{height: 40, display: 'flex', alignItems: 'center', marginLeft: 24, gap: 12, color: '#737c95', fontSize: 10}}><span>Swift</span><span style={{width: 1, height: 10, background: '#3a3d51'}}/><span>xcodebuild</span><button type="button" style={{marginLeft: 'auto', marginRight: 4, border: hairline, background: selected ? '#3c3052' : '#242637', color: '#c9bddc', fontFamily: uiFont, borderRadius: 4, padding: '4px 8px', fontSize: 10}}>Open in editor</button><span style={{color: '#9597ad'}}>Copy</span></div>
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
      <div style={{paddingLeft: 18}}><span style={{color: '#b8a7d6'}}>device</span>: <span style={{color: '#accaae'}}>"iPhone 16 Pro"</span>,</div>
      <div style={{paddingLeft: 18}}><span style={{color: '#b8a7d6'}}>live</span>: <span style={{color: '#d5b288'}}>true</span></div>
      <div>{'}'}</div>
      <div style={{display: 'flex', justifyContent: 'space-between', maxWidth: 350}}><span>{'}'}</span><span style={{fontFamily: uiFont, fontSize: 10, color: '#a9a1bb', background: '#252537', padding: '1px 7px', border: hairline, borderRadius: 4}}>Copy JSON</span></div>
    </div>}
  </div>;
}

/** Faithful Studio pane hierarchy, enlarged for legibility in a film. */
export function StudioWindow({frame, mode, active, interactionFrame = frame}: {frame: number; mode?: 'build' | 'live' | 'inspect'; active?: 'timeline' | 'console' | 'problems' | 'simulator'; interactionFrame?: number}) {
  const actionFrame = interactionFrame;
  const building = mode === 'build';
  const showProblem = mode === 'inspect' && active === 'problems';
  const consoleFocused = active === 'console';
  const liveActive = !building || actionFrame >= 36;
  const completed = building ? Math.floor(interpolate(actionFrame, [50, 120], [0, 8], clamp)) : mode ? showProblem ? 4 : 8 : Math.min(8, Math.max(2, Math.floor(frame / 10) + 2));
  const finished = completed === 8;
  const updated = mode === 'live' ? actionFrame >= 90 : mode === 'inspect' ? true : mode ? false : frame >= 112;
  const arrivalFrames = [0, 52, 78, 108, 120, 135, 145, 170];
  const rows = consoleFocused && actionFrame >= 40 ? logRows.slice(4, updated ? 8 : 7) : mode === 'build' ? logRows.filter((_, i) => i < 7 && actionFrame >= arrivalFrames[i]) : mode ? logRows.slice(0, updated ? 8 : 7) : logRows.slice(0, Math.min(8, 3 + Math.floor(Math.max(0, frame) / 19)));
  const pulse = .55 + .45 * Math.sin(frame / 13);

  return <div style={{position: 'relative', width: 1440, height: 690, borderRadius: 13, overflow: 'hidden', border: '1px solid rgba(218,209,255,.22)', background: '#10121d', color: '#f3f2f8', fontFamily: uiFont, boxSizing: 'border-box', boxShadow: '0 40px 100px rgba(0,0,0,.48), 0 0 0 1px rgba(0,0,0,.3)'}}>
    <div style={{height: 42, borderBottom: hairline, display: 'flex', alignItems: 'center', paddingLeft: 15, background: 'linear-gradient(90deg,#202131,#181b28)', fontSize: 13, gap: 9}}>
      <Img src={staticFile('capmac-icon.svg')} style={{width: 21, height: 21}}/>
      <span style={{fontWeight: 600}}>CapMac Studio</span><Glyph name="chevron" size={13} color="#656679"/><span style={{color: '#a7a6b5'}}>hello-capacitor</span>
      <div style={{position: 'absolute', left: 570, top: 8, width: 347, height: 27, display: 'flex', gap: 9, alignItems: 'center', padding: '0 10px', borderRadius: 5, border: hairline, background: '#141621', color: '#9998ab', boxSizing: 'border-box', fontSize: 12}}><Glyph name="search" size={14}/><span>Search or run a command</span><span style={{marginLeft: 'auto', fontSize: 10, padding: '1px 4px', border: hairline, borderRadius: 3}}>Ctrl K</span></div>
      <div style={{marginLeft: 'auto', height: '100%', display: 'flex', alignItems: 'center'}}><div style={{width: 46, height: 42, display: 'grid', placeItems: 'center'}}><span style={{width: 11, height: 1, background: '#b9b8c3'}}/></div><div style={{width: 46, height: 42, display: 'grid', placeItems: 'center'}}><span style={{width: 9, height: 9, border: '1px solid #b9b8c3'}}/></div><div style={{width: 46, height: 42, display: 'grid', placeItems: 'center', fontSize: 20, color: '#b9b8c3', fontWeight: 300}}>×</div></div>
    </div>

    <div style={{display: 'flex', height: 646}}>
      <div style={{width: 56, flexShrink: 0, background: '#141621', borderRight: hairline, paddingTop: 13, boxSizing: 'border-box', display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 10}}>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6'}}><Glyph name="home" size={20}/></div>
        <div style={{position: 'relative', width: 39, height: 39, borderRadius: 6, background: '#2b263e', border: '1px solid #403550', display: 'grid', placeItems: 'center'}}><div style={{position: 'absolute', left: -8, width: 3, height: 20, borderRadius: 2, background: lavender}}/><div style={{width: 26, height: 26, borderRadius: 7, background: '#b7a3e9', display: 'grid', placeItems: 'center'}}><OrbitMark size={22} color="#473660"/></div><span style={{position: 'absolute', right: 3, bottom: 2}}><Dot size={5}/></span></div>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6', marginTop: 16}}><Glyph name="phone"/></div>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6'}}><Glyph name="mac"/></div>
        <div style={{flex: 1}}/>
        <div style={{position: 'relative', width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#a4a6bb'}}><Glyph name="mac"/><span style={{position: 'absolute', right: 4, bottom: 6}}><Dot size={5}/></span></div>
        <div style={{width: 39, height: 36, display: 'grid', placeItems: 'center', color: '#8e90a6', marginBottom: 13}}><Glyph name="settings"/></div>
      </div>

      <div style={{flex: 1, minWidth: 0}}>
        <div style={{height: 70, display: 'flex', alignItems: 'center', padding: '0 19px', gap: 13, borderBottom: hairline, background: '#1b1d2a', boxSizing: 'border-box'}}>
          <div style={{width: 37, height: 37, borderRadius: 9, background: '#baa8e9', display: 'grid', placeItems: 'center'}}><OrbitMark size={31} color="#483362"/></div>
          <div style={{width: 228}}><div style={{fontSize: 17, fontWeight: 650, letterSpacing: '-.2px'}}>hello-capacitor</div><div style={{fontFamily: monoFont, fontSize: 10.5, marginTop: 5, color: '#898b9f'}}>com.example.hello</div></div>
          <div style={{display: 'flex', gap: 10, alignItems: 'center', minWidth: 161}}><div style={{position: 'relative'}}><Glyph name="mac" color="#b9bacb" size={22}/><span style={{position: 'absolute', right: -2, bottom: -2}}><Dot size={5}/></span></div><div><div style={{fontSize: 13, fontWeight: 600}}>Mac mini</div><div style={{fontSize: 10, color: '#888ba2', marginTop: 3}}>Connected · direct</div></div><Glyph name="chevron" style={{transform: 'rotate(90deg)', marginLeft: 'auto'}} color="#8a8ba0" size={13}/></div>
          <Glyph name="chevron" color="#55596c" size={13}/>
          <div style={{display: 'flex', gap: 9, alignItems: 'center', minWidth: 185}}><Glyph name="phone" color="#b9bacb" size={23}/><div><div style={{fontSize: 13, fontWeight: 600}}>iPhone 16 Pro</div><div style={{fontSize: 10, color: '#888ba2', marginTop: 3}}>Simulator · iOS 18</div></div><Glyph name="chevron" style={{transform: 'rotate(90deg)', marginLeft: 'auto'}} color="#8a8ba0" size={13}/></div>
          <div style={{flex: 1}}/>
          <StudioButton icon="flash" accent active={liveActive} pressed={building && actionFrame >= 36 && actionFrame < 43}>Live</StudioButton><StudioButton icon="play">Run</StudioButton><StudioButton icon="stop"/>
          <div style={{width: 1, height: 24, background: '#353646', margin: '0 3px'}}/>
          <Glyph name="box" color="#9396ac" size={19}/><Glyph name="code" color="#9396ac" size={19}/><Glyph name="more" color="#9396ac" size={19}/>
        </div>

        <div style={{height: 34, display: 'flex', alignItems: 'center', gap: 11, padding: '0 19px', borderBottom: hairline, background: liveActive ? '#1b2328' : '#1b1d2a', boxSizing: 'border-box', fontSize: 11}}>
          <span style={{display: 'flex', alignItems: 'center', gap: 5, color: liveActive ? mint : '#9294a7', fontWeight: 650}}><Glyph name="flash" size={13}/>{liveActive ? 'Live' : 'Ready'}</span>
          <span style={{color: '#b8c7c7', fontFamily: monoFont, fontSize: 10.5}}>localhost:5173</span>
          <span style={{display: 'flex', alignItems: 'center', gap: 6, color: '#748f87'}}><span style={{width: 26, height: 1, background: '#466456'}}/>link<span style={{width: 26, height: 1, background: '#466456'}}/></span>
          <span style={{display: 'flex', alignItems: 'center', gap: 5, color: '#b8c7c7'}}><Glyph name="mac" size={14}/>Mac mini</span>
          <span style={{height: 13, width: 1, background: '#3a4a47', margin: '0 2px'}}/>
          <Dot size={5} glow={liveActive} color={liveActive ? mint : '#697085'}/><span style={{color: liveActive ? '#a9c4b6' : '#858a9e'}}>{showProblem ? 'Build failed' : building && !finished ? actionFrame < 36 ? 'Ready to run' : actionFrame < 50 ? 'Starting dev server' : 'Building for iOS' : updated ? 'Updated at 09:41:08' : 'Ready for changes'}</span>
          <span style={{marginLeft: 'auto', color: '#9baaaf'}}>↻ Restart app</span><span style={{marginLeft: 9, color: '#9baaaf'}}>⟳ Rebuild</span>
        </div>

        <div style={{height: 542, display: 'flex'}}>
          <div style={{width: 414, flexShrink: 0, borderRight: '3px solid #10121d', background: '#151823', position: 'relative'}}>
            <div style={{height: 36, display: 'flex', gap: 10, alignItems: 'center', padding: '0 16px', borderBottom: hairline, fontSize: 12, boxSizing: 'border-box'}}><span style={{fontWeight: 600}}>Simulator</span><span style={{fontSize: 10.5, color: '#85879d'}}>iPhone 16 Pro · iOS 18</span><Glyph name="phone" color="#777b91" size={15} style={{marginLeft: 'auto'}}/></div>
            <div style={{position: 'absolute', top: 46, left: 47, width: 319, height: 433, borderRadius: '50%', background: 'radial-gradient(ellipse,rgba(155,130,220,.14),transparent 70%)'}}/>
            <div style={{position: 'absolute', top: 50, left: (414 - 223.5) / 2, width: 223.5, height: 447}}><Phone frame={frame} variant={updated ? 'mint' : 'violet'} scale={.745} view={mode === 'build' && actionFrame >= 185 ? 'activity' : 'home'} tapFrame={actionFrame - 185}/></div>
            <div style={{position: 'absolute', bottom: 10, left: 17, right: 17, height: 24, display: 'flex', gap: 14, alignItems: 'center', color: '#8a8da3'}}><Glyph name="home" size={15}/><Glyph name="lock" size={14}/><Glyph name="code" size={15}/><span style={{marginLeft: 'auto', display: 'flex', gap: 5, alignItems: 'center', fontSize: 10, color: '#9fb8ae'}}><Dot size={5}/>Live</span></div>
          </div>

          <div style={{flex: 1, minWidth: 0, background: '#171926'}}>
            <div style={{height: 198, borderBottom: '3px solid #10121d', boxSizing: 'border-box'}}>
              <div style={{height: 36, display: 'flex', alignItems: 'center', padding: '0 17px', borderBottom: hairline, fontSize: 12, fontWeight: 600}}>Timeline<span style={{marginLeft: 'auto', fontSize: 10, color: '#73778b', fontWeight: 400}}>Build steps</span></div>
              <div style={{padding: '16px 24px 0'}}>
                <div style={{display: 'flex', gap: 10, alignItems: 'center', fontSize: 12}}><span style={{fontWeight: 600}}>Run #3</span><span style={{fontSize: 10, padding: '2px 7px', borderRadius: 4, color: liveActive ? mint : '#9699ad', background: liveActive ? '#23372f' : '#242636', border: liveActive ? '1px solid #304e40' : hairline}}>{liveActive ? 'Live' : 'Run'}</span><span style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: showProblem ? '#e692a6' : finished ? '#a8c9b5' : '#a0a2b5'}}><Dot size={5} color={showProblem ? '#e692a6' : finished ? mint : lavender}/>{showProblem ? 'Build failed' : finished ? 'App running' : building && actionFrame < 50 ? actionFrame < 36 ? 'Ready to run' : 'Starting' : 'In progress'}</span></div>
                <div style={{position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(8,minmax(0,1fr))', marginTop: 23}}>
                  <div style={{position: 'absolute', left: '6.25%', right: '6.25%', height: 1, top: 13, background: '#383849'}}/>
                  <div style={{position: 'absolute', left: '6.25%', width: `${Math.min(87.5, Math.max(0, (completed - 1) * 12.5))}%`, height: 1, top: 13, background: '#729780'}}/>
                  {phases.map((name, i) => {
                    const done = i < completed;
                    const active = i === completed && (!building || actionFrame >= 50);
                    const failed = showProblem && i === 4;
                    return <div key={name} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, position: 'relative'}}>
                      <div style={{width: 26, height: 26, boxSizing: 'border-box', borderRadius: '50%', border: `1px solid ${failed ? '#bd6b7d' : done ? '#587965' : active ? '#9683c9' : '#3f4153'}`, color: failed ? '#efadbc' : done ? '#b8e0c8' : active ? lavender : '#6d6e85', background: failed ? '#432a35' : done ? '#263b31' : '#171926', display: 'grid', placeItems: 'center', boxShadow: active && !failed ? `0 0 ${9 + pulse * 8}px #bba4ff22` : undefined}}>{failed ? <span style={{fontSize: 18, lineHeight: 1}}>×</span> : done ? <Glyph name="check" size={13}/> : active ? <span style={{width: 7, height: 7, borderRadius: '50%', background: lavender, opacity: .55 + pulse * .45}}/> : <span style={{width: 5, height: 5, borderRadius: '50%', border: '1px solid #4f5266'}}/>}</div>
                      <span style={{fontSize: 11.5, color: failed ? '#e99eaf' : done ? '#dedee9' : active ? '#d0c3f3' : '#72778d', whiteSpace: 'nowrap'}}>{name}</span>
                      <span style={{fontSize: 9.5, color: failed ? '#c88495' : '#72788d'}}>{failed ? 'failed' : done ? phaseDetails[i] : active ? 'in progress' : ''}</span>
                    </div>;
                  })}
                </div>
              </div>
            </div>

            <div style={{height: 344}}>
              <div style={{height: 36, borderBottom: hairline, display: 'flex', alignItems: 'center', gap: 23, padding: '0 17px', boxSizing: 'border-box'}}>
                <div style={{height: '100%', display: 'flex', alignItems: 'center', fontSize: 12, fontWeight: showProblem ? 400 : 600, color: showProblem ? '#9698ad' : '#f3f2f8', position: 'relative'}}>Console{!showProblem && <span style={{position: 'absolute', left: 2, right: 2, bottom: 0, height: 2, background: lavender, borderRadius: 2}}/>}</div>
                <span style={{height: '100%', display: 'flex', alignItems: 'center', position: 'relative', fontSize: 12, color: showProblem ? '#f3f2f8' : '#9698ad', fontWeight: showProblem ? 600 : 400}}>Problems<span style={{fontSize: 9, color: showProblem ? '#e696a7' : '#68758a', marginLeft: 7}}>{showProblem ? '1' : '0'}</span>{showProblem && <span style={{position: 'absolute', left: 2, right: 2, bottom: 0, height: 2, background: lavender, borderRadius: 2}}/>}</span>
                <span style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: showProblem ? '#d88e9e' : '#809184', fontSize: 10}}>{!showProblem && <Glyph name="check" size={12}/>} {showProblem ? '1 error' : 'No errors'}</span>
              </div>
              {showProblem ? <ProblemPanel frame={actionFrame}/> : <>
              <div style={{height: 40, display: 'flex', alignItems: 'center', gap: 7, padding: '0 13px', borderBottom: hairline, background: '#1b1d2a', fontSize: 10.5, boxSizing: 'border-box'}}>
                {[['JS','#9dc7ff'],['Capacitor',lavender],['Native','#b4b5c0'],['Bridge','#788ca6'],['Dev server','#91ded8'],['CapMac','#93b8ff']].map(([name,color]) => <span key={name} style={{height: 22, display: 'flex', alignItems: 'center', gap: 5, padding: '0 7px', border: consoleFocused && name === 'JS' && actionFrame >= 40 ? '1px solid #6e94ca' : hairline, background: consoleFocused && name === 'JS' && actionFrame >= 40 ? '#28416a' : '#242636', borderRadius: 12, color: consoleFocused && name === 'JS' && actionFrame >= 40 ? '#d2e3ff' : '#c2c2d0'}}><Dot color={color} size={4}/>{name}</span>)}
                <span style={{marginLeft: 'auto', color: '#8d90a6'}}>All levels ⌄</span>
                <div style={{height: 24, width: 95, padding: '0 7px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 5, border: hairline, borderRadius: 4, color: '#74798d', background: '#131522'}}><Glyph name="search" size={11}/>Find</div>
              </div>

              <div style={{paddingTop: 8, height: 245, overflow: 'hidden', background: '#151724', boxSizing: 'border-box'}}>
                {rows.map((row, i) => {
                  const hot = row === logRows[7];
                  const object = consoleFocused && row === logRows[4];
                  const since = building ? actionFrame - arrivalFrames[logRows.indexOf(row)] : hot && mode === 'live' ? actionFrame - 90 : mode ? 12 : frame - (i - 3) * 19;
                  return <div key={row.text} style={{display: 'flex', alignItems: object ? 'flex-start' : 'center', gap: 12, minHeight: 29, fontFamily: monoFont, padding: '0 16px', borderLeft: hot ? '2px solid #a8cbb7' : object && actionFrame >= 80 ? '2px solid #6889b9' : '2px solid transparent', background: hot ? '#203229' : object && actionFrame >= 80 ? '#1b2030' : 'transparent', opacity: interpolate(since, [0, 10], [mode ? .25 : i < 3 ? 1 : .15, 1], clamp), boxSizing: 'border-box', fontSize: 11.5, whiteSpace: 'nowrap'}}>
                    <span style={{fontSize: 10, color: '#656b83', paddingTop: object ? 8 : 0}}>{row.at}</span><span style={{width: 29, flexShrink: 0, fontSize: 10, fontWeight: 700, color: row.color, paddingTop: object ? 8 : 0}}>{row.source}</span>{object ? <JsonLog expanded={actionFrame >= 80}/> : <span style={{color: hot ? '#c5e4cf' : '#d1d2df'}}>{row.text}</span>}
                  </div>;
                })}
                <div style={{padding: '10px 18px', fontFamily: monoFont, color: '#515770', fontSize: 11}}><span style={{color: '#8878b4'}}>›</span><span style={{marginLeft: 8, opacity: frame % 30 < 20 ? .9 : .2}}>▍</span></div>
              </div>
              <div style={{height: 23, padding: '0 16px', display: 'flex', alignItems: 'center', fontSize: 9.5, color: '#656b81', borderTop: hairline}}><span>Unified JavaScript + native output</span><span style={{marginLeft: 'auto'}}>Following output ↓</span></div>
              </>}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>;
}
