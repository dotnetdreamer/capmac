import React, {type CSSProperties, type ReactNode} from 'react';
import {interpolate} from 'remotion';
import {Sheen} from './Motion';

/** Orbit (Capacitor), Bloom (Flutter) and Pulse (React Native) are fictional demo apps, drawn at a fixed 300 × 600 */
const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
const appFont = '"IBM Plex Sans", "Segoe UI", sans-serif';

type GlyphName = 'home' | 'settings' | 'chart' | 'card' | 'arrow' | 'leaf' | 'drop' | 'plus' | 'grid' | 'calendar' | 'run' | 'person' | 'flame';
export function AppGlyph({name, size = 20, color = 'currentColor', style}: {name: GlyphName; size?: number; color?: string; style?: CSSProperties}) {
  const paths: Record<GlyphName, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11h5v-6h3v6h5V9"/></>,
    settings: <><path d="m9.5 3-1 2.5-2.6.5-1.4 2.4.9 2.5-1.8 2 .7 2.7 2.6.7 1 2.5h3l1-2.5 2.6-.7.7-2.7-1.8-2 .9-2.5L16.9 6l-2.6-.5-1-2.5z" transform="translate(1 0)"/><circle cx="12" cy="11" r="3"/></>,
    chart: <path d="M4 20V4m0 16h16M8 15l4-5 4 2 5-7"/>,
    card: <><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20m-16 5h4"/></>,
    arrow: <path d="M5 19 19 5m-9 0h9v9"/>,
    leaf: <><path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15z"/><path d="M5 19 13 11"/></>,
    drop: <path d="M12 3c3.5 4.4 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 2.5-6.6 6-11z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    grid: <><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></>,
    calendar: <><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4m6-4v4"/></>,
    run: <><circle cx="14" cy="4.5" r="1.8"/><path d="m8 21 3-6 3 2v5m-6-11 3-3 3 1 2 3 3 1M6 13l2-3"/></>,
    person: <><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></>,
    flame: <path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2.4 1.2-3.8 2.4-5 .2 1.6 1 2.6 2.1 3C11 8.5 11 5.5 12 3z"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{display: 'block', flexShrink: 0, ...style}}>{paths[name]}</svg>;
}

export function OrbitMark({size = 30, color = '#f7f4ee'}: {size?: number; color?: string}) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none"><ellipse cx="20" cy="20" rx="12" ry="12" stroke={color} strokeWidth="2.5"/><ellipse cx="20" cy="20" rx="18" ry="6" transform="rotate(-38 20 20)" stroke={color} strokeWidth="2"/><circle cx="30" cy="10" r="3" fill={color}/></svg>;
}

/** Each app's icon, as an OS shows it in a list */
export function AppIcon({app, size = 20}: {app: 'orbit' | 'bloom' | 'pulse'; size?: number}) {
  const tile: CSSProperties = {width: size, height: size, borderRadius: size * .26, display: 'grid', placeItems: 'center', flexShrink: 0};
  if (app === 'orbit') return <span style={{...tile, background: '#baa8e9'}}><OrbitMark size={size * .84} color="#483362"/></span>;
  if (app === 'bloom') return <span style={{...tile, background: '#bfe3ae'}}><AppGlyph name="leaf" size={size * .66} color="#24502b"/></span>;
  return <span style={{...tile, background: '#191c25', boxShadow: 'inset 0 0 0 1px #ffffff1c'}}><svg width={size * .7} height={size * .7} viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="#2c3140" strokeWidth="3.4"/><circle cx="12" cy="12" r="8" fill="none" stroke="#ff7a5c" strokeWidth="3.4" strokeDasharray="41 60" strokeLinecap="round" transform="rotate(-90 12 12)"/></svg></span>;
}

/**
 * A phone at 300 × 600. The hardware look is a real iPhone; the outline look is the device frame
 * CapMac draws around a simulator's screen in VS Code.
 */
export function Handset({scale = 1, dark = false, outline = false, screen = '#f5f3ed', time = '9:41', sheen, children}: {scale?: number; dark?: boolean; outline?: boolean; screen?: string; time?: string; sheen?: {frame: number; at: number}; children?: ReactNode}) {
  const ink = dark ? '#f2f3f7' : '#262630';
  return <div style={{position: 'relative', width: 300, height: 600, flexShrink: 0, transform: `scale(${scale})`, transformOrigin: 'top left', borderRadius: 47, fontFamily: appFont, color: dark ? '#eef0f5' : '#282830', ...(outline
    ? {background: '#0b0b0d', boxShadow: '0 0 0 1.5px #3b3b40, 0 24px 60px rgba(0,0,0,.45)'}
    : {background: 'linear-gradient(150deg,#4b4b51 0%,#17181c 23%,#08090b 50%,#414146 100%)', boxShadow: '0 28px 65px rgba(0,0,0,.42), inset 0 0 0 1.5px rgba(255,255,255,.24), inset 0 0 0 4px #16171b'})}}>
    {!outline && <>
      <div style={{position: 'absolute', left: -2, top: 116, width: 3, height: 25, borderRadius: '2px 0 0 2px', background: '#424249'}}/>
      <div style={{position: 'absolute', left: -2, top: 159, width: 3, height: 45, borderRadius: '2px 0 0 2px', background: '#424249'}}/>
      <div style={{position: 'absolute', left: -2, top: 213, width: 3, height: 45, borderRadius: '2px 0 0 2px', background: '#424249'}}/>
      <div style={{position: 'absolute', right: -2, top: 176, width: 3, height: 61, borderRadius: '0 2px 2px 0', background: '#424249'}}/>
    </>}
    <div style={{position: 'absolute', inset: 9, overflow: 'hidden', borderRadius: 38, background: screen, boxShadow: 'inset 0 0 0 1px #000'}}>
      {children}
      <div style={{position: 'absolute', top: 15, left: 23, fontSize: 12, fontWeight: 800, letterSpacing: '-.2px', color: ink}}>{time}</div>
      <div style={{position: 'absolute', left: 90, top: 10, width: 101, height: 27, borderRadius: 20, background: '#0a0a0c', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 9, boxSizing: 'border-box'}}><div style={{width: 7, height: 7, borderRadius: '50%', background: 'radial-gradient(circle at 36% 35%,#29304b,#0e1019 58%)'}}/></div>
      <svg width="48" height="14" viewBox="0 0 48 14" style={{position: 'absolute', right: 21, top: 18}}><path d="M1 11V9h2v2zm4 0V6h2v5zm4 0V4h2v7zm4 0V2h2v9z" fill={ink}/><path d="M19 5c3-3 7-3 10 0M21 7c2-2 4-2 6 0" fill="none" stroke={ink} strokeWidth="1.5" strokeLinecap="round"/><circle cx="24" cy="10" r="1.25" fill={ink}/><rect x="33" y="3" width="12" height="8" rx="2" fill="none" stroke={ink} strokeWidth="1"/><rect x="35" y="5" width="8" height="4" rx=".5" fill={ink}/><path d="M47 5v4" stroke={ink}/></svg>
      <div style={{position: 'absolute', left: 101, bottom: 7, width: 81, height: 3.5, borderRadius: 10, background: dark ? '#e9eaf0' : '#26242b'}}/>
      {sheen && <Sheen frame={sheen.frame} at={sheen.at} radius={38}/>}
    </div>
    {!outline && <div style={{position: 'absolute', inset: 5, borderRadius: 42, border: '1px solid rgba(255,255,255,.10)', pointerEvents: 'none'}}/>}
  </div>;
}

/** Orbit, a savings app made with Capacitor and Ionic */
export function OrbitScreen({frame = 0, variant = 'violet', view = 'home', tapFrame = 0}: {frame?: number; variant?: 'violet' | 'mint'; view?: 'home' | 'activity'; tapFrame?: number}) {
  const isMint = variant === 'mint';
  const accent = isMint ? '#a1ddbd' : '#c5b5ec';
  const accentDeep = isMint ? '#265345' : '#58407e';
  const ring = interpolate(frame, [0, 65], [0.56, 0.64], clamp);
  const chartGrowth = interpolate(frame, [0, 50], [0.82, 1], clamp);
  const barHeights = [14, 25, 20, 31, 40, 33, 50, 41, 55, 47, 62, 70];
  const activityEntrance = interpolate(tapFrame, [0, 14], [0, 1], clamp);
  return <>
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
        <div style={{width: 31, height: 31, borderRadius: 10, background: '#ece6f6', display: 'grid', placeItems: 'center', color: '#695789'}}><AppGlyph name="card" size={16}/></div>
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
      {[{icon: 'card' as const, title: 'Coffee & company', detail: 'Today · Card payment', amount: '−$6.50'}, {icon: 'arrow' as const, title: 'Weekend escape', detail: 'Yesterday · Savings transfer', amount: '+$40.00'}].map((item, i) => <div key={item.title} style={{display: 'flex', alignItems: 'center', gap: 9, padding: '13px 0', borderBottom: i === 0 ? '1px solid #e8e4dd' : undefined}}><div style={{width: 30, height: 30, borderRadius: 10, background: i === 0 ? '#ece6f6' : '#e3eee5', display: 'grid', placeItems: 'center', color: i === 0 ? '#695789' : '#477357'}}><AppGlyph name={item.icon} size={15}/></div><div style={{fontSize: 9, fontWeight: 700}}>{item.title}<div style={{fontSize: 7, color: '#97909d', fontWeight: 500, marginTop: 4}}>{item.detail}</div></div><span style={{marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: i === 0 ? '#282830' : '#477357'}}>{item.amount}</span></div>)}
    </div>}

    <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 62, background: '#fffefa', borderTop: '1px solid #e8e5df', display: 'flex', padding: '10px 27px 0', justifyContent: 'space-between', boxSizing: 'border-box'}}>
      {(['home', 'chart', 'card', 'settings'] as const).map((name, i) => <div key={name} style={{position: 'relative', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center', color: i === (view === 'activity' ? 1 : 0) ? accentDeep : '#afa8b2'}}>{view === 'activity' && i === 1 && <span style={{position: 'absolute', inset: '-5px -11px', background: accent, opacity: .3, borderRadius: 12}}/>}<AppGlyph name={name} size={18}/><span style={{position: 'relative', fontSize: 6.5, fontWeight: 700}}>{['Home', 'Activity', 'Cards', 'You'][i]}</span></div>)}
    </div>
  </>;
}

/** A simulator's home screen, before an app opens */
export function HomeScreen() {
  const tiles = ['#ff9f5a', '#5ac8fa', '#34c759', '#ffcc00', '#af52de', '#ff375f', '#64d2ff', '#30d158', '#bf5af2', '#ff9f0a', '#0a84ff', '#5e5ce6'];
  return <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(160deg,#6f8dff 0%,#9c7cf0 45%,#f19bc0 100%)'}}>
    <div style={{position: 'absolute', top: 64, left: 22, right: 22, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', rowGap: 22, columnGap: 18}}>
      {tiles.map(color => <div key={color} style={{aspectRatio: '1', borderRadius: 13, background: `linear-gradient(160deg, ${color}, ${color}cc)`, boxShadow: '0 2px 6px rgba(0,0,0,.15)'}}/>)}
    </div>
    <div style={{position: 'absolute', left: 14, right: 14, bottom: 14, height: 76, borderRadius: 30, background: 'rgba(255,255,255,.28)', backdropFilter: 'blur(8px)', display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '0 12px'}}>
      {['#34c759', '#0a84ff', '#ff9f0a', '#5e5ce6'].map(color => <div key={color} style={{width: 50, height: 50, borderRadius: 13, background: color}}/>)}
    </div>
  </div>;
}

/** The Orbit app on an iPhone, as it was drawn for the first film */
export function Phone({frame = 0, variant = 'violet', scale = 1, view = 'home', tapFrame = 0, outline = false, sheen}: {frame?: number; variant?: 'violet' | 'mint'; scale?: number; view?: 'home' | 'activity'; tapFrame?: number; outline?: boolean; sheen?: {frame: number; at: number}}) {
  return <Handset scale={scale} outline={outline} sheen={sheen}><OrbitScreen frame={frame} variant={variant} view={view} tapFrame={tapFrame}/></Handset>;
}

/** Hot reload changes the greeting; the count of watered plants is state, so it stays */
export const BLOOM_GREETING = ['Good morning', 'Good morning, Sam'] as const;

/** Bloom, a plant care app made with Flutter */
export function BloomScreen({frame = 0, reloaded = false, flash = -1}: {frame?: number; reloaded?: boolean; flash?: number}) {
  const ring = interpolate(frame, [0, 50], [0.52, 0.6], clamp);
  const highlight = flash >= 0 ? interpolate(flash, [0, 4, 30], [0, 1, 0], clamp) : 0;
  const plants = [
    {name: 'Monstera', detail: 'Living room · every 7 days', when: 'Today', tint: '#dcefd2', warm: true},
    {name: 'Fiddle leaf fig', detail: 'Bedroom · every 10 days', when: 'In 2 days', tint: '#e8f0d6', warm: false},
    {name: 'Snake plant', detail: 'Office · every 14 days', when: 'In 5 days', tint: '#d9ece6', warm: false},
  ];
  return <>
    <div style={{position: 'absolute', top: 52, left: 18, right: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8}}><span style={{width: 28, height: 28, borderRadius: 9, background: '#cfe8c4', display: 'grid', placeItems: 'center'}}><AppGlyph name="leaf" size={17} color="#2c5a31"/></span><span style={{fontSize: 20, fontWeight: 700, letterSpacing: '-.6px', color: '#1b2a1c'}}>Bloom</span></div>
      <div style={{width: 28, height: 28, borderRadius: '50%', background: '#f0d9b5', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: '#6d5233'}}>S</div>
    </div>
    <div style={{position: 'absolute', top: 96, left: 18, right: 18}}>
      <div style={{display: 'inline-block', fontSize: 23, fontWeight: 700, letterSpacing: '-.7px', color: '#16241a', borderRadius: 6, padding: '0 4px', margin: '0 -4px', background: `rgba(255,214,102,${highlight * .55})`}}>{reloaded ? BLOOM_GREETING[1] : BLOOM_GREETING[0]}</div>
      <div style={{fontSize: 11, color: '#5c6c5d', marginTop: 5}}>2 plants need water today</div>
    </div>
    <div style={{position: 'absolute', top: 160, left: 16, right: 16, height: 126, borderRadius: 24, background: '#cfe9c2', padding: '18px 18px', boxSizing: 'border-box', overflow: 'hidden'}}>
      <div style={{fontSize: 10.5, fontWeight: 700, color: '#2e5130'}}>Watering today</div>
      <div style={{fontSize: 30, fontWeight: 800, letterSpacing: '-1.2px', color: '#132415', marginTop: 9}}>3 <span style={{fontSize: 15, fontWeight: 600}}>of 5</span></div>
      <div style={{fontSize: 10, color: '#3c5d3e', marginTop: 4}}>plants watered</div>
      <div style={{position: 'absolute', right: 16, top: 24, width: 78, height: 78}}>
        <svg width="78" height="78" viewBox="0 0 78 78"><circle cx="39" cy="39" r="31" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="7"/><circle cx="39" cy="39" r="31" fill="none" stroke="#2f6a3a" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 31}`} strokeDashoffset={2 * Math.PI * 31 * (1 - ring)} transform="rotate(-90 39 39)"/></svg>
        <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center'}}><AppGlyph name="drop" size={22} color="#2f6a3a"/></div>
      </div>
    </div>
    <div style={{position: 'absolute', top: 302, left: 20, right: 20, display: 'flex', justifyContent: 'space-between', fontSize: 11.5, fontWeight: 700, color: '#1b2a1c'}}>Your plants<span style={{fontSize: 9, fontWeight: 600, color: '#3f7a47'}}>See all</span></div>
    {plants.map((plant, i) => <div key={plant.name} style={{position: 'absolute', top: 326 + i * 54, left: 16, right: 16, height: 48, display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px', borderRadius: 14, background: i === 0 ? '#ffffff' : 'transparent'}}>
      <span style={{width: 34, height: 34, borderRadius: 17, background: plant.tint, display: 'grid', placeItems: 'center'}}><AppGlyph name="leaf" size={17} color="#3c7a45"/></span>
      <div style={{fontSize: 11, fontWeight: 700, color: '#1b2a1c'}}>{plant.name}<div style={{fontSize: 8.5, fontWeight: 500, color: '#6a7a6b', marginTop: 3}}>{plant.detail}</div></div>
      <span style={{marginLeft: 'auto', fontSize: 8.5, fontWeight: 700, padding: '4px 8px', borderRadius: 8, background: plant.warm ? '#fde3c0' : '#e3eedc', color: plant.warm ? '#8a5517' : '#46704b'}}>{plant.when}</span>
    </div>)}
    <div style={{position: 'absolute', right: 18, bottom: 80, width: 52, height: 52, borderRadius: 17, background: '#9fd78b', display: 'grid', placeItems: 'center', boxShadow: '0 6px 14px rgba(43,90,48,.28)'}}><AppGlyph name="plus" size={22} color="#173a1c"/></div>
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 66, background: '#e8f0e2', display: 'flex', justifyContent: 'space-around', alignItems: 'flex-start', paddingTop: 9, boxSizing: 'border-box'}}>
      {(['home', 'grid', 'settings'] as const).map((name, i) => <div key={name} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: i === 0 ? '#173a1c' : '#5d6b5e'}}>
        <span style={{width: 52, height: 26, borderRadius: 13, display: 'grid', placeItems: 'center', background: i === 0 ? '#c3e3b3' : 'transparent'}}><AppGlyph name={name} size={17}/></span>
        <span style={{fontSize: 8, fontWeight: 700}}>{['Today', 'Plants', 'Settings'][i]}</span>
      </div>)}
    </div>
  </>;
}

export function BloomPhone({frame = 0, scale = 1, reloaded = false, flash = -1, outline = false, sheen}: {frame?: number; scale?: number; reloaded?: boolean; flash?: number; outline?: boolean; sheen?: {frame: number; at: number}}) {
  return <Handset scale={scale} outline={outline} screen="#f3f8ef" sheen={sheen}><BloomScreen frame={frame} reloaded={reloaded} flash={flash}/></Handset>;
}

/** Fast Refresh swaps the accent color the app is built around */
export const PULSE_ACCENT = ['#ff7a5c', '#6fe3a6'] as const;

/** Pulse, an activity app made with React Native */
export function PulseScreen({frame = 0, refreshed = false}: {frame?: number; refreshed?: boolean}) {
  const accent = refreshed ? PULSE_ACCENT[1] : PULSE_ACCENT[0];
  const progress = interpolate(frame, [0, 55], [0.7, 0.82], clamp);
  const bars = [44, 62, 38, 70, 56, 30, 82];
  return <>
    <div style={{position: 'absolute', top: 50, left: 20, right: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
      <div><div style={{fontSize: 9, fontWeight: 700, letterSpacing: 1.3, color: '#7d8396'}}>THURSDAY</div><div style={{fontSize: 22, fontWeight: 800, letterSpacing: '-.8px', color: '#f4f5f9', marginTop: 2}}>Pulse</div></div>
      <div style={{width: 30, height: 30, borderRadius: '50%', background: `linear-gradient(135deg, ${accent}, #8c6cff)`, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, color: '#101218'}}>M</div>
    </div>
    <div style={{position: 'absolute', top: 106, left: (282 - 176) / 2, width: 176, height: 176}}>
      <svg width="176" height="176" viewBox="0 0 176 176"><circle cx="88" cy="88" r="74" fill="none" stroke="#1f2330" strokeWidth="15"/><circle cx="88" cy="88" r="74" fill="none" stroke={accent} strokeWidth="15" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 74}`} strokeDashoffset={2 * Math.PI * 74 * (1 - progress)} transform="rotate(-90 88 88)" style={{filter: `drop-shadow(0 0 10px ${accent}66)`}}/></svg>
      <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'}}>
        <AppGlyph name="flame" size={18} color={accent}/>
        <div style={{fontSize: 30, fontWeight: 800, letterSpacing: '-1.2px', color: '#f6f7fb', marginTop: 4}}>{Math.round(progress * 10017).toLocaleString('en-US')}</div>
        <div style={{fontSize: 9.5, color: '#8b91a3', marginTop: 2}}>steps of 10,000</div>
      </div>
    </div>
    <div style={{position: 'absolute', top: 300, left: 16, right: 16, display: 'flex', gap: 8}}>
      {[['5.2', 'km', 'Distance'], ['412', 'kcal', 'Energy'], ['46', 'min', 'Active']].map(([value, unit, label]) => <div key={label} style={{flex: 1, height: 64, borderRadius: 14, background: '#171a23', border: '1px solid #232838', padding: '10px 10px', boxSizing: 'border-box'}}>
        <div style={{fontSize: 16, fontWeight: 800, color: '#f2f3f8', letterSpacing: '-.4px'}}>{value}<span style={{fontSize: 9, fontWeight: 600, color: '#9298aa', marginLeft: 3}}>{unit}</span></div>
        <div style={{fontSize: 8.5, color: '#7f8597', marginTop: 5}}>{label}</div>
      </div>)}
    </div>
    <div style={{position: 'absolute', top: 378, left: 16, right: 16, height: 116, borderRadius: 16, background: '#171a23', border: '1px solid #232838', padding: '12px 14px', boxSizing: 'border-box'}}>
      <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 700, color: '#e9ebf2'}}>This week<span style={{fontSize: 8.5, fontWeight: 600, color: '#7f8597'}}>Avg 7,940</span></div>
      <div style={{display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 62, marginTop: 10}}>{bars.map((height, i) => <div key={i} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5}}><div style={{width: 16, height: height * .7, borderRadius: 5, background: i === 6 ? accent : '#2a2f3d'}}/><span style={{fontSize: 7, color: '#6f7587', fontWeight: 600}}>{'MTWTFSS'[i]}</span></div>)}</div>
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 62, background: '#12141b', borderTop: '1px solid #1e212b', display: 'flex', justifyContent: 'space-around', paddingTop: 10, boxSizing: 'border-box'}}>
      {(['flame', 'run', 'person'] as const).map((name, i) => <div key={name} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, color: i === 0 ? accent : '#6c7285'}}><AppGlyph name={name} size={18}/><span style={{fontSize: 7.5, fontWeight: 700}}>{['Today', 'Workouts', 'Profile'][i]}</span></div>)}
    </div>
  </>;
}

export function PulsePhone({frame = 0, scale = 1, refreshed = false, outline = false, sheen}: {frame?: number; scale?: number; refreshed?: boolean; outline?: boolean; sheen?: {frame: number; at: number}}) {
  return <Handset scale={scale} outline={outline} dark screen="#0f1117" sheen={sheen}><PulseScreen frame={frame} refreshed={refreshed}/></Handset>;
}

/** Bloom's desktop layout: one Flutter code base draws it on the Mac and on Windows */
export function BloomDesktop({width, height, reloaded = false, flash = -1}: {width: number; height: number; reloaded?: boolean; flash?: number}) {
  const highlight = flash >= 0 ? interpolate(flash, [0, 4, 30], [0, 1, 0], clamp) : 0;
  return <div style={{position: 'relative', width, height, display: 'flex', background: '#f4f8f0', fontFamily: appFont, color: '#1b2a1c', overflow: 'hidden'}}>
    <div style={{width: 176, flexShrink: 0, background: '#e7f0e1', padding: '20px 14px', boxSizing: 'border-box'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22}}><span style={{width: 26, height: 26, borderRadius: 8, background: '#cfe8c4', display: 'grid', placeItems: 'center'}}><AppGlyph name="leaf" size={15} color="#2c5a31"/></span><span style={{fontSize: 17, fontWeight: 700, letterSpacing: '-.5px'}}>Bloom</span></div>
      {(['home', 'grid', 'calendar', 'settings'] as const).map((name, i) => <div key={name} style={{display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 10px', borderRadius: 17, marginBottom: 4, fontSize: 12, fontWeight: i === 0 ? 700 : 500, background: i === 0 ? '#c3e3b3' : 'transparent', color: i === 0 ? '#173a1c' : '#4d5c4e'}}><AppGlyph name={name} size={15}/>{['Today', 'Plants', 'Schedule', 'Settings'][i]}</div>)}
    </div>
    <div style={{flex: 1, padding: '24px 26px', boxSizing: 'border-box'}}>
      <div style={{display: 'inline-block', fontSize: 25, fontWeight: 700, letterSpacing: '-.8px', borderRadius: 6, padding: '0 5px', margin: '0 -5px', background: `rgba(255,214,102,${highlight * .55})`}}>{reloaded ? BLOOM_GREETING[1] : BLOOM_GREETING[0]}</div>
      <div style={{fontSize: 12, color: '#5c6c5d', marginTop: 5}}>2 plants need water today</div>
      <div style={{display: 'flex', gap: 14, marginTop: 20}}>
        <div style={{flex: 1.3, height: 128, borderRadius: 20, background: '#cfe9c2', padding: 18, boxSizing: 'border-box', position: 'relative'}}>
          <div style={{fontSize: 11, fontWeight: 700, color: '#2e5130'}}>Watering today</div>
          <div style={{fontSize: 32, fontWeight: 800, letterSpacing: '-1.2px', marginTop: 10}}>3 <span style={{fontSize: 16, fontWeight: 600}}>of 5</span></div>
          <div style={{fontSize: 11, color: '#3c5d3e', marginTop: 3}}>plants watered</div>
          <svg width="74" height="74" viewBox="0 0 78 78" style={{position: 'absolute', right: 18, top: 27}}><circle cx="39" cy="39" r="31" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="7"/><circle cx="39" cy="39" r="31" fill="none" stroke="#2f6a3a" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 31}`} strokeDashoffset={2 * Math.PI * 31 * .4} transform="rotate(-90 39 39)"/></svg>
        </div>
        {['Monstera', 'Fiddle leaf fig'].map((name, i) => <div key={name} style={{flex: 1, height: 128, borderRadius: 20, background: '#ffffff', border: '1px solid #e1eadb', padding: 16, boxSizing: 'border-box'}}>
          <span style={{width: 34, height: 34, borderRadius: 17, background: i ? '#e8f0d6' : '#dcefd2', display: 'grid', placeItems: 'center'}}><AppGlyph name="leaf" size={17} color="#3c7a45"/></span>
          <div style={{fontSize: 12.5, fontWeight: 700, marginTop: 14}}>{name}</div>
          <div style={{fontSize: 10, color: '#6a7a6b', marginTop: 4}}>{i ? 'Water in 2 days' : 'Water today'}</div>
        </div>)}
      </div>
      <div style={{marginTop: 18, height: Math.max(0, height - 290), borderRadius: 18, background: '#ffffff', border: '1px solid #e1eadb', padding: '16px 18px', boxSizing: 'border-box', overflow: 'hidden'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700}}>This week<span style={{fontSize: 10.5, fontWeight: 600, color: '#3f7a47'}}>Schedule</span></div>
        <div style={{display: 'flex', gap: 10, marginTop: 14}}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => <div key={day} style={{flex: 1, height: 74, borderRadius: 14, background: i === 3 ? '#cfe9c2' : '#f2f6ee', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 10.5, fontWeight: 600, color: i === 3 ? '#173a1c' : '#5d6b5e'}}>{day}{[0, 3, 5].includes(i) ? <AppGlyph name="drop" size={15} color="#3c7a45"/> : <span style={{width: 5, height: 5, borderRadius: 3, background: '#c9d6c4'}}/>}</div>)}</div>
      </div>
    </div>
  </div>;
}

/** A Mac window's frame, as the Mac draws it around an app */
export function MacWindow({title, width, height, children, dark = false}: {title: string; width: number; height: number; children: ReactNode; dark?: boolean}) {
  return <div style={{width, height, borderRadius: 11, overflow: 'hidden', boxShadow: '0 30px 70px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.08)', background: dark ? '#1e1e20' : '#f6f6f6'}}>
    <div style={{height: 30, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8, background: dark ? '#2b2b2e' : '#ececec', borderBottom: dark ? '1px solid #000' : '1px solid #d4d4d4', position: 'relative'}}>
      {['#ff5f57', '#febc2e', '#28c840'].map(color => <span key={color} style={{width: 12, height: 12, borderRadius: 6, background: color, boxShadow: 'inset 0 0 0 .5px rgba(0,0,0,.2)'}}/>)}
      <span style={{position: 'absolute', left: 0, right: 0, textAlign: 'center', fontFamily: '"Segoe UI", sans-serif', fontSize: 13, fontWeight: 600, color: dark ? '#d8d8dc' : '#3d3d3f', pointerEvents: 'none'}}>{title}</span>
    </div>
    <div style={{height: height - 30, overflow: 'hidden'}}>{children}</div>
  </div>;
}

/** A Windows 11 window's frame */
export function WinWindow({title, width, height, children, icon}: {title: string; width: number; height: number; children: ReactNode; icon?: ReactNode}) {
  return <div style={{width, height, borderRadius: 8, overflow: 'hidden', boxShadow: '0 32px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(0,0,0,.35)', background: '#f3f3f3'}}>
    <div style={{height: 32, display: 'flex', alignItems: 'center', background: '#eef2ec', fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif', fontSize: 12, color: '#1f1f1f'}}>
      <span style={{display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 12}}>{icon}{title}</span>
      <span style={{marginLeft: 'auto', display: 'flex', height: '100%'}}>
        {['M2 6h8', 'M2.5 2.5h7v7h-7z', 'm2.5 2.5 7 7m0-7-7 7'].map(path => <span key={path} style={{width: 46, display: 'grid', placeItems: 'center'}}><svg width="12" height="12" viewBox="0 0 12 12"><path d={path} fill="none" stroke="#1f1f1f" strokeWidth="1"/></svg></span>)}
      </span>
    </div>
    <div style={{height: height - 32, overflow: 'hidden'}}>{children}</div>
  </div>;
}
