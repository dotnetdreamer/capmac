import React, {type CSSProperties, type ReactNode} from 'react';
import {Img, interpolate, staticFile} from 'remotion';

const C = {bg: '#1c1f28', surface: '#242833', text: '#f4f3ef', dim: '#a5aab8', violet: '#bcaafa', mint: '#9bd7bc', line: '#ffffff13'};
const body = '"IBM Plex Sans", sans-serif';
const mono = '"JetBrains Mono", monospace';
const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
const ramp = (frame: number, from: number, to: number) => interpolate(frame, [from, to], [0, 1], clamp);
const shell: CSSProperties = {position: 'relative', width: 1440, height: 690, boxSizing: 'border-box', overflow: 'hidden', borderRadius: 13, border: '1px solid #ffffff30', background: C.bg, boxShadow: '0 38px 100px #00000065, 0 2px 12px #0003', fontFamily: body, color: C.text};

type GlyphName = 'globe' | 'settings' | 'mac' | 'search' | 'key' | 'user' | 'wifi' | 'chevron' | 'home';
function Glyph({name, size = 22, color = 'currentColor'}: {name: GlyphName; size?: number; color?: string}) {
  const paths: Record<GlyphName, ReactNode> = {
    globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/></>,
    settings: <><path d="m10 3-1 3-3 1-2 3 1 3-1 3 2 3 3 1 1 3h4l1-3 3-1 2-3-1-3 1-3-2-3-3-1-1-3z" transform="translate(0 -1) scale(1 .95)"/><circle cx="12" cy="12" r="3"/></>,
    mac: <><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6m-3-4v4"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    key: <><circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-3-3 2-2m-5-1 2-2"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
    wifi: <><path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r=".8" fill={color}/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    home: <><path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{display: 'block', flexShrink: 0}}>{paths[name]}</svg>;
}

function Switch({on, progress = on ? 1 : 0, mac = false}: {on: boolean; progress?: number; mac?: boolean}) {
  const width = mac ? 58 : 58;
  return <div style={{width, height: 31, borderRadius: 20, background: on ? mac ? '#357cf1' : C.violet : '#5f6470', boxShadow: 'inset 0 0 0 1px #ffffff10', position: 'relative', flexShrink: 0}}>
    <div style={{position: 'absolute', left: 3 + progress * 27, top: 3, width: 25, height: 25, borderRadius: 25, background: '#fff', boxShadow: '0 1px 4px #0005'}}/>
  </div>;
}

function Radio({selected}: {selected: boolean}) {
  return <span style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 19, height: 19, borderRadius: 20, border: '1.5px solid ' + (selected ? C.violet : '#777e90'), background: selected ? '#bcaafa16' : undefined, flexShrink: 0}}>{selected && <span style={{width: 9, height: 9, borderRadius: 10, background: C.violet}}/>}</span>;
}

function WindowsTitlebar({title, terminal = false}: {title: string; terminal?: boolean}) {
  return <div style={{height: 49, display: 'flex', alignItems: 'center', padding: '0 21px', boxSizing: 'border-box', borderBottom: '1px solid #ffffff10', background: '#232630', color: '#b8bdc8', fontSize: 18}}>
    {terminal ? <span style={{fontFamily: mono, fontSize: 23, color: C.violet, marginRight: 15}}>&gt;_</span> : <Img src={staticFile('capmac-icon.svg')} style={{width: 23, height: 23, marginRight: 13}}/>}
    <span>{title}</span>
    <div style={{display: 'flex', gap: 30, marginLeft: 'auto', alignItems: 'center'}}>
      <svg width="13" height="14"><path d="M1 8h11" stroke="currentColor"/></svg>
      <svg width="13" height="14"><rect x="2" y="3" width="9" height="9" fill="none" stroke="currentColor"/></svg>
      <svg width="13" height="14"><path d="m2 3 9 9m0-9-9 9" stroke="currentColor"/></svg>
    </div>
  </div>;
}

/** Local coordinates stay stable so the camera follows an action rather than a layout change */
export const REMOTE_TARGETS = {
  loginToggle: {x: 1310, y: 179, at: 32},
  loginUser: {x: 842, y: 446, at: 65},
  pairingRows: [{x: 790, y: 195, at: 0}, {x: 790, y: 340, at: 40}, {x: 790, y: 485, at: 80}],
  remoteToggle: {x: 1310, y: 234, at: 30},
  connectionSelect: {x: 1204, y: 305, at: 60},
  internetOption: {x: 1194, y: 452, at: 85},
  keepAwake: {x: 1310, y: 379, at: 135},
  relaySelect: {x: 1204, y: 446, at: 155},
} as const;

export function MacRemoteLoginWindow({frame}: {frame: number}) {
  const on = frame >= 32;
  const toggleProgress = ramp(frame, 32, 38);
  const sideItems: {name: string; icon: GlyphName; color: string}[] = [
    {name: 'Wi Fi', icon: 'wifi', color: '#297ceb'},
    {name: 'Network', icon: 'globe', color: '#3479d9'},
    {name: 'General', icon: 'settings', color: '#7c7e83'},
    {name: 'Appearance', icon: 'home', color: '#5d6582'},
    {name: 'Accessibility', icon: 'user', color: '#3175cb'},
    {name: 'Privacy & Security', icon: 'key', color: '#7c828e'},
  ];
  return <div style={{...shell, background: '#202126'}}>
    <div style={{position: 'absolute', inset: '0 auto 0 0', width: 284, borderRight: '1px solid #ffffff14', background: 'linear-gradient(130deg,#2a2b32,#24262d)'}}>
      <div style={{display: 'flex', gap: 9, padding: '19px 20px'}}>{['#ed6b62', '#ecbe50', '#61c353'].map(color => <span key={color} style={{width: 13, height: 13, borderRadius: 13, background: color, boxShadow: 'inset 0 0 0 1px #0003'}}/>)}</div>
      <div style={{margin: '11px 18px 20px', borderRadius: 6, height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 11px', color: '#9b9da7', background: '#ffffff08', border: '1px solid #ffffff0c', fontSize: 17}}><Glyph name="search" size={16}/>Search</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '0 22px 23px'}}><div style={{background: '#8a7d6c', width: 48, height: 48, borderRadius: 50, display: 'grid', placeItems: 'center', fontSize: 20, fontWeight: 600}}>D</div><div style={{fontSize: 19, fontWeight: 500}}>Developer<div style={{fontSize: 13, color: '#a4a7b1', marginTop: 3}}>Apple Account</div></div></div>
      {sideItems.map(item => <div key={item.name} style={{height: 47, margin: '3px 11px', padding: '0 12px', display: 'flex', alignItems: 'center', gap: 11, fontSize: 18, borderRadius: 7, background: item.name === 'General' ? '#ffffff14' : undefined}}><div style={{width: 28, height: 28, borderRadius: 6, background: item.color, display: 'grid', placeItems: 'center'}}><Glyph name={item.icon} size={20}/></div>{item.name}</div>)}
      <div style={{position: 'absolute', left: 24, bottom: 25, color: '#818591', fontSize: 14}}>System Settings</div>
    </div>
    <div style={{position: 'absolute', left: 314, right: 37, top: 25, height: 43, display: 'flex', alignItems: 'center', gap: 19, fontSize: 19, color: '#aaaeb8'}}><span style={{fontSize: 30, color: '#d8dbe2'}}>‹</span><span>General</span><span style={{color: '#606671'}}>›</span><span>Sharing</span></div>
    <div style={{position: 'absolute', left: 325, top: 87, display: 'flex', alignItems: 'center', gap: 14}}><div style={{width: 42, height: 42, borderRadius: 10, background: '#3779d5', display: 'grid', placeItems: 'center'}}><Glyph name="mac" size={28}/></div><span style={{fontSize: 31, fontWeight: 600, letterSpacing: '-.7px'}}>Remote Login</span></div>
    <div style={{position: 'absolute', left: 325, top: 145, width: 1063, border: '1px solid #ffffff14', borderRadius: 10, background: '#2b2d35', boxSizing: 'border-box', height: 113, padding: '18px 23px'}}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 23}}><span style={{fontSize: 23, fontWeight: 500}}>Remote Login</span><Switch on={on} progress={toggleProgress} mac/></div>
      <div style={{fontSize: 18, color: on ? '#b1cbbd' : '#a7acb6', marginTop: 14}}>{on ? 'Remote Login is on' : 'Remote Login is off'}<span style={{color: '#a7acb6', marginLeft: 27}}>Allow access through SSH</span></div>
    </div>
    <div style={{position: 'absolute', left: 325, top: 281, width: 1063, height: 244, borderRadius: 10, border: '1px solid #ffffff13', background: '#2b2d35', padding: '22px 26px', boxSizing: 'border-box'}}>
      <div style={{fontSize: 22, fontWeight: 500}}>Allow access for</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, fontSize: 19, color: '#b4b8c3'}}><Radio selected={false}/>All users</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, fontSize: 19}}><Radio selected/>Only these users</div>
      <div style={{marginTop: 16, marginLeft: 32, width: 886, height: 46, border: '1px solid #4d6a99', background: '#344d71', borderRadius: 5, display: 'flex', gap: 12, alignItems: 'center', padding: '0 15px', boxSizing: 'border-box'}}><div style={{width: 26, height: 26, borderRadius: 30, display: 'grid', placeItems: 'center', background: '#7d8d9a'}}><Glyph name="user" size={17}/></div><span style={{fontFamily: mono, fontSize: 18}}>developer</span><span style={{fontSize: 15, marginLeft: 'auto', color: '#c3d1e3'}}>Administrator</span></div>
      <div style={{marginTop: 10, marginLeft: 33, display: 'flex', width: 74, height: 26, borderRadius: 5, border: '1px solid #ffffff20', justifyContent: 'space-around', alignItems: 'center', color: '#bcc1cc'}}><span style={{fontSize: 22}}>+</span><svg width="14" height="14"><path d="M2 7h10" stroke="currentColor"/></svg></div>
    </div>
    <div style={{position: 'absolute', left: 351, top: 557, display: 'flex', alignItems: 'center', gap: 11, opacity: ramp(frame, 36, 46)}}><Glyph name="key" size={19} color="#899da9"/><span style={{fontFamily: mono, fontSize: 18, color: '#b6c3cb'}}>ssh developer@mac.local</span></div>
    <div style={{position: 'absolute', left: 326, bottom: 27, color: '#939aa8', fontSize: 16}}>Enable Remote Login on the Mac before pairing</div>
    <div style={{position: 'absolute', right: 40, bottom: 24, padding: '7px 27px', borderRadius: 7, border: '1px solid #ffffff1a', background: '#3b3e48', fontSize: 17}}>Done</div>
  </div>;
}

export function PairingOptionsTerminal({frame}: {frame: number}) {
  const active = frame < 40 ? 0 : frame < 80 ? 1 : 2;
  const rows = [
    {label: 'Password once', command: 'capmac pair', detail: 'Discover your Mac on the local network'},
    {label: 'Your SSH key', command: 'capmac pair developer@mac.local --identity C:\\keys\\id_ed25519', detail: 'Choose the private key you already use'},
    {label: 'Windows OpenSSH agent', command: 'capmac pair developer@mac.local --agent', detail: 'Use a key loaded into your SSH agent'},
  ];
  return <div style={shell}>
    <WindowsTitlebar title="Windows PowerShell" terminal/>
    <div style={{position: 'absolute', left: 56, top: 75, color: '#9aa1b1', fontSize: 18}}>Three ways to pair your Mac<span style={{marginLeft: 16, fontSize: 14, border: '1px solid #ffffff18', padding: '3px 9px', borderRadius: 5, color: '#929aae'}}>CLI examples</span></div>
    {rows.map((row, index) => <div key={row.label} style={{position: 'absolute', left: 44, right: 44, top: 122 + index * 145, height: 126, border: '1px solid ' + (active === index ? '#bcaafa6b' : '#ffffff0a'), background: active === index ? '#bcaafa0d' : '#ffffff02', borderRadius: 9, padding: '17px 23px', boxSizing: 'border-box', opacity: active === index ? 1 : .61}}>
      <div style={{fontSize: 20, color: active === index ? C.violet : '#d0d2dd', fontWeight: 500}}>{row.label}</div>
      <div style={{fontFamily: mono, fontSize: 25, marginTop: 15, whiteSpace: 'nowrap', letterSpacing: '-.55px'}}><span style={{color: '#8b91a4', marginRight: 17}}>PS &gt;</span>{row.command}<span style={{color: C.violet, opacity: active === index && Math.floor(frame / 13) % 2 === 0 ? 1 : 0}}>▌</span></div>
      <div style={{fontSize: 16, color: '#8f98aa', marginTop: 10}}>{row.detail}</div>
    </div>)}
    <div style={{position: 'absolute', left: 68, top: 609, display: 'flex', alignItems: 'center', gap: 11, color: '#a6b3ba', fontSize: 18}}><Glyph name="key" size={20} color={C.mint}/><span>Pair once, then keep working from Windows</span></div>
  </div>;
}

function SelectValue({children, open = false}: {children: ReactNode; open?: boolean}) {
  return <div style={{height: 40, width: 250, border: '1px solid ' + (open ? '#bcaafa8a' : '#ffffff20'), borderRadius: 7, background: '#303540', display: 'flex', alignItems: 'center', padding: '0 14px', boxSizing: 'border-box', fontSize: 18, color: '#e3e5ec', boxShadow: open ? '0 0 0 2px #bcaafa0c' : undefined}}>{children}<svg width="14" height="14" viewBox="0 0 14 14" style={{marginLeft: 'auto'}}><path d="m3 5 4 4 4-4" stroke="#aeb4c2" fill="none" strokeWidth="1.5"/></svg></div>;
}

export function RemoteAccessWindow({frame}: {frame: number}) {
  const enabled = frame >= 30;
  const optionsVisible = ramp(frame, 32, 40);
  const choosing = frame >= 60 && frame < 106;
  const internet = frame >= 85;
  const awake = frame >= 135;
  return <div style={shell}>
    <WindowsTitlebar title="CapMac Studio"/>
    <div style={{position: 'absolute', left: 0, top: 49, bottom: 0, width: 239, borderRight: '1px solid #ffffff0d', background: '#20242d'}}>
      <div style={{height: 69, display: 'flex', alignItems: 'center', paddingLeft: 22, gap: 11}}><Img src={staticFile('capmac-icon.svg')} style={{width: 31, height: 31}}/><span style={{fontSize: 24, fontWeight: 600, letterSpacing: '-.7px'}}>CapMac</span></div>
      {[{label: 'Projects', icon: 'home' as const}, {label: 'Macs', icon: 'mac' as const}, {label: 'Settings', icon: 'settings' as const}].map(item => <div key={item.label} style={{margin: '5px 12px', height: 43, borderRadius: 7, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 12, background: item.label === 'Macs' ? '#bcaafa14' : undefined, color: item.label === 'Macs' ? C.violet : '#a8afbe', fontSize: 18}}><Glyph name={item.icon} size={21}/>{item.label}</div>)}
      <div style={{position: 'absolute', bottom: 28, left: 26, fontSize: 14, color: '#7c8597'}}>Windows workspace</div>
    </div>
    <div style={{position: 'absolute', left: 275, top: 78, fontSize: 30, fontWeight: 500, letterSpacing: '-.7px'}}>Macs</div>
    <div style={{position: 'absolute', left: 1180, top: 85, display: 'flex', alignItems: 'center', gap: 9, fontFamily: mono, fontSize: 15, color: '#9ea8ba'}}><span style={{color: C.violet}}>&gt;</span>capmac remote on</div>
    <div style={{position: 'absolute', left: 275, top: 133, width: 1127, height: 375, borderRadius: 10, border: '1px solid #ffffff14', background: C.surface}}>
      <div style={{height: 62, boxSizing: 'border-box', borderBottom: '1px solid #ffffff10', display: 'flex', alignItems: 'center', padding: '0 24px', gap: 13}}><Glyph name="mac" size={27} color="#c8ceda"/><span style={{fontSize: 23, fontWeight: 500}}>Mac mini</span><span style={{fontFamily: mono, fontSize: 15, color: '#8d98aa', marginLeft: 5}}>mac.local</span><span style={{marginLeft: 'auto', fontSize: 15, color: C.mint, padding: '4px 9px', background: '#9bd7bc0b', border: '1px solid #9bd7bc22', borderRadius: 5}}>Paired</span></div>
      <div style={{position: 'absolute', left: 24, top: 75, width: 1063, display: 'flex', alignItems: 'center', gap: 14}}><div style={{height: 38, width: 38, display: 'grid', placeItems: 'center', borderRadius: 9, color: enabled ? C.mint : '#8894a9', background: enabled ? '#9bd7bc12' : '#ffffff07'}}><Glyph name="globe" size={23}/></div><div><div style={{fontSize: 23, fontWeight: 500}}>Reach this Mac from anywhere</div><div style={{fontSize: 16, marginTop: 5, color: enabled ? '#a8c9b6' : '#8691a4'}}>{enabled ? 'Direct when possible and relay when needed' : 'Remote access is off'}</div></div><div style={{marginLeft: 'auto', marginRight: 23}}><Switch on={enabled} progress={ramp(frame, 30, 36)}/></div></div>
      <div style={{position: 'absolute', left: 77, right: 45, top: 153, opacity: optionsVisible}}>
        <div style={{height: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}><span style={{fontSize: 19, color: '#bac1cf'}}>Connection</span><SelectValue open={choosing}>{internet ? 'Internet only' : 'Automatic'}</SelectValue></div>
        <div style={{height: 40, marginTop: 34, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}><span style={{fontSize: 19, color: '#bac1cf'}}>Keep Mac awake</span><div style={{marginRight: 23}}><Switch on={awake} progress={ramp(frame, 135, 141)}/></div></div>
        <div style={{height: 40, marginTop: 27, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}><span style={{fontSize: 19, color: '#bac1cf'}}>Relay</span><SelectValue>When needed</SelectValue></div>
      </div>
    </div>
    <div style={{position: 'absolute', left: 275, top: 531, width: 1127, height: 85, borderRadius: 9, border: '1px solid #ffffff13', background: '#242833', padding: '17px 22px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 16}}><Glyph name="globe" size={25} color="#8e9bab"/><div style={{fontSize: 20}}>Your signaling server<div style={{fontSize: 14, color: '#8793a6', marginTop: 6}}>Configured in Settings</div></div><div style={{marginLeft: 'auto', fontFamily: mono, color: '#c8cfdd', fontSize: 18, border: '1px solid #ffffff19', padding: '10px 14px', borderRadius: 6, background: '#1c2029'}}>wss://signal.example.com</div><span style={{fontSize: 13, color: '#8591a2', marginLeft: 3}}>Example</span></div>
    <div style={{position: 'absolute', left: 302, bottom: 28, color: '#9aa5b7', fontSize: 16}}>First setup on the Mac network<span style={{margin: '0 15px', color: '#536072'}}>/</span>Mac awake and desktop logged in</div>
    {choosing && <div style={{position: 'absolute', left: 1099, top: 332, width: 270, padding: '7px', borderRadius: 8, boxSizing: 'border-box', background: '#303642', border: '1px solid #bcaafa4d', boxShadow: '0 16px 35px #0007', zIndex: 10}}>{['Automatic', 'Local network only', 'Internet only'].map((choice, i) => <div key={choice} style={{height: 45, display: 'flex', alignItems: 'center', gap: 11, padding: '0 12px', borderRadius: 5, background: (internet ? i === 2 : i === 0) ? '#bcaafa1a' : undefined, fontSize: 18, color: '#e1e4ed'}}><Radio selected={internet ? i === 2 : i === 0}/>{choice}</div>)}</div>}
    {frame >= 155 && frame < 199 && <div style={{position: 'absolute', left: 1099, top: 471, width: 270, padding: '7px', borderRadius: 8, boxSizing: 'border-box', background: '#303642', border: '1px solid #bcaafa4d', boxShadow: '0 16px 35px #0007', zIndex: 10}}>{['When needed', 'Never', 'Always'].map((choice, i) => <div key={choice} style={{height: 43, display: 'flex', alignItems: 'center', gap: 11, padding: '0 12px', borderRadius: 5, background: i === 0 ? '#bcaafa1a' : undefined, fontSize: 18, color: '#e1e4ed'}}><Radio selected={i === 0}/>{choice}</div>)}</div>}
  </div>;
}
