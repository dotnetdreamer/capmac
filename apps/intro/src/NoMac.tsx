import React from 'react';
import {interpolate} from 'remotion';
import {Handset, OrbitScreen} from './Apps';
import {Glyph, monoFont, type IconName} from './ProductVisuals';

const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
const ramp = (frame: number, from: number, to: number) => interpolate(frame, [from, to], [0, 1], clamp);
const body = '"IBM Plex Sans", sans-serif';

/**
 * A real iPhone beside the PC. The app shows on the phone itself: with no Mac there is no simulator,
 * and Studio's pane says so. `cable` fades the USB cable out once the phone also connects over Wi-Fi.
 */
export function PluggedIPhone({frame, launchAt, variant = 'violet', cable = 1, wifi = 0, scale = 1}: {frame: number; launchAt: number; variant?: 'violet' | 'mint'; cable?: number; wifi?: number; scale?: number}) {
  const on = ramp(frame, launchAt - 8, launchAt + 6);
  return <div style={{position: 'relative', width: 300 * scale, height: 600 * scale}}>
    <svg width={900} height={420} viewBox="0 0 900 420" style={{position: 'absolute', left: 150 * scale - 860, top: 600 * scale - 16, opacity: cable, overflow: 'visible'}}>
      <defs><linearGradient id="cable" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stopColor="#f2f2f4"/><stop offset=".65" stopColor="#d9dade" stopOpacity=".9"/><stop offset="1" stopColor="#c9cacf" stopOpacity="0"/></linearGradient></defs>
      <rect x={860 - 9} y={6} width={18} height={26} rx={4} fill="#e9e9ec" stroke="#b9babf"/>
      <path d="M860 30 C 860 150, 760 210, 560 230 S 120 260, 0 330" fill="none" stroke="url(#cable)" strokeWidth="11" strokeLinecap="round"/>
    </svg>
    <Handset scale={scale} screen={on > 0 ? '#f5f3ed' : '#000'} sheen={{frame, at: launchAt + 2}}>
      <div style={{position: 'absolute', inset: 0, opacity: on}}><OrbitScreen frame={Math.max(0, frame - launchAt)} variant={variant}/></div>
      <div style={{position: 'absolute', inset: 0, background: '#000', opacity: 1 - on}}/>
    </Handset>
    <div style={{position: 'absolute', left: '50%', top: -58 * scale, transform: 'translateX(-50%)', display: 'flex', gap: 10, fontFamily: body}}>
      <Badge icon="plug" label="USB" opacity={cable}/>
      <Badge icon="wifi" label="Wi-Fi" opacity={wifi}/>
    </div>
  </div>;
}

function Badge({icon, label, opacity}: {icon: IconName; label: string; opacity: number}) {
  if (opacity <= 0) return null;
  return <span style={{display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 14px', borderRadius: 18, background: '#ffffff14', border: '1px solid #ffffff2a', color: '#eef6f1', fontSize: 17, opacity, backdropFilter: 'blur(6px)'}}><Glyph name={icon} size={18} color="#9be3c0"/>{label}</span>;
}

/** What Xcode does for an iPhone build, and the open-source tool CapMac uses for each job instead */
export const TWINS = [
  {job: 'Compile', twin: 'Swift and Clang', detail: 'for Linux, with Apple’s iPhone SDK', icon: 'code' as const},
  {job: 'Link', twin: 'ld64.lld', detail: 'LLVM’s linker, with a fix for big apps', icon: 'box' as const},
  {job: 'Packages', twin: 'CocoaPods and SwiftPM', detail: 'the real ones, pinned by your lockfiles', icon: 'download' as const},
  {job: 'Storyboards', twin: 'Open-source compilers', detail: 'for storyboards and asset catalogs', icon: 'window' as const},
  {job: 'Sign', twin: 'zsign', detail: 'with your Apple certificate', icon: 'key' as const},
  {job: 'Install', twin: 'pymobiledevice3', detail: 'over USB or Wi-Fi', icon: 'phone' as const},
] as const;

/** The six jobs, appearing one per beat and joined by a pulse of light, like a build flowing through them */
export function TwinsPipeline({frame, start = 0, every = 15}: {frame: number; start?: number; every?: number}) {
  const width = 262;
  const gap = 22;
  const flow = (frame - start - every * 6) / 40;
  return <div style={{position: 'relative', width: TWINS.length * width + (TWINS.length - 1) * gap, height: 250, fontFamily: body}}>
    <div style={{position: 'absolute', left: width / 2, right: width / 2, top: 125, height: 2, background: '#ffffff1a'}}/>
    <div style={{position: 'absolute', left: width / 2, top: 124, height: 4, width: `calc((100% - ${width}px) * ${ramp(frame, start, start + every * 6)})`, background: 'linear-gradient(90deg,#9bd7bc,#bcaafa)', borderRadius: 2, boxShadow: '0 0 14px #9bd7bc88'}}/>
    {flow > 0 && <div style={{position: 'absolute', top: 117, left: `calc(${width / 2}px + (100% - ${width}px) * ${flow % 1})`, width: 18, height: 18, marginLeft: -9, borderRadius: 9, background: '#ffffff', boxShadow: '0 0 22px 6px #c9f0dd', opacity: Math.sin(Math.PI * (flow % 1))}}/>}
    {TWINS.map((item, i) => {
      const show = ramp(frame, start + i * every, start + i * every + 10);
      return <div key={item.job} style={{position: 'absolute', left: i * (width + gap), top: 0, width, height: 250, boxSizing: 'border-box', padding: '22px 22px', borderRadius: 16, background: '#141a20e6', border: '1px solid #ffffff1f', boxShadow: '0 22px 50px #0006', opacity: show, transform: `translateY(${(1 - show) * 26}px) scale(${.96 + show * .04})`}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, color: '#9fb2a8', letterSpacing: .3}}><Glyph name={item.icon} size={18} color="#9bd7bc"/>{item.job}</div>
        <div style={{height: 70}}/>
        <div style={{fontSize: 25, fontWeight: 600, letterSpacing: -.5, color: '#f3f6f4', fontFamily: item.twin.includes('.') || item.twin === 'zsign' || item.twin.startsWith('pymobile') ? monoFont : body}}>{item.twin}</div>
        <div style={{fontSize: 15, color: '#a9b3b0', marginTop: 10, lineHeight: 1.35}}>{item.detail}</div>
      </div>;
    })}
  </div>;
}
