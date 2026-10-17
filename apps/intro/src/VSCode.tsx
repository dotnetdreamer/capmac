import React, {type CSSProperties, type ReactNode} from 'react';
import {Img, staticFile} from 'remotion';
import {Sheen} from './Motion';

/** VS Code's Dark Modern theme, at the size VS Code draws it on a Windows PC */
export const VS = {
  bg: '#1f1f1f', chrome: '#181818', border: '#2b2b2b', text: '#cccccc', dim: '#9d9d9d', faint: '#6e7681',
  blue: '#0078d4', link: '#4daafc', select: '#04395e', hover: '#2a2d2e', error: '#f14c4c', warn: '#cca700', ok: '#89d185',
};
export const uiFont = '"Segoe WPC", "Segoe UI", sans-serif';
export const codeFont = 'Consolas, "JetBrains Mono", "Courier New", monospace';

const CODICONS = {
  files: 'eaf0', search: 'ea6d', 'source-control': 'ea68', 'debug-alt': 'eb91', extensions: 'eae6', account: 'eb99', 'settings-gear': 'eb51',
  'device-mobile': 'eadb', zap: 'ea86', play: 'eb2c', 'debug-stop': 'ead7', refresh: 'eb37', 'debug-restart': 'ead2', 'debug-pause': 'ead1',
  'debug-step-over': 'ead6', 'debug-step-into': 'ead4', 'debug-step-out': 'ead5', gripper: 'eb04', close: 'ea76', 'chevron-down': 'eab4',
  'chevron-right': 'eab6', pass: 'eba4', 'pass-filled': 'ebb3', 'circle-slash': 'eabd', 'circle-large-outline': 'ebb5', error: 'ea87', warning: 'ea6c',
  info: 'ea74', package: 'eb29', vm: 'ea7a', window: 'eb7f', plug: 'eb2d', globe: 'eb01', home: 'eb06', lock: 'ea75', 'device-camera': 'eada',
  'split-horizontal': 'eb56', ellipsis: 'ea7c', add: 'ea60', 'collapse-all': 'eac5', filter: 'eaf1', 'clear-all': 'eabf', check: 'eab2', loading: 'eb19',
  sync: 'ea77', tools: 'eb6d', 'desktop-download': 'ea78', terminal: 'ea85', output: 'eb9d', bell: 'eaa2', copilot: 'ec1e', sparkle: 'ec10', send: 'ec0f',
  attach: 'ec34', 'layout-sidebar-left': 'ebf3', 'layout-panel': 'ebf2', 'layout-sidebar-right': 'ebf4', layout: 'ebeb', 'arrow-left': 'ea9b',
  'arrow-right': 'ea9c', 'screen-full': 'eb4c', 'chrome-close': 'eab8', 'chrome-minimize': 'eaba', 'chrome-maximize': 'eab9', 'git-branch': 'ec6f',
  remote: 'eb3a', 'circle-filled': 'ea71', 'debug-console': 'eb9b', pulse: 'eb31', wrench: 'eb65', history: 'ea82', person: 'ea67', copy: 'ebcc',
  'file-code': 'eae9', json: 'eb0f', vscode: 'ec29', settings: 'eb52', tasklist: 'eb67', 'chat-sparkle': 'ec4f', agent: 'ec67', 'arrow-up': 'eaa1',
  'run-below': 'ebbe', 'server-environment': 'eba3', 'circle-large-filled': 'ebb4', 'new-file': 'ea7f', beaker: 'ea79',
} as const;
export type CodiconName = keyof typeof CODICONS;

export function Codicon({name, size = 16, color, style}: {name: CodiconName; size?: number; color?: string; style?: CSSProperties}) {
  return <span style={{fontFamily: 'codicon', fontSize: size, lineHeight: `${size}px`, width: size, height: size, display: 'inline-block', textAlign: 'center', color, flexShrink: 0, ...style}}>{String.fromCharCode(parseInt(CODICONS[name], 16))}</span>;
}

/** CapMac's icon in the activity bar: a phone with a play mark */
export function CapMacMark({size = 24, color = 'currentColor'}: {size?: number; color?: string}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{display: 'block', flexShrink: 0}}><rect x="6.75" y="2.75" width="10.5" height="18.5" rx="2.75" stroke={color} strokeWidth="1.5"/><path d="M10.75 5.25h2.5" stroke={color} strokeWidth="1.5" strokeLinecap="round"/><path d="M10.6 9.4v5.2l4.1-2.6z" fill={color} stroke={color} strokeWidth="1.1" strokeLinejoin="round"/></svg>;
}

/* ---------- Code, highlighted the way Dark Modern colors TypeScript, Dart and Swift ---------- */

const KEYWORDS: Record<string, {control: string[]; storage: string[]}> = {
  ts: {control: ['import', 'from', 'export', 'default', 'return', 'if', 'else', 'await', 'as'], storage: ['const', 'let', 'function', 'async', 'type', 'interface', 'new', 'true', 'false', 'null', 'undefined']},
  dart: {control: ['import', 'return', 'if', 'else', 'await'], storage: ['class', 'extends', 'final', 'const', 'void', 'var', 'super', 'required', 'this', 'true', 'false', 'override']},
  swift: {control: ['import', 'return', 'if', 'else', 'guard'], storage: ['func', 'let', 'var', 'class', 'override', 'self', 'true', 'false', 'struct', 'private']},
};
// A string still being typed has no closing quote yet, and runs to the end of the line, as in the editor
const TOKEN = /(\/\/.*$)|('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?|`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|(@?[A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d'"`]+)|(.)/g;

export function highlight(line: string, lang: 'ts' | 'dart' | 'swift'): ReactNode[] {
  const out: ReactNode[] = [];
  const words = KEYWORDS[lang];
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(line))) {
    const [text, comment, string, number, word] = match;
    const rest = line.slice(TOKEN.lastIndex);
    let color = '#d4d4d4';
    if (comment) color = '#6a9955';
    else if (string) color = '#ce9178';
    else if (number) color = '#b5cea8';
    else if (word) {
      if (word.startsWith('@')) color = '#dcdcaa';
      else if (words.control.includes(word)) color = '#c586c0';
      else if (words.storage.includes(word)) color = '#569cd6';
      else if (/^\s*\(/.test(rest)) color = '#dcdcaa';
      else if (/^[A-Z]/.test(word)) color = '#4ec9b0';
      else color = '#9cdcfe';
    }
    out.push(<span key={out.length} style={{color}}>{text}</span>);
  }
  return out;
}

export type CodeLine = string;

/**
 * An editor: line numbers, highlighted code, the CodeLens line CapMac adds above the first line, an optional
 * error squiggle and a blinking cursor.
 */
export function CodeEditor({lines, lang, frame, first = 1, lens, cursor, squiggle, selection, active, width}: {
  lines: readonly CodeLine[]; lang: 'ts' | 'dart' | 'swift'; frame: number; first?: number; lens?: ReactNode;
  cursor?: {line: number; col: number}; squiggle?: {line: number; from: number; to: number}; selection?: {line: number; from: number; to: number}; active?: number; width?: number;
}) {
  const char = 7.7;
  return <div style={{position: 'relative', fontFamily: codeFont, fontSize: 14, lineHeight: '19px', color: '#d4d4d4', paddingTop: 6, width}}>
    {lens && <div style={{height: 19, paddingLeft: 64, fontFamily: uiFont, fontSize: 12, color: '#999999', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap'}}>{lens}</div>}
    {lines.map((line, i) => {
      const number = first + i;
      const current = active === number || cursor?.line === number;
      return <div key={i} style={{position: 'relative', display: 'flex', height: 19, background: current ? '#ffffff08' : undefined, boxShadow: current ? 'inset 0 0 0 1px #282828' : undefined}}>
        {selection?.line === number && <span style={{position: 'absolute', left: 64 + selection.from * char, width: (selection.to - selection.from) * char, top: 0, height: 19, background: '#264f78'}}/>}
        <span style={{position: 'relative', width: 50, textAlign: 'right', paddingRight: 14, color: current ? '#cccccc' : VS.faint, flexShrink: 0}}>{number}</span>
        <span style={{position: 'relative', whiteSpace: 'pre'}}>{highlight(line, lang)}</span>
        {squiggle?.line === number && <span style={{position: 'absolute', left: 64 + squiggle.from * char, width: (squiggle.to - squiggle.from) * char, bottom: 1, height: 3, background: `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3"><path d="M0 2.5 1.5 1 3 2.5 4.5 1 6 2.5" fill="none" stroke="#f14c4c" stroke-width="1"/></svg>')}") repeat-x`}}/>}
        {cursor?.line === number && frame % 30 < 18 && <span style={{position: 'absolute', left: 64 + cursor.col * char, top: 1, width: 2, height: 17, background: '#aeafad'}}/>}
      </div>;
    })}
  </div>;
}

/* ---------- The side bar's trees ---------- */

export function Section({title, desc, open = true, actions, children, height}: {title: string; desc?: string; open?: boolean; actions?: ReactNode; children?: ReactNode; height?: number}) {
  return <div style={{borderTop: `1px solid ${VS.border}`, height, overflow: 'hidden', flexShrink: 0}}>
    <div style={{height: 22, display: 'flex', alignItems: 'center', gap: 2, padding: '0 8px 0 2px', fontSize: 11, fontWeight: 700, color: VS.text}}>
      <Codicon name={open ? 'chevron-down' : 'chevron-right'} size={16}/>{title}{desc && <span style={{fontWeight: 400, color: VS.dim, marginLeft: 8}}>{desc}</span>}
      <span style={{marginLeft: 'auto', display: 'flex', gap: 6, color: VS.text}}>{actions}</span>
    </div>
    {open && children}
  </div>;
}

export function Row({depth = 0, twistie, icon, label, desc, selected = false, focused = false, actions, labelColor, style}: {
  depth?: number; twistie?: 'open' | 'closed'; icon?: ReactNode; label: ReactNode; desc?: ReactNode; selected?: boolean; focused?: boolean;
  actions?: ReactNode; labelColor?: string; style?: CSSProperties;
}) {
  return <div style={{position: 'relative', height: 22, display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 6 + depth * 12, paddingRight: 8, fontSize: 13, color: labelColor ?? VS.text, whiteSpace: 'nowrap', background: selected ? VS.select : undefined, boxShadow: focused ? `inset 0 0 0 1px ${VS.blue}` : undefined, ...style}}>
    <span style={{width: 16, display: 'grid', placeItems: 'center', flexShrink: 0}}>{twistie && <Codicon name={twistie === 'open' ? 'chevron-down' : 'chevron-right'} size={16} color={VS.text}/>}</span>
    {icon && <span style={{width: 16, height: 16, display: 'grid', placeItems: 'center', flexShrink: 0}}>{icon}</span>}
    <span>{label}</span>
    {desc && <span style={{color: VS.dim, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis'}}>{desc}</span>}
    {actions && <span style={{marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center'}}>{actions}</span>}
  </div>;
}

/** A run step's icon, as CapMac's Run view draws it */
export function StepIcon({state}: {state: 'pending' | 'running' | 'done' | 'skipped' | 'failed'}) {
  if (state === 'done') return <Codicon name="pass" size={16} color="#73c991"/>;
  if (state === 'skipped') return <Codicon name="circle-slash" size={16} color="#6e6e6e"/>;
  if (state === 'failed') return <Codicon name="error" size={16} color={VS.error}/>;
  if (state === 'running') return <Codicon name="loading" size={16} color={VS.text}/>;
  return <Codicon name="circle-large-outline" size={16} color="#6e6e6e"/>;
}

/* ---------- The editor area ---------- */

export type Tab = {label: string; icon: ReactNode; dirty?: boolean};

export function Tabs({tabs, active, right}: {tabs: readonly Tab[]; active: number; right?: ReactNode}) {
  return <div style={{height: 35, display: 'flex', background: VS.chrome, borderBottom: `1px solid ${VS.border}`, flexShrink: 0}}>
    {tabs.map((tab, i) => <div key={tab.label} style={{display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 0 12px', fontSize: 13, color: i === active ? '#ffffff' : VS.dim, background: i === active ? VS.bg : VS.chrome, borderRight: `1px solid ${VS.border}`, boxShadow: i === active ? `inset 0 1px 0 ${VS.blue}` : undefined, marginBottom: i === active ? -1 : 0, whiteSpace: 'nowrap'}}>
      {tab.icon}{tab.label}
      <span style={{width: 16, display: 'grid', placeItems: 'center', marginLeft: 4}}>{tab.dirty ? <span style={{width: 8, height: 8, borderRadius: 4, background: '#ffffff'}}/> : i === active ? <Codicon name="close" size={14}/> : null}</span>
    </div>)}
    <span style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, paddingRight: 10, color: VS.text}}>{right ?? <><Codicon name="split-horizontal" size={16}/><Codicon name="ellipsis" size={16}/></>}</span>
  </div>;
}

/** A file's icon in a tab or the Explorer, by language */
export function FileIcon({lang}: {lang: 'ts' | 'tsx' | 'dart' | 'swift' | 'json'}) {
  const look = {ts: ['TS', '#3178c6'], tsx: ['⚛', '#4fc1ff'], dart: ['◆', '#40c4ff'], swift: ['S', '#f05138'], json: ['{}', '#cbcb41']}[lang];
  return <span style={{width: 16, textAlign: 'center', fontSize: lang === 'ts' || lang === 'swift' ? 10 : 12, fontWeight: 700, color: look[1], fontFamily: uiFont, flexShrink: 0}}>{look[0]}</span>;
}

/** The simulator's screen in a VS Code tab: CapMac's device frame, then a bar with the device, Home, Lock, typing and a screenshot */
export function ScreenTab({children, name, fps, width, height, phoneScale = 1, typing, sheenAt, frame, fill = false}: {children: ReactNode; name: string; fps?: number; width: number; height: number; phoneScale?: number; typing?: string; sheenAt?: number; frame: number; fill?: boolean}) {
  const phoneW = 300 * phoneScale;
  const phoneH = 600 * phoneScale;
  return <div style={{position: 'relative', width, height, background: VS.bg, overflow: 'hidden'}}>
    {fill ? <div style={{position: 'absolute', left: 0, right: 0, top: 0, bottom: 46, display: 'grid', placeItems: 'center'}}>{children}</div> : <div style={{position: 'absolute', left: (width - phoneW) / 2, top: Math.max(12, (height - 46 - phoneH) / 2), width: phoneW, height: phoneH}}>
      {children}
      {sheenAt !== undefined && <div style={{position: 'absolute', inset: 9 * phoneScale, borderRadius: 38 * phoneScale, overflow: 'hidden'}}><Sheen frame={frame} at={sheenAt}/></div>}
    </div>}
    <div style={{position: 'absolute', left: 20, right: 20, bottom: 8, height: 30, display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: VS.text}}>
      <span style={{width: 8, height: 8, borderRadius: 4, background: '#3fb950'}}/><span style={{fontWeight: 600}}>{name}</span>
      <Codicon name="home" size={16} color={VS.dim}/><Codicon name="lock" size={16} color={VS.dim}/>
      <span style={{width: 150, height: 24, border: '1px solid #3c3c3c', background: '#313131', borderRadius: 2, display: 'flex', alignItems: 'center', padding: '0 7px', fontSize: 12, color: typing ? VS.text : '#8b8b8b', overflow: 'hidden', whiteSpace: 'nowrap'}}>{typing ?? 'Text to type on the simu…'}</span>
      <span style={{marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 10, background: fps ? '#0e639c' : '#3a3d41', color: '#ffffff'}}>{fps ?? 0} fps</span>
      <Codicon name="device-camera" size={16} color={VS.dim}/>
    </div>
  </div>;
}

/** The floating debug toolbar, with the buttons CapMac puts on it */
export function DebugToolbar({opacity = 1, hot = false}: {opacity?: number; hot?: boolean}) {
  const icon = (name: CodiconName, color?: string) => <span style={{width: 26, height: 26, display: 'grid', placeItems: 'center'}}><Codicon name={name} size={16} color={color}/></span>;
  return <div style={{display: 'flex', alignItems: 'center', height: 32, padding: '0 4px', background: '#252526', border: '1px solid #3c3c3c', borderRadius: 6, boxShadow: '0 4px 14px #0008', opacity, color: VS.text}}>
    {icon('gripper', '#7a7a7a')}{icon('refresh', hot ? '#ffffff' : VS.text)}{icon('device-mobile')}{icon('debug-pause', '#6a6a6a')}{icon('debug-step-over', '#6a6a6a')}{icon('debug-step-into', '#6a6a6a')}{icon('debug-step-out', '#6a6a6a')}{icon('debug-restart', '#89d185')}{icon('debug-stop', '#f48771')}
  </div>;
}

/* ---------- The panel ---------- */

export type ConsoleLine = {kind: 'step' | 'skip' | 'running' | 'reload' | 'app' | 'dim' | 'error' | 'start'; tag?: string; text: string; detail?: string};

export function DebugConsole({lines, height}: {lines: readonly ConsoleLine[]; height: number}) {
  const color = {step: '#cca700', skip: '#8f7f3c', running: '#89d185', reload: '#d670d6', app: '#9cdcfe', dim: '#8f7f3c', error: '#f48771', start: '#cca700'};
  const mark = {step: '✓', skip: 'o', running: '●', reload: '↻', start: '▶', error: '✗', app: '', dim: ''};
  const shown = lines.slice(-Math.floor((height - 30) / 20));
  return <div style={{height, overflow: 'hidden', padding: '4px 0 0 14px', fontFamily: codeFont, fontSize: 13.5, lineHeight: '20px'}}>
    {shown.map((line, i) => <div key={lines.length - shown.length + i} style={{display: 'flex', gap: 10, whiteSpace: 'nowrap', color: color[line.kind], fontWeight: line.kind === 'start' ? 700 : undefined}}>
      {line.tag && <span style={{width: 34, flexShrink: 0, color: '#3794ff'}}>{line.tag}</span>}
      {mark[line.kind] && <span>{mark[line.kind]}</span>}
      <span>{line.text}</span>{line.detail && <span style={{color: '#8b8b8b'}}>{line.detail}</span>}
    </div>)}
    <div style={{color: VS.text, marginTop: 2}}>›</div>
  </div>;
}

export function Panel({tab, problems = 0, children, height, right}: {tab: 'Problems' | 'Output' | 'Debug Console' | 'Terminal' | 'Ports'; problems?: number; children: ReactNode; height: number; right?: ReactNode}) {
  return <div style={{height, borderTop: `1px solid ${VS.border}`, background: VS.chrome, display: 'flex', flexDirection: 'column', flexShrink: 0}}>
    <div style={{height: 35, display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px', fontSize: 13, flexShrink: 0}}>
      {(['Problems', 'Output', 'Debug Console', 'Terminal', 'Ports'] as const).map(name => <span key={name} style={{display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: '0 8px', borderRadius: 4, background: name === tab ? '#2b2b2b' : undefined, color: name === tab ? '#ffffff' : VS.dim}}>{name}{name === 'Problems' && problems > 0 && <span style={{minWidth: 16, height: 16, borderRadius: 8, background: VS.blue, color: '#fff', fontSize: 10.5, display: 'grid', placeItems: 'center', padding: '0 4px', boxSizing: 'border-box'}}>{problems}</span>}</span>)}
      <span style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, color: VS.text}}>{right ?? <><span style={{width: 190, height: 24, border: '1px solid #3c3c3c', background: '#313131', borderRadius: 2, fontSize: 12, color: '#8b8b8b', display: 'flex', alignItems: 'center', padding: '0 7px'}}>Filter (e.g. text, !exclude)</span><Codicon name="clear-all" size={16}/><Codicon name="screen-full" size={16}/><Codicon name="close" size={16}/></>}</span>
    </div>
    <div style={{flex: 1, overflow: 'hidden', background: VS.chrome}}>{children}</div>
  </div>;
}

/* ---------- The window ---------- */

export type StatusItem = {icon?: CodiconName; text: string; tone?: 'error'};

export type VSView = {
  frame: number;
  title: string;
  activity: 'explorer' | 'capmac';
  sideTitle: string;
  side: ReactNode;
  editor: ReactNode;
  panel?: ReactNode;
  panelHeight?: number;
  debugging: boolean;
  status: StatusItem[];
  errors?: number;
  debugToolbar?: {opacity: number; hot?: boolean; left: number};
  chat?: {width: number; content: ReactNode};
  overlay?: ReactNode;
  capmacGlow?: number;
};

export const VSW = {width: 1600, height: 920, title: 35, status: 22, activity: 48, side: 300};

export function VSCodeWindow({view}: {view: VSView}) {
  const panelHeight = view.panel ? view.panelHeight ?? 270 : 0;
  const bodyHeight = VSW.height - VSW.title - VSW.status;
  const chatWidth = view.chat?.width ?? 0;
  const statusBg = view.debugging ? VS.blue : VS.chrome;
  const activity = (name: CodiconName | 'capmac', active: boolean) => <div style={{position: 'relative', width: 48, height: 48, display: 'grid', placeItems: 'center', color: active ? '#ffffff' : '#868686'}}>
    {active && <span style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: VS.blue}}/>}
    {name === 'capmac' ? <div style={{position: 'relative'}}><CapMacMark size={24}/>{(view.capmacGlow ?? 0) > 0 && <span style={{position: 'absolute', inset: -9, borderRadius: 10, boxShadow: `0 0 0 2px rgba(77,170,252,${view.capmacGlow}), 0 0 22px rgba(77,170,252,${(view.capmacGlow ?? 0) * .7})`}}/>}</div> : <Codicon name={name} size={24}/>}
  </div>;
  return <div style={{position: 'relative', width: VSW.width, height: VSW.height, borderRadius: 10, overflow: 'hidden', background: VS.bg, border: '1px solid #3a3a3a', boxShadow: '0 40px 110px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.4)', fontFamily: uiFont, color: VS.text}}>
    <div style={{height: VSW.title, display: 'flex', alignItems: 'center', background: VS.chrome, borderBottom: `1px solid ${VS.border}`, fontSize: 13, position: 'relative'}}>
      <span style={{width: 35, display: 'grid', placeItems: 'center', marginLeft: 4}}><Codicon name="vscode" size={17} color="#3c9cf0"/></span>
      {['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help'].map(item => <span key={item} style={{padding: '0 7px', color: VS.text}}>{item}</span>)}
      <div style={{position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10}}>
        <Codicon name="arrow-left" size={16} color="#8b8b8b"/><Codicon name="arrow-right" size={16} color="#5a5a5a"/>
        <div style={{width: 470, height: 24, borderRadius: 6, background: '#2a2a2a', border: '1px solid #3c3c3c', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 12.5, color: VS.text}}><Codicon name="search" size={14} color={VS.dim}/>{view.title}</div>
      </div>
      <div style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', height: '100%'}}>
        <span style={{display: 'flex', gap: 12, paddingRight: 14, color: VS.text}}><Codicon name="layout-sidebar-left" size={16}/><Codicon name="layout-panel" size={16}/><Codicon name="layout-sidebar-right" size={16}/></span>
        {(['chrome-minimize', 'chrome-maximize', 'chrome-close'] as const).map(name => <span key={name} style={{width: 46, height: '100%', display: 'grid', placeItems: 'center'}}><Codicon name={name} size={16}/></span>)}
      </div>
    </div>
    <div style={{display: 'flex', height: bodyHeight}}>
      <div style={{width: VSW.activity, background: VS.chrome, borderRight: `1px solid ${VS.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0}}>
        {activity('files', view.activity === 'explorer')}{activity('search', false)}{activity('source-control', false)}{activity('debug-alt', false)}{activity('extensions', false)}{activity('capmac', view.activity === 'capmac')}
        <div style={{flex: 1}}/>{activity('account', false)}{activity('settings-gear', false)}
      </div>
      <div style={{width: VSW.side, background: VS.chrome, borderRight: `1px solid ${VS.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden'}}>
        <div style={{height: 35, display: 'flex', alignItems: 'center', padding: '0 8px 0 20px', fontSize: 11, color: VS.text, flexShrink: 0}}>{view.sideTitle}<span style={{marginLeft: 'auto'}}><Codicon name="ellipsis" size={16}/></span></div>
        {view.side}
      </div>
      <div style={{flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative'}}>
        <div style={{flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden'}}>{view.editor}</div>
        {view.panel && <div style={{height: panelHeight}}>{view.panel}</div>}
        {view.debugToolbar && <div style={{position: 'absolute', top: 4, left: view.debugToolbar.left, zIndex: 10}}><DebugToolbar opacity={view.debugToolbar.opacity} hot={view.debugToolbar.hot}/></div>}
      </div>
      {view.chat && <div style={{width: chatWidth, background: VS.chrome, borderLeft: `1px solid ${VS.border}`, flexShrink: 0, overflow: 'hidden'}}>{view.chat.content}</div>}
    </div>
    <div style={{height: VSW.status, display: 'flex', alignItems: 'center', background: statusBg, color: view.debugging ? '#ffffff' : VS.text, fontSize: 12, borderTop: view.debugging ? undefined : `1px solid ${VS.border}`}}>
      <span style={{height: '100%', width: 34, display: 'grid', placeItems: 'center', background: view.debugging ? '#16825d00' : VS.blue, color: '#ffffff'}}><Codicon name="remote" size={14}/></span>
      <span style={{display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px'}}><Codicon name="error" size={14}/>{view.errors ?? 0}<Codicon name="warning" size={14} style={{marginLeft: 4}}/>0</span>
      {view.status.map(item => <span key={item.text} style={{display: 'flex', alignItems: 'center', gap: 5, padding: '0 9px', height: '100%', background: item.tone === 'error' ? '#c72e0f' : undefined, color: item.tone === 'error' ? '#ffffff' : undefined}}>{item.icon && <Codicon name={item.icon} size={14}/>}{item.text}</span>)}
      <span style={{marginLeft: 'auto', display: 'flex', gap: 14, paddingRight: 12}}><Codicon name="copilot" size={14}/><Codicon name="bell" size={14}/></span>
    </div>
    {view.overlay}
  </div>;
}

/* ---------- Chat and notifications ---------- */

/** VS Code's chat view, in agent mode */
export function ChatPanel({children}: {children: ReactNode}) {
  return <div style={{height: '100%', display: 'flex', flexDirection: 'column', fontFamily: uiFont}}>
    <div style={{height: 35, display: 'flex', alignItems: 'center', padding: '0 10px 0 16px', fontSize: 11, color: VS.text, flexShrink: 0}}>CHAT<span style={{marginLeft: 'auto', display: 'flex', gap: 12}}><Codicon name="add" size={16}/><Codicon name="history" size={16}/><Codicon name="ellipsis" size={16}/></span></div>
    <div style={{flex: 1, overflow: 'hidden', padding: '8px 18px', display: 'flex', flexDirection: 'column', gap: 16}}>{children}</div>
    <div style={{margin: '0 12px 12px', borderRadius: 8, border: '1px solid #3c3c3c', background: '#1f1f1f', padding: '10px 12px', flexShrink: 0}}>
      <div style={{fontSize: 13, color: '#8b8b8b'}}>Ask the agent</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, fontSize: 12, color: VS.text}}><span style={{display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 4, background: '#2b2b2b'}}><Codicon name="agent" size={14}/>Agent<Codicon name="chevron-down" size={12}/></span><span style={{marginLeft: 'auto'}}><Codicon name="send" size={16}/></span></div>
    </div>
  </div>;
}

export function ChatMessage({who, agent = false, children, opacity = 1}: {who: string; agent?: boolean; children: ReactNode; opacity?: number}) {
  return <div style={{opacity, transform: `translateY(${(1 - opacity) * 8}px)`}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: '#e7e7e7'}}>
      <span style={{width: 22, height: 22, borderRadius: 11, display: 'grid', placeItems: 'center', background: agent ? '#2d2d2d' : '#3b5d86', fontSize: 11}}>{agent ? <Codicon name="copilot" size={14}/> : who[0]}</span>{who}
    </div>
    <div style={{marginTop: 8, fontSize: 13, lineHeight: '20px', color: '#d6d6d6'}}>{children}</div>
  </div>;
}

/** A language model tool the agent used, as the chat shows it once it ran */
export function ToolRow({label, tool, opacity = 1, running = false}: {label: string; tool: string; opacity?: number; running?: boolean}) {
  return <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#bdbdbd', opacity, margin: '6px 0'}}>
    {running ? <Codicon name="loading" size={14}/> : <Codicon name="check" size={14} color="#89d185"/>}{running ? 'Running' : 'Ran'} <span style={{color: '#e7e7e7'}}>{label}</span><span style={{fontFamily: codeFont, fontSize: 12, padding: '0 5px', borderRadius: 3, background: '#2b2b2b', color: '#9cdcfe'}}>#{tool}</span>
  </div>;
}

/** A tool that asks before it runs: CapMac's Run asks first */
export function ToolConfirm({title, message, pressed = false, opacity = 1}: {title: string; message: string; pressed?: boolean; opacity?: number}) {
  return <div style={{border: '1px solid #3c3c3c', borderRadius: 6, background: '#202020', padding: '12px 14px', opacity, margin: '6px 0'}}>
    <div style={{fontSize: 13, fontWeight: 600, color: '#e7e7e7'}}>{title}</div>
    <div style={{fontSize: 12.5, color: '#bdbdbd', marginTop: 6}}>{message}</div>
    <div style={{display: 'flex', gap: 8, marginTop: 12}}>
      <span style={{padding: '4px 12px', borderRadius: 2, background: pressed ? '#026ec1' : VS.blue, color: '#fff', fontSize: 12.5, transform: pressed ? 'scale(.97)' : undefined}}>Continue</span>
      <span style={{padding: '4px 12px', borderRadius: 2, background: '#313131', color: '#e7e7e7', fontSize: 12.5}}>Cancel</span>
    </div>
  </div>;
}

/** A notification in the corner of the window */
export function Toast({message, actions, opacity = 1}: {message: string; actions: readonly string[]; opacity?: number}) {
  return <div style={{width: 450, background: '#252526', border: '1px solid #454545', borderRadius: 6, boxShadow: '0 6px 22px #000a', padding: '12px 14px 10px', opacity, transform: `translateY(${(1 - opacity) * 14}px)`, fontFamily: uiFont}}>
    <div style={{display: 'flex', gap: 10, fontSize: 13, color: '#e0e0e0', lineHeight: '19px'}}><Codicon name="info" size={16} color="#3794ff" style={{marginTop: 1}}/><span>{message}</span><Codicon name="close" size={14} color="#9d9d9d" style={{marginLeft: 'auto'}}/></div>
    <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12}}>{actions.map((action, i) => <span key={action} style={{padding: '4px 12px', borderRadius: 2, background: i === 0 ? VS.blue : '#313131', color: '#fff', fontSize: 12.5}}>{action}</span>)}</div>
  </div>;
}

/** CapMac's icon as an image, for places outside VS Code's own chrome */
export const CapMacIcon = ({size}: {size: number}) => <Img src={staticFile('capmac-icon.svg')} style={{width: size, height: size}}/>;
