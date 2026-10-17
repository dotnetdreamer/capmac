import React from 'react';
import {AbsoluteFill, Html5Audio, Img, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {AppIcon, BloomDesktop, BloomPhone, BLOOM_GREETING, Handset, HomeScreen, MacWindow, Phone, PULSE_ACCENT, PulsePhone} from './Apps';
import {Atmosphere, Brand, C, Caption, Chip, Cuts, FRAMEWORKS, FontGate, KeyCap, Note, Sfx, Vignette, body, ease, r} from './Film';
import {Camera, Cursor, Lift, Sheen, Words, type CameraKey} from './Motion';
import {ChatMessage, ChatPanel, CodeEditor, Codicon, DebugConsole, FileIcon, Panel, Row, ScreenTab, Section, StepIcon, Tabs, Toast, ToolConfirm, ToolRow, VS, VSCodeWindow, codeFont, type ConsoleLine, type StatusItem, type Tab, type VSView} from './VSCode';

/**
 * CapMac for VS Code, as one continuous take inside one VS Code window: the folder opens, CapMac finds the apps,
 * ⚡ Live lands on the music's drop, and every later feature happens in the same window.
 */
export const VS_DURATION = 2040;
const X = 160;
const Y = 120;
/** A point in the VS Code window, in the frame */
const at = (x: number, y: number) => ({x: X + x, y: Y + y});

// The music's drop is at 480 and its final hit at 1920
const T = {
  rise: 150, activate: 262, capmac: 288, live: 480, screen: 590, launch: 602,
  theme: 720, themeSave: 768, tap: 838,
  bloom: 916, bloomSave: 998, pulse: 1044, pulseSave: 1114,
  swift: 1140, swiftSave: 1172, failed: 1204, problem: 1236, fixSave: 1280,
  devices: 1320, macApp: 1420, chat: 1500, toast: 1650, wide: 1740, leave: 1880,
};

/* ---------- The files on screen ---------- */

const CONFIG_TS = ["import type { CapacitorConfig } from '@capacitor/cli';", '', 'const config: CapacitorConfig = {', "  appId: 'com.example.orbit',", "  appName: 'Orbit',", "  webDir: 'dist',", "  server: { androidScheme: 'https' },", '};', '', 'export default config;'];
const THEME_TS = ["import { createApp } from 'vue'", "import App from './App.vue'", '', 'export const theme = {', "  accent: '#C5B5EC',", "  background: '#F5F3ED',", '}', '', 'createApp(App)', "  .provide('theme', theme)", "  .mount('#app')"];
const HOME_DART = ["import 'package:flutter/material.dart';", '', 'class Greeting extends StatelessWidget {', '  const Greeting({super.key});', '', '  @override', '  Widget build(BuildContext context) {', '    return Text(', `      '${BLOOM_GREETING[0]}',`, '      style: Theme.of(context).textTheme.headlineSmall,', '    );', '  }', '}'];
const APP_TSX = ["import { Screen, StepsRing } from './ui';", '', `const accent = '${PULSE_ACCENT[0].toUpperCase()}';`, '', 'export default function App() {', '  return (', '    <Screen title="Pulse">', '      <StepsRing steps={8214} goal={10000} color={accent} />', '    </Screen>', '  );', '}'];
const DELEGATE_SWIFT = ['import UIKit', 'import Capacitor', '', '@UIApplicationMain', 'class AppDelegate: UIResponder, UIApplicationDelegate {', '    var window: UIWindow?', '', '    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {', '        ', '        return true', '    }', '}'];

type Edit = {line: number; from: number; before: string; after: string; select: number; type: number};
/** A file being edited: the old text selected, then the new text typed over it */
const edited = (lines: readonly string[], edit: Edit, g: number) => {
  const original = lines[edit.line - 1];
  const typed = Math.max(0, Math.min(edit.after.length, Math.floor((g - edit.type) * 1.2)));
  const text = g < edit.type ? original : original.slice(0, edit.from) + edit.after.slice(0, typed) + original.slice(edit.from + edit.before.length);
  const out = [...lines];
  out[edit.line - 1] = text;
  return {
    lines: out,
    selection: g >= edit.select && g < edit.type ? {line: edit.line, from: edit.from, to: edit.from + edit.before.length} : undefined,
    cursor: {line: edit.line, col: g < edit.type ? edit.from + edit.before.length : edit.from + typed},
  };
};
const THEME_EDIT: Edit = {line: 5, from: 10, before: "'#C5B5EC'", after: "'#A1DDBD'", select: 742, type: 750};
const DART_EDIT: Edit = {line: 9, from: 6, before: `'${BLOOM_GREETING[0]}'`, after: `'${BLOOM_GREETING[1]}'`, select: 970, type: 976};
const TSX_EDIT: Edit = {line: 3, from: 15, before: `'${PULSE_ACCENT[0].toUpperCase()}'`, after: `'${PULSE_ACCENT[1].toUpperCase()}'`, select: 1094, type: 1100};
const SWIFT_EDIT: Edit = {line: 9, from: 8, before: '', after: 'let launches: Int = "first"', select: 9999, type: 1144};
const FIX_EDIT: Edit = {line: 9, from: 28, before: '"first"', after: '1', select: 1258, type: 1266};

/* ---------- Runs: each one's steps and Debug Console, keyed to the frame they finish on ---------- */

type Step = readonly [label: string, detail: string, how?: 'skip' | 'fail'];
type Run = {app: 'orbit' | 'bloom' | 'pulse'; from: number; every: number; steps: readonly Step[]; lines: readonly (readonly [number, ConsoleLine])[]};
const ORBIT_STEPS = (xcode: string): Step[] => [['Web build', 'dev server', 'skip'], ['Copy to Mac', '0.3 s · 1 file uploaded'], ['Packages', 'unchanged', 'skip'], ['cap sync', '0.4 s'], ['Xcode build', xcode], ['Simulator', 'already on', 'skip'], ['Install', '2.1 s'], ['Open app', '2.7 s']];
const HELP: ConsoleLine = {kind: 'dim', text: 'Type r to reload, R to restart, b to rebuild, s for a screenshot, q to stop, or help'};

const RUNS: Run[] = [
  {app: 'orbit', from: T.live, every: 15, steps: ORBIT_STEPS('18 s'), lines: [
    [0, {kind: 'start', text: 'Live Orbit on iPhone 17 Pro'}], [1, HELP],
    [15, {kind: 'skip', text: 'Web build: dev server at http://localhost:5173'}],
    [30, {kind: 'step', text: 'Syncing Orbit to Mac mini', detail: '1 file uploaded · 0.3 s'}],
    [45, {kind: 'skip', text: 'Packages: unchanged'}],
    [60, {kind: 'step', text: 'Running cap sync', detail: '0.4 s'}],
    [75, {kind: 'step', text: 'Running Xcode build', detail: '18 s'}],
    [90, {kind: 'skip', text: 'Simulator: already booted'}],
    [105, {kind: 'step', text: 'Installing Orbit', detail: '2.1 s'}],
    [120, {kind: 'step', text: 'Launching Orbit', detail: '2.7 s'}],
    [121, {kind: 'running', text: 'Orbit is running on iPhone 17 Pro'}],
    [126, {kind: 'app', tag: 'cap', text: 'Loading app at capacitor://localhost…'}],
    [132, {kind: 'app', tag: 'js', text: 'Orbit mounted { platform: "ios", ready: true }'}],
    [T.themeSave + 8 - T.live, {kind: 'reload', text: '[vite] (client) hmr update /src/theme.ts'}],
    [T.tap + 4 - T.live, {kind: 'app', tag: 'js', text: 'Showing Activity { month: "October" }'}],
  ]},
  {app: 'bloom', from: T.bloom, every: 8, steps: [['Copy to Mac', '0.3 s · 76 files uploaded'], ['Flutter and packages', 'up to date', 'skip'], ['Simulator', 'already on', 'skip'], ['Xcode build', '29 s'], ['Open app', '9.6 s']], lines: [
    [0, {kind: 'start', text: 'Live Bloom on iPhone 17 Pro'}], [1, HELP],
    [8, {kind: 'step', text: 'Syncing Bloom to Mac mini', detail: '76 files uploaded (309.0 KB) · 0.3 s'}],
    [16, {kind: 'skip', text: 'Flutter and packages: Flutter 3.47.7 is ready on Mac mini'}],
    [24, {kind: 'skip', text: 'Simulator: already booted'}],
    [32, {kind: 'step', text: 'Running Xcode build', detail: '29 s'}],
    [36, {kind: 'app', tag: 'app', text: '[IMPORTANT:flutter/shell/platform/darwin/graphics/FlutterDarwinContextMetalImpeller.mm(45)] Using the Impeller rendering backend (Metal)'}],
    [40, {kind: 'step', text: 'Launching Bloom', detail: '9.6 s'}],
    [41, {kind: 'running', text: 'Bloom is running on iPhone 17 Pro'}],
    [44, {kind: 'app', tag: 'dart', text: 'Bloom ready on ios'}],
    [T.bloomSave + 6 - T.bloom, {kind: 'reload', text: 'home.dart: Reloaded 1 of 844 libraries'}],
  ]},
  {app: 'pulse', from: T.pulse, every: 6, steps: [['Metro', 'dev server', 'skip'], ['Copy to Mac', '1.2 s · 214 files uploaded'], ['Packages and pods', '52 s'], ['Simulator', 'already on', 'skip'], ['Xcode build', '2 min 19 s'], ['Install', '1.8 s'], ['Open app', '3.1 s']], lines: [
    [0, {kind: 'start', text: 'Live Pulse on iPhone 17 Pro'}], [1, {kind: 'dim', text: 'Type r to reload, j for DevTools, R to restart, b to rebuild, s for a screenshot, q to stop, or help'}],
    [6, {kind: 'skip', text: 'Metro: running on this PC at http://localhost:8081'}],
    [12, {kind: 'step', text: 'Syncing Pulse to Mac mini', detail: '214 files uploaded · 1.2 s'}],
    [18, {kind: 'step', text: 'Installing packages and pods', detail: '52 s'}],
    [24, {kind: 'skip', text: 'Simulator: already booted'}],
    [30, {kind: 'step', text: 'Running Xcode build', detail: '2 min 19 s'}],
    [36, {kind: 'step', text: 'Installing Pulse', detail: '1.8 s'}],
    [42, {kind: 'step', text: 'Launching Pulse', detail: '3.1 s'}],
    [43, {kind: 'running', text: 'Pulse is running on iPhone 17 Pro'}],
    [48, {kind: 'app', tag: 'js', text: 'Pulse ready { steps: 8214 }'}],
    [T.pulseSave + 6 - T.pulse, {kind: 'reload', text: 'Refreshed at 09:44:02'}],
  ]},
  {app: 'orbit', from: T.swiftSave + 2, every: 7, steps: [['Web build', 'dev server', 'skip'], ['Copy to Mac', '0.2 s · 1 file uploaded'], ['Packages', 'unchanged', 'skip'], ['cap sync', 'unchanged', 'skip'], ['Xcode build', 'failed', 'fail'], ['Simulator', ''], ['Install', ''], ['Open app', '']], lines: [
    [0, {kind: 'dim', text: 'Native files changed (AppDelegate.swift), rebuilding'}],
    [14, {kind: 'step', text: 'Syncing Orbit to Mac mini', detail: '1 file uploaded · 0.2 s'}],
    [35, {kind: 'error', text: "AppDelegate.swift:9:29: error: cannot convert value of type 'String' to specified type 'Int'"}],
    [36, {kind: 'error', text: 'Failed after 0:12'}],
  ]},
  {app: 'orbit', from: T.fixSave + 2, every: 6, steps: [['Web build', 'dev server', 'skip'], ['Copy to Mac', '0.2 s · 1 file uploaded'], ['Packages', 'unchanged', 'skip'], ['cap sync', 'unchanged', 'skip'], ['Xcode build', '14 s'], ['Simulator', 'already on', 'skip'], ['Install', '1.9 s'], ['Open app', '2.4 s']], lines: [
    [0, {kind: 'dim', text: 'Native files changed (AppDelegate.swift), rebuilding'}],
    [12, {kind: 'step', text: 'Syncing Orbit to Mac mini', detail: '1 file uploaded · 0.2 s'}],
    [30, {kind: 'step', text: 'Running Xcode build', detail: '14 s'}],
    [42, {kind: 'step', text: 'Installing Orbit', detail: '1.9 s'}],
    [48, {kind: 'step', text: 'Launching Orbit', detail: '2.4 s'}],
    [49, {kind: 'running', text: 'Orbit is running on iPhone 17 Pro'}],
  ]},
];
const FAIL_AT = RUNS[3].from + 35;

const currentApp = (g: number) => g >= T.swift ? 'orbit' : g >= T.pulse ? 'pulse' : g >= T.bloom ? 'bloom' : 'orbit';
const runOf = (g: number) => [...RUNS].reverse().find(run => run.from <= g && run.app === currentApp(g));
const stepState = (run: Run, i: number, g: number) => {
  const done = run.from + (i + 1) * run.every;
  const step = run.steps[i];
  const failedBefore = run.steps.findIndex(s => s[2] === 'fail');
  if (failedBefore >= 0 && i > failedBefore && g >= run.from + (failedBefore + 1) * run.every) return 'pending' as const;
  if (g >= done) return step[2] === 'fail' ? 'failed' as const : step[2] === 'skip' ? 'skipped' as const : 'done' as const;
  return g >= run.from + i * run.every ? 'running' as const : 'pending' as const;
};
const consoleOf = (g: number): ConsoleLine[] => RUNS.filter(run => run.app === currentApp(g) && (run.app !== 'orbit' || (run.from < T.bloom) === (g < T.bloom) || g >= T.swift)).flatMap(run => run.lines.filter(([t]) => g >= run.from + t).map(([, line]) => line));
const NAMES = {orbit: 'Orbit', bloom: 'Bloom', pulse: 'Pulse'};
const KINDS = {orbit: 'Capacitor · iOS app', bloom: 'Flutter · iOS app', pulse: 'React Native · iOS app'};
const launched = (g: number) => {const run = runOf(g); return run ? g >= run.from + run.steps.length * run.every && !run.steps.some(step => step[2] === 'fail') : false;};

/* ---------- The side bar ---------- */

const Explorer = () => <div style={{fontSize: 13}}>
  <Row twistie="open" label={<b style={{fontSize: 11}}>APPS (WORKSPACE)</b>}/>
  <Row depth={1} twistie="open" label="orbit"/>
  <Row depth={2} twistie="closed" label="ios"/>
  <Row depth={2} twistie="closed" label="node_modules"/>
  <Row depth={2} twistie="closed" label="src"/>
  <Row depth={2} icon={<FileIcon lang="ts"/>} label="capacitor.config.ts" selected/>
  <Row depth={2} icon={<FileIcon lang="json"/>} label="package.json"/>
  <Row depth={1} twistie="closed" label="bloom"/>
  <Row depth={1} twistie="closed" label="pulse"/>
</div>;

const APP_ROWS: {group?: string; app?: 'orbit' | 'bloom' | 'pulse'; desc?: string; id?: string}[] = [
  {group: 'orbit'}, {app: 'orbit', desc: 'Capacitor · iPhone and iPad', id: 'orbit-ios'}, {app: 'orbit', desc: 'Electron · Mac desktop', id: 'orbit-electron'},
  {group: 'bloom'}, {app: 'bloom', desc: 'Flutter · iPhone and iPad', id: 'bloom-ios'}, {app: 'bloom', desc: 'Flutter · Mac desktop', id: 'bloom-mac'}, {app: 'bloom', desc: 'Flutter · This PC', id: 'bloom-pc'},
  {group: 'pulse'}, {app: 'pulse', desc: 'React Native · iPhone and iPad', id: 'pulse-ios'},
];
const RUN_HEIGHT = 286;
const APPS_HEIGHT = 222;

const CapMacSide = ({g}: {g: number}) => {
  const app = currentApp(g);
  const run = g >= T.live ? runOf(g) : undefined;
  const failed = g >= FAIL_AT && g < T.fixSave + 2;
  const live = run && launched(g);
  const hover = g >= 902 && g < 920 ? 'bloom-ios' : g >= 1032 && g < 1048 ? 'pulse-ios' : undefined;
  const selectedApp = g >= T.pulse && g < T.swift ? 'pulse-ios' : g >= T.bloom && g < T.pulse ? 'bloom-ios' : 'orbit-ios';
  const devicesOnly = g >= T.devices && g < T.chat;
  const sessionDesc = failed ? 'Failed · 0:12' : !run ? '' : !live ? 'In progress…' : app === 'bloom' && g >= T.bloomSave ? 'Hot-reloaded at 09:43:12' : app === 'pulse' && g >= T.pulseSave ? 'Updated at 09:44:02' : g >= T.themeSave + 8 && app === 'orbit' ? 'Updated at 09:41:08' : 'App running';
  const shown = (i: number) => r(g, T.capmac + 8 + i * 5, T.capmac + 14 + i * 5);
  return <>
    <Section title="Run" desc={NAMES[app]} open={!devicesOnly} height={devicesOnly ? 23 : RUN_HEIGHT}>
      <Row icon={<AppIcon app={app} size={16}/>} label={NAMES[app]} desc={KINDS[app]}/>
      <Row icon={<Codicon name="device-mobile"/>} label="iPhone 17 Pro" desc="Mac mini · auto · iOS 26.5"/>
      {!run ? <Row icon={<Codicon name="info" color={VS.dim}/>} label={<span>▶ Run, or <span style={{color: '#cca700'}}>⚡</span> Live to reload on save</span>}/> : <>
        <Row twistie="open" icon={failed ? <Codicon name="error" color={VS.error}/> : live ? <Codicon name="zap" color="#73c991"/> : <Codicon name="loading"/>} label="Live on iPhone 17 Pro" desc={sessionDesc}/>
        {run.steps.map((step, i) => {const state = stepState(run, i, g); return <Row key={step[0]} depth={1} icon={<StepIcon state={state}/>} label={step[0]} desc={state === 'done' || state === 'skipped' || state === 'failed' ? step[1] : state === 'running' ? 'in progress' : ''}/>;})}
      </>}
    </Section>
    <Section title="Apps" open={!devicesOnly} height={devicesOnly ? 23 : APPS_HEIGHT} actions={<><Codicon name="beaker" size={16}/><Codicon name="refresh" size={16}/></>}>
      {APP_ROWS.map((row, i) => row.group
        ? <Row key={row.group} twistie="open" label={row.group} style={{opacity: shown(i)}}/>
        : <Row key={row.id} depth={1} icon={<AppIcon app={row.app!} size={16}/>} label={NAMES[row.app!]} desc={row.desc} selected={row.id === selectedApp && g >= T.capmac + 50} focused={row.id === hover} style={{opacity: shown(i)}} actions={row.id === hover ? <><Codicon name="play" size={15}/><Codicon name="zap" size={15}/></> : undefined}/>)}
    </Section>
    <Section title="Devices" actions={<><Codicon name="add" size={16}/><Codicon name="refresh" size={16}/></>}>
      <div style={{opacity: r(g, T.capmac + 40, T.capmac + 52)}}>
        <Row twistie="open" icon={<Codicon name="vm" color="#73c991"/>} label="Mac mini" desc="Connected · 24 ms · default"/>
        <Row depth={1} twistie={devicesOnly ? 'open' : 'closed'} icon={<Codicon name="device-mobile"/>} label="Simulators" desc="1 booted"/>
        {devicesOnly && <>
          <Row depth={2} icon={<Codicon name="device-mobile"/>} label="iPhone 17 Pro" desc="iOS 26.5 · Running"/>
          <Row depth={2} icon={<Codicon name="device-mobile"/>} label="iPhone 17" desc="iOS 26.5 · Off"/>
          <Row depth={2} icon={<Codicon name="device-mobile"/>} label="iPhone Air" desc="iOS 26.5 · Off"/>
          <Row depth={2} icon={<Codicon name="device-mobile"/>} label="iPad Air 13-inch (M4)" desc="iOS 26.5 · Off"/>
          <Row depth={1} twistie="open" icon={<Codicon name="plug"/>} label="iPhones and iPads"/>
          <Row depth={2} icon={<Codicon name="device-mobile"/>} label="Sam’s iPhone" desc="iOS 26.6 · Connected · Wi-Fi"/>
          <Row depth={1} icon={<Codicon name="vm"/>} label="Mac desktop" selected={g >= T.macApp - 12 && g < T.macApp + 20} focused={g >= T.macApp - 12 && g < T.macApp + 20} actions={g >= T.macApp - 12 && g < T.macApp + 20 ? <Codicon name="play" size={15}/> : undefined}/>
          <Row depth={1} twistie="closed" icon={<Codicon name="pass" color="#73c991"/>} label="Health" desc="Done"/>
          <Row twistie="open" icon={<Codicon name="window"/>} label="This PC" desc="Windows"/>
          <Row depth={1} icon={<Codicon name="window"/>} label="Windows desktop"/>
          <Row depth={1} twistie="open" icon={<Codicon name="device-mobile"/>} label="iPhones (no Mac)" desc="Needs setup" selected={g >= 1372 && g < T.macApp - 14} focused={g >= 1372 && g < T.macApp - 14}/>
          <Row depth={2} icon={<Codicon name="desktop-download" color="#cca700"/>} label="Set up this PC…"/>
        </>}
      </div>
    </Section>
  </>;
};

/* ---------- The editor area ---------- */

/** The chat opens on the right and both editor groups give it room */
const chatWidth = (g: number) => g >= T.chat && g < T.wide ? 420 * ease(g, T.chat, T.chat + 14) * (1 - ease(g, T.wide - 14, T.wide)) : 0;
const leftWidth = (g: number) => 640 - chatWidth(g) * .6;
const rightWidth = (g: number) => 612 - chatWidth(g) * .4;

const Lens = ({g}: {g: number}) => {
  const running = g >= T.live;
  const hover = g >= 410 && g < T.live;
  return <span style={{display: 'flex', gap: 6, opacity: r(g, T.activate, T.activate + 12)}}>
    {running ? <><span>● Live on iPhone 17 Pro</span><span>|</span><span>■ Stop</span><span>|</span><span>Show screen</span></> : <><span>▶ Run on iPhone 17 Pro</span><span>|</span><span style={{color: hover ? '#4daafc' : undefined, textDecoration: hover ? 'underline' : undefined}}>⚡ Live</span></>}
  </span>;
};

const LeftEditor = ({g}: {g: number}) => {
  const config: Tab = {label: 'capacitor.config.ts', icon: <FileIcon lang="ts"/>};
  let tabs: Tab[] = [config];
  let crumbs = ['orbit', 'capacitor.config.ts'];
  let body: React.ReactNode = <CodeEditor lines={CONFIG_TS} lang="ts" frame={g} lens={<Lens g={g}/>} active={1}/>;
  if (g >= T.theme && g < T.bloom + 14) {
    const edit = edited(THEME_TS, THEME_EDIT, g);
    tabs = [{label: 'theme.ts', icon: <FileIcon lang="ts"/>, dirty: g >= THEME_EDIT.type && g < T.themeSave}, config];
    crumbs = ['orbit', 'src', 'theme.ts'];
    body = <CodeEditor lines={edit.lines} lang="ts" frame={g} selection={edit.selection} cursor={edit.cursor}/>;
  } else if (g >= T.bloom + 14 && g < T.pulse + 14) {
    const edit = edited(HOME_DART, DART_EDIT, g);
    tabs = [{label: 'home.dart', icon: <FileIcon lang="dart"/>, dirty: g >= DART_EDIT.type && g < T.bloomSave}];
    crumbs = ['bloom', 'lib', 'home.dart'];
    body = <CodeEditor lines={edit.lines} lang="dart" frame={g} selection={edit.selection} cursor={edit.cursor}/>;
  } else if (g >= T.pulse + 14 && g < T.swift) {
    const edit = edited(APP_TSX, TSX_EDIT, g);
    tabs = [{label: 'App.tsx', icon: <FileIcon lang="tsx"/>, dirty: g >= TSX_EDIT.type && g < T.pulseSave}];
    crumbs = ['pulse', 'App.tsx'];
    body = <CodeEditor lines={edit.lines} lang="ts" frame={g} selection={edit.selection} cursor={edit.cursor}/>;
  } else if (g >= T.swift) {
    const first = edited(DELEGATE_SWIFT, SWIFT_EDIT, g);
    const fixed = g >= FIX_EDIT.select ? edited(first.lines, FIX_EDIT, g) : first;
    const broken = g >= FAIL_AT && g < T.fixSave + 2;
    tabs = [{label: 'AppDelegate.swift', icon: <FileIcon lang="swift"/>, dirty: (g >= SWIFT_EDIT.type && g < T.swiftSave) || (g >= FIX_EDIT.type && g < T.fixSave)}, {label: 'theme.ts', icon: <FileIcon lang="ts"/>}];
    crumbs = ['orbit', 'ios', 'App', 'App', 'AppDelegate.swift'];
    body = <CodeEditor lines={fixed.lines} lang="swift" frame={g} selection={fixed.selection} cursor={g >= T.problem && g < FIX_EDIT.select ? {line: 9, col: 28} : fixed.cursor} squiggle={broken ? {line: 9, from: 28, to: 35} : undefined}/>;
  }
  return <div style={{width: g >= T.screen ? leftWidth(g) : '100%', flexShrink: 0, borderRight: `1px solid ${VS.border}`, display: 'flex', flexDirection: 'column', background: VS.bg, minWidth: 0}}>
    <Tabs tabs={tabs} active={0}/>
    <div style={{height: 22, display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', fontSize: 12.5, color: VS.dim, flexShrink: 0}}>{crumbs.map((crumb, i) => <React.Fragment key={i}>{i > 0 && <Codicon name="chevron-right" size={14}/>}{crumb}</React.Fragment>)}</div>
    <div style={{flex: 1, overflow: 'hidden'}}>{body}</div>
  </div>;
};

const PHONE_SCALE = .82;
const ScreenContent = ({g}: {g: number}) => {
  const app = currentApp(g);
  const run = runOf(g);
  const opened = run ? run.from + run.steps.length * run.every : T.launch;
  const home = <Handset dark screen="#000" outline><HomeScreen/></Handset>;
  if (app === 'bloom') return g < opened ? home : <BloomPhone frame={g - opened} outline reloaded={g >= T.bloomSave + 4} flash={g >= T.bloomSave + 4 ? g - T.bloomSave - 4 : -1}/>;
  if (app === 'pulse') return g < opened ? home : <PulsePhone frame={g - opened} outline refreshed={g >= T.pulseSave + 4}/>;
  if (g < T.launch) return home;
  return <Phone frame={g - T.launch} outline variant={g >= T.themeSave + 8 ? 'mint' : 'violet'} view={g >= T.tap ? 'activity' : 'home'} tapFrame={g - T.tap}/>;
};

const RightEditor = ({g}: {g: number}) => {
  const macApp = g >= T.macApp && g < T.chat;
  const name = macApp ? 'Bloom' : 'iPhone 17 Pro';
  const changing = [T.launch, T.themeSave + 8, T.tap, T.bloom + 40, T.bloomSave + 4, T.pulse + 42, T.pulseSave + 4, T.macApp].some(when => g >= when && g < when + 24);
  const run = runOf(g);
  const sheen = run && currentApp(g) !== 'orbit' ? run.from + run.steps.length * run.every : T.launch;
  return <div style={{width: rightWidth(g), flexShrink: 0, display: 'flex', flexDirection: 'column', opacity: r(g, T.screen, T.screen + 8), background: VS.bg}}>
    <Tabs tabs={[{label: name, icon: <Codicon name={macApp ? 'window' : 'device-mobile'} size={14}/>}]} active={0}/>
    <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>
      {macApp
        ? <ScreenTab name={name} fps={changing ? 60 : 1} width={rightWidth(g)} height={VS_EDITOR_H - 35} frame={g} fill><div style={{width: 900 * .62, height: 600 * .62}}><div style={{transform: 'scale(.62)', transformOrigin: '0 0'}}><MacWindow title="Bloom" width={900} height={600}><BloomDesktop width={900} height={570} reloaded/></MacWindow></div></div></ScreenTab>
        : <ScreenTab name={name} fps={changing ? 60 : 1} width={rightWidth(g)} height={VS_EDITOR_H - 35} phoneScale={PHONE_SCALE} sheenAt={sheen} frame={g}><div style={{transform: `scale(${PHONE_SCALE})`, transformOrigin: '0 0'}}><ScreenContent g={g}/></div></ScreenTab>}
    </div>
  </div>;
};

const PANEL_H = 270;
const VS_EDITOR_H = 920 - 35 - 22 - PANEL_H;

/* ---------- Panel, status bar and chat ---------- */

const ProblemsList = ({g}: {g: number}) => {
  const selected = g >= T.problem;
  return <div style={{padding: '4px 0', fontSize: 13}}>
    <Row twistie="open" icon={<Codicon name="file-code" color="#f05138"/>} label={<span>AppDelegate.swift <span style={{color: VS.dim, fontSize: 12}}>orbit · ios\App\App</span></span>} actions={<span style={{minWidth: 18, height: 18, borderRadius: 9, background: '#4d4d4d', color: '#fff', fontSize: 11, display: 'grid', placeItems: 'center'}}>1</span>}/>
    <Row depth={1} icon={<Codicon name="error" color={VS.error}/>} label={<span>cannot convert value of type 'String' to specified type 'Int' <span style={{color: VS.dim}}>CapMac [Ln 9, Col 29]</span></span>} selected={selected} focused={selected}/>
    <div style={{paddingLeft: 66, fontFamily: codeFont, fontSize: 13, color: '#d4d4d4', lineHeight: '20px', marginTop: 2}}>let launches: Int = "first"<br/><span style={{color: VS.error}}>{'                    ^~~~~~~'}</span></div>
  </div>;
};

const statusOf = (g: number): StatusItem[] => {
  if (g < T.activate) return [];
  const app = currentApp(g);
  const items: StatusItem[] = [{icon: 'package', text: `${NAMES[app]} · iPhone and iPad`}, {icon: 'device-mobile', text: 'iPhone 17 Pro'}];
  const run = g >= T.live ? runOf(g) : undefined;
  if (!run) return items;
  if (g >= FAIL_AT && g < T.fixSave + 2) return [...items, {icon: 'error', text: 'Build failed', tone: 'error'}];
  const now = ['Copying to the Mac', 'Installing packages', 'Running cap sync', 'Building', 'Installing', 'Opening the app'];
  return [...items, launched(g) ? {icon: 'zap', text: 'Live on iPhone 17 Pro'} : {icon: 'sync', text: now[Math.min(now.length - 1, Math.floor((g - run.from) / Math.max(1, run.every * 1.4)))]}];
};

const Chat = ({g}: {g: number}) => {
  const step = (t: number) => r(g, t, t + 8);
  return <ChatPanel>
    <ChatMessage who="Sam" opacity={step(T.chat + 10)}>Run my app, open the Activity screen and tell me if anything looks broken</ChatMessage>
    <ChatMessage who="GitHub Copilot" agent opacity={step(T.chat + 26)}>
      <div>I’ll run Orbit with CapMac and check the screen</div>
      {g < T.chat + 62 ? <ToolConfirm title="Run the app with CapMac?" message="Starts live reload of Orbit on iPhone 17 Pro" pressed={g >= T.chat + 56} opacity={step(T.chat + 34)}/> : <ToolRow label="Run the app" tool="capmacRun" running={g < T.chat + 76}/>}
      <ToolRow label="Screenshot of the app" tool="capmacScreenshot" opacity={step(T.chat + 80)}/>
      {g >= T.chat + 88 && <div style={{width: 92, height: 184, borderRadius: 12, overflow: 'hidden', margin: '4px 0 8px 22px', opacity: step(T.chat + 88), boxShadow: '0 6px 16px #0008'}}><div style={{transform: 'scale(.3067)', transformOrigin: '0 0'}}><Phone frame={70} variant="mint" view="activity" tapFrame={40}/></div></div>}
      <ToolRow label="The app’s console" tool="capmacLogs" opacity={step(T.chat + 104)}/>
      <div style={{marginTop: 10, opacity: step(T.chat + 120)}}>Orbit runs on iPhone 17 Pro. The Activity screen shows its chart, both transactions and the tab bar, and the console has no errors</div>
    </ChatMessage>
  </ChatPanel>;
};

const viewAt = (g: number): VSView => {
  const chatOpen = chatWidth(g) > 0;
  return {
    frame: g, title: 'apps (Workspace)', activity: g >= T.capmac ? 'capmac' as const : 'explorer' as const,
    sideTitle: g >= T.capmac ? 'CapMac' : 'Explorer', side: g >= T.capmac ? <CapMacSide g={g}/> : <Explorer/>,
    editor: <><LeftEditor g={g}/>{g >= T.screen && <RightEditor g={g}/>}</>,
    panel: g >= T.live ? <div style={{height: PANEL_H, transform: `translateY(${(1 - ease(g, T.live, T.live + 14)) * PANEL_H}px)`}}>
      {g >= FAIL_AT + 2 && g < T.problem + 30
        ? <Panel tab="Problems" problems={1} height={PANEL_H}><ProblemsList g={g}/></Panel>
        : <Panel tab="Debug Console" problems={g >= FAIL_AT && g < T.fixSave + 2 ? 1 : 0} height={PANEL_H}><DebugConsole lines={consoleOf(g)} height={PANEL_H - 38}/></Panel>}
    </div> : undefined,
    panelHeight: PANEL_H,
    debugging: g >= T.live + 2,
    errors: g >= FAIL_AT && g < T.fixSave + 2 ? 1 : 0,
    status: statusOf(g),
    debugToolbar: g >= T.live + 2 ? {opacity: r(g, T.live + 2, T.live + 12), left: 400, hot: currentApp(g) === 'bloom'} : undefined,
    chat: chatOpen ? {width: chatWidth(g), content: <Chat g={g}/>} : undefined,
    capmacGlow: g >= T.activate && g < T.capmac + 6 ? .5 + .5 * Math.sin((g - T.activate) / 3) : 0,
    overlay: g >= T.toast && g < T.wide + 30 ? <div style={{position: 'absolute', right: 14, bottom: 34, zIndex: 30}}><Toast opacity={r(g, T.toast, T.toast + 10) * (1 - r(g, T.wide + 18, T.wide + 30))} message="CapMac added its skill to orbit, bloom and pulse. Claude Code and Codex can now run and check your apps" actions={['Show', 'Undo']}/></div> : undefined,
  };
};

/* ---------- Camera, cursor and captions ---------- */

/** A camera framing a point of the window; `side` and `edge` keep the window's left or right edge 40 px inside the frame */
const shot = (frame: number, x: number, y: number, scale: number): CameraKey => ({at: frame, x: X + x, y: Y + y, scale});
const hold = (frame: number, x: number, y: number, scale: number): CameraKey => ({...shot(frame, x, y, scale), drift: true});
const side = (scale: number) => 920 / scale;
const edge = (scale: number) => 1600 - 920 / scale;
const top = (scale: number) => 500 / scale;
const bottom = (scale: number) => 920 - 500 / scale;

/** Where things are in the window: rows are 22 px, code lines 19 px from y 98, a character 7.7 px from x 412 */
const ROW = {apps: 70 + RUN_HEIGHT + 22, devices: 70 + 23 + 23 + 23};
const code = (line: number, col: number) => at(412 + col * 7.7, 98 + (line - 1) * 19 + 10);

const CAMERA: CameraKey[] = [
  {at: 0, x: 960, y: 600, scale: .9}, {at: 214, x: 960, y: 590, scale: .94}, {at: 260, x: 960, y: 590, scale: .95},
  // CapMac wakes up: its icon glows and Run and Live appear above the config
  shot(278, side(1.22), 420, 1.22), shot(296, side(1.22), 420, 1.22),
  // The CapMac view fills in
  shot(314, side(1.45), top(1.45), 1.45), hold(378, side(1.45), top(1.45) + 6, 1.45),
  // ⚡ Live through the riser, held on the click
  shot(404, 571, 250, 1.95), hold(476, 571, 238, 2.2), shot(486, 571, 238, 2.2),
  // Every step in the Run view, the Debug Console filling
  shot(504, side(1.25), 460, 1.25), hold(584, side(1.25), 466, 1.25),
  // The screen opens beside the code
  shot(604, edge(1.5), top(1.5), 1.5), hold(712, edge(1.5), top(1.5) + 6, 1.5),
  // theme.ts, then the app reloading and the Activity tap
  shot(728, 775, top(1.6), 1.6), shot(768, 775, top(1.6), 1.6),
  shot(784, edge(1.3), 490, 1.3), hold(896, edge(1.3), 496, 1.3),
  // Bloom in the Apps view, then its code, screen and console, held on the hot reload
  shot(908, side(1.55), 470, 1.55), shot(926, side(1.55), 470, 1.55),
  shot(946, 800, 466, 1.2), hold(1030, 800, 470, 1.2),
  // Pulse the same way
  shot(1040, side(1.55), 530, 1.55), shot(1052, side(1.55), 530, 1.55),
  shot(1072, 800, 466, 1.2), hold(1136, 800, 470, 1.2),
  // A change to AppDelegate.swift, the error in Problems, the fix
  shot(1150, 853, top(1.55), 1.55), hold(1200, 853, top(1.55) + 6, 1.55),
  shot(1214, 700, bottom(1.45), 1.45), shot(1248, 700, bottom(1.45), 1.45),
  shot(1260, 853, top(1.55), 1.55), hold(1312, 853, top(1.55) + 6, 1.55),
  // Devices and this PC, then a Mac app's window
  shot(1330, side(1.45), top(1.45), 1.45), hold(1406, side(1.45), top(1.45) + 6, 1.45),
  shot(1428, edge(1.35), top(1.35), 1.35), hold(1494, edge(1.35), top(1.35) + 6, 1.35),
  // The agent's chat, then the notification
  shot(1514, edge(1.45), top(1.45), 1.45), hold(1640, edge(1.45), top(1.45) + 10, 1.45),
  shot(1660, edge(1.5), bottom(1.5), 1.5), shot(1724, edge(1.5), bottom(1.5), 1.5),
  {at: 1752, x: 960, y: 590, scale: .97}, {at: 1880, x: 960, y: 590, scale: .93, drift: true},
];

const CURSOR = [
  {at: 246, ...at(900, 640)}, {at: 282, ...at(24, 299)}, {at: 294, ...at(24, 299)},
  {at: 330, ...at(190, 420)}, {at: 380, ...at(250, 300)}, {at: 404, ...at(571, 110)}, {at: 486, ...at(573, 110)},
  {at: 520, ...at(230, 250)}, {at: 600, ...at(1180, 300)}, {at: 724, ...at(1150, 330)},
  {at: 738, ...code(5, 14.5)}, {at: 790, ...code(5, 14.5)},
  {at: 826, ...at(1264, 531)}, {at: 848, ...at(1264, 531)},
  {at: 900, ...at(332, ROW.apps + 4 * 22 + 11)}, {at: 926, ...at(332, ROW.apps + 4 * 22 + 11)},
  {at: 962, ...code(9, 13)}, {at: 1006, ...code(9, 13)},
  {at: 1034, ...at(332, ROW.apps + 8 * 22 + 11)}, {at: 1054, ...at(332, ROW.apps + 8 * 22 + 11)},
  {at: 1086, ...code(3, 19.5)}, {at: 1122, ...code(3, 19.5)},
  {at: 1140, ...at(640, 300)}, {at: 1214, ...at(640, 300)},
  {at: 1228, ...at(600, 700)}, {at: 1246, ...at(600, 700)},
  {at: 1252, ...code(9, 31.5)}, {at: 1300, ...code(9, 31.5)},
  {at: 1350, ...at(200, ROW.devices + 13 * 22 + 11)}, {at: 1400, ...at(200, ROW.devices + 12 * 22 + 11)},
  {at: 1410, ...at(332, ROW.devices + 8 * 22 + 11)}, {at: 1422, ...at(332, ROW.devices + 8 * 22 + 11)},
  {at: 1530, ...at(1249, 311)}, {at: 1560, ...at(1249, 311)},
  {at: 1600, ...at(1100, 560)}, {at: 1700, ...at(1100, 560)},
];
const CLICKS = [288, 480, 742, 838, 916, 970, 1044, 1094, 1236, 1258, 1418, 1556];

const CAPTIONS: readonly (readonly [number, string, string?])[] = [
  [250, 'Open your app’s folder', 'Capacitor, Ionic, Flutter, React Native or Electron'],
  [318, 'CapMac finds the apps in it', 'Several folders or a monorepo too, with nothing to set up'],
  [400, 'Then press ⚡ Live', '▶ Run and ⚡ Live sit above your config, on the status bar and in the CapMac view'],
  [492, 'Every run is a debug session', 'Each build step shows in the Run view as it happens'],
  [598, 'The simulator opens beside your code', 'Smooth video at about 60 frames a second'],
  [722, 'Save, and the app updates', 'Your dev server keeps running on this PC'],
  [812, 'Click, scroll and type on it', 'Your mouse and keyboard work on the simulator'],
  [906, 'Flutter hot-reloads', 'Your app keeps its state'],
  [1036, 'React Native gets Fast Refresh', 'Metro runs on this PC, so a save shows at once'],
  [1142, 'Change native code', 'CapMac rebuilds the app by itself'],
  [1206, 'Xcode errors land in Problems', 'A click opens the line, in your files on this PC'],
  [1322, 'Your Mac, its simulators and your iPhone', 'Start and stop simulators, check the Mac and fix what’s missing'],
  [1372, 'No Mac? This PC builds it', 'It signs your app and installs it on an iPhone plugged into this PC'],
  [1422, 'Mac and Windows apps too', 'A Mac app’s window shows right here in VS Code'],
  [1502, 'Your AI agent can run it too', 'Copilot’s agent mode runs the app, looks at the screen and reads the console'],
  [1652, 'Claude Code, Codex and more', 'CapMac adds its skill to your project for the agents it finds'],
  [1744, 'Your whole loop, in VS Code', 'Run it, see it and fix it without leaving your editor'],
];
const SAVES = [T.themeSave, T.bloomSave, T.pulseSave, T.swiftSave, T.fixSave];

const Captions = ({g}: {g: number}) => {
  const current = CAPTIONS.filter(([start]) => g >= start).at(-1);
  if (!current || g >= T.leave) return null;
  const [start, text, detail] = current;
  return <div style={{opacity: 1 - r(g, T.leave - 12, T.leave)}}><Caption frame={g - start} text={text} detail={detail}/></div>;
};

/* ---------- Opening and closing ---------- */

const HEADLINE: React.CSSProperties = {fontSize: 100, fontWeight: 600, letterSpacing: -3.6, lineHeight: 1.06, justifyContent: 'center'};
const gradient = (from: string, to: string): React.CSSProperties => ({backgroundImage: `linear-gradient(90deg, ${from}, ${to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent'});

// The first frame is the thumbnail GitHub shows, so the promise is on screen from it and the title only drifts
const Hook = () => {
  const f = useCurrentFrame();
  const lift = ease(f, 150, 210);
  return <AbsoluteFill style={{opacity: 1 - r(f, 196, 226)}}>
    <div style={{position: 'absolute', left: 78, top: 56}}><Brand suffix="for VS Code"/></div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 300 - lift * 200, transform: `scale(${(1 - lift * .35) * (1 + Math.min(f, 150) / 4200)})`, transformOrigin: '50% 0'}}>
      <Words frame={f} from={-60} text="Your iPhone app" style={HEADLINE}/>
      <Words frame={f} from={-60} text="in VS Code" style={HEADLINE} wordStyle={(_, i) => i === 0 ? gradient('#e3ddff', '#b9c8ff') : i === 1 ? gradient('#a9c3ff', '#6fb1ff') : gradient('#6fb1ff', '#8fd0ff')}/>
      <Words frame={f} from={-60} text="On Windows, with your Mac or with no Mac at all" style={{fontSize: 36, color: '#e8ebf3', marginTop: 34, justifyContent: 'center', letterSpacing: -.4}} wordStyle={(_, i) => i >= 7 ? {color: C.mint} : undefined}/>
      <div style={{display: 'flex', justifyContent: 'center', gap: 14, marginTop: 50}}>
        {FRAMEWORKS.map((framework, i) => {const p = ease(f, 18 + i * 7, 34 + i * 7); return <Chip key={framework.name} dot={framework.dot} style={{opacity: p, transform: `translateY(${(1 - p) * 16}px) scale(${.94 + p * .06})`}}>{framework.name}</Chip>;})}
      </div>
    </div>
  </AbsoluteFill>;
};

const Finale = () => {
  const f = useCurrentFrame();
  const icon = ease(f, 14, 32);
  return <AbsoluteFill>
    <div style={{position: 'absolute', left: 0, right: 0, top: 230, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{position: 'relative', width: 128, height: 128, opacity: icon, transform: `scale(${.7 + icon * .3})`}}>
        <Img src={staticFile('capmac-icon.svg')} style={{width: 128, height: 128, filter: 'drop-shadow(0 18px 40px #3b8cf088)'}}/>
        <div style={{position: 'absolute', inset: 8, borderRadius: 30, overflow: 'hidden'}}><Sheen frame={f} at={30} duration={30} strength={.5}/></div>
      </div>
      <Words frame={f} from={30} stagger={3} text="CapMac for VS Code" style={{fontSize: 70, fontWeight: 600, letterSpacing: -2.2, marginTop: 22}} wordStyle={(_, i) => i >= 2 ? gradient(i === 2 ? '#b9c8ff' : '#8ab8ff', i === 2 ? '#8ab8ff' : '#6fb1ff') : undefined}/>
      <Words frame={f} from={38} stagger={2} text="Run your iPhone, Mac and Windows apps from VS Code" style={{fontSize: 36, fontWeight: 500, letterSpacing: -.9, marginTop: 10, color: '#f1eef6'}}/>
      <div style={{display: 'flex', gap: 12, marginTop: 40}}>
        {FRAMEWORKS.map((framework, i) => {const p = ease(f, 48 + i * 4, 60 + i * 4); return <Chip key={framework.name} dot={framework.dot} style={{opacity: p, transform: `translateY(${(1 - p) * 12}px)`}}>{framework.name}</Chip>;})}
      </div>
      <div style={{marginTop: 46, display: 'flex', alignItems: 'center', gap: 12, fontSize: 21, color: '#e9eef8', opacity: r(f, 72, 84)}}><Codicon name="vscode" size={22} color="#58a8f5"/>Free and open source · github.com/dotnetdreamer/capmac</div>
      <div style={{marginTop: 14, fontSize: 17, color: '#aeb6c8', opacity: r(f, 80, 92)}}>With your Mac, or with no Mac at all · Windows 10 and 11 · VS Code 1.100 or later</div>
    </div>
  </AbsoluteFill>;
};

const PLATES = [['blue', 0, 0], ['violet', 880, 980], ['cool', 1300, 1380], ['blue', 1700, 1800]] as const;

export const CapMacVSCodeIntro = () => {
  const g = useCurrentFrame();
  const leave = ease(g, T.leave, T.leave + 46);
  return <AbsoluteFill style={{fontFamily: body, color: C.text, overflow: 'hidden'}}>
    <FontGate/><Atmosphere frame={g} plates={PLATES}/><Vignette/><Html5Audio src={staticFile('vscode-background.wav')} volume={.7}/>
    <Sequence durationInFrames={240} name="Your iPhone app in VS Code"><Hook/></Sequence>
    {g >= T.rise && g < T.leave + 50 && <AbsoluteFill style={leave > 0 ? {opacity: 1 - leave, filter: `blur(${leave * 14}px)`, transform: `perspective(2200px) rotateX(${leave * 16}deg) scale(${1 - leave * .22})`} : undefined}>
      <Camera frame={g} keys={CAMERA}>
        <Lift frame={g} from={T.rise} duration={60} distance={340} style={{position: 'absolute', left: X, top: Y}}><VSCodeWindow view={viewAt(g)}/></Lift>
        {g >= 246 && g < T.wide && <Cursor frame={g} size={20} keys={CURSOR} clicks={CLICKS}/>}
      </Camera>
    </AbsoluteFill>}
    <Captions g={g}/>
    {CLICKS.map(click => <Sfx key={click} at={click}/>)}{SAVES.map(save => <Sfx key={`key-${save}`} at={save} sound="key"/>)}
    {SAVES.map(save => g >= save - 8 && g < save + 14 && <div key={save} style={{position: 'absolute', left: 0, right: 0, bottom: 44, display: 'flex', justifyContent: 'center', opacity: r(g, save - 8, save - 4) * (1 - r(g, save + 8, save + 14))}}><KeyCap down={g >= save && g < save + 6}>Ctrl + S</KeyCap></div>)}
    {g >= 1372 && g < T.macApp && <Note boxed opacity={r(g, 1372, 1380)}>Building with no Mac is experimental · It needs WSL 2, an iPhone and a paid Apple Developer Program membership</Note>}
    <Sequence from={T.leave + 10} name="CapMac for VS Code"><Finale/></Sequence>
    <Cuts frame={g} at={[T.live]}/>
    <AbsoluteFill style={{pointerEvents: 'none', background: '#0b0d18', opacity: r(g, VS_DURATION - 18, VS_DURATION - 2)}}/>
  </AbsoluteFill>;
};

export const CapMacVSCodePoster = () => <AbsoluteFill style={{fontFamily: body, color: C.text, overflow: 'hidden'}}>
  <FontGate/><Atmosphere frame={300} plates={[['blue', 0, 0]]}/><Vignette/>
  <div style={{position: 'absolute', left: 78, top: 50}}><Brand suffix="for VS Code"/></div>
  <div style={{position: 'absolute', left: 0, right: 0, top: 54, textAlign: 'center', fontSize: 58, fontWeight: 600, letterSpacing: -1.8}}>Your iPhone app, <span style={gradient('#a9c3ff', '#6fb1ff')}>in VS Code</span></div>
  <div style={{position: 'absolute', left: 0, right: 0, top: 138, textAlign: 'center', fontSize: 26, color: '#e8ebf3'}}>On Windows, with your Mac or with <span style={{color: C.mint}}>no Mac at all</span> · Capacitor · Ionic · Flutter · React Native · Electron</div>
  <div style={{position: 'absolute', left: 260, top: 222, transform: 'scale(.875)', transformOrigin: '0 0'}}><VSCodeWindow view={viewAt(870)}/></div>
</AbsoluteFill>;
