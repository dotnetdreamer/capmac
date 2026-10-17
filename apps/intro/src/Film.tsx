import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Html5Audio, Img, Sequence, continueRender, delayRender, interpolate, staticFile} from 'remotion';
import {RevealText} from './Motion';

export const C = {ink: '#141722', text: '#f4f3ef', dim: '#adb0bc', violet: '#bcaafa', mint: '#9bd7bc', blue: '#6fb1ff', coral: '#f3a58f'};
export const body = '"IBM Plex Sans", sans-serif';
export const mono = '"JetBrains Mono", monospace';
export const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
export const r = (f: number, a: number, b: number, x = 0, y = 1) => interpolate(f, [a, b], [x, y], clamp);
export const ease = (f: number, a: number, b: number) => {const p = r(f, a, b); return p * p * (3 - 2 * p);};
/** Where a 1440 × 690 product window sits in the 1920 × 1080 frame */
export const W = {left: 240, top: 255, width: 1440, height: 690};
/** The music runs at 120 BPM, so a beat is 15 frames and a bar is 60 */
export const BEAT = 15;

export const FontGate = () => {
  const [handle] = useState(() => delayRender('Bundled fonts'));
  useEffect(() => {
    Promise.all([document.fonts.load('500 64px "IBM Plex Sans"'), document.fonts.load('400 24px "JetBrains Mono"'), document.fonts.load('16px "codicon"')])
      .then(() => continueRender(handle)).catch(() => continueRender(handle));
  }, [handle]);
  const css = '@font-face{font-family:"IBM Plex Sans";src:url("' + staticFile('fonts/IBMPlexSans.ttf') + '");font-weight:100 700}' +
    '@font-face{font-family:"JetBrains Mono";src:url("' + staticFile('fonts/JetBrainsMono.ttf') + '");font-weight:100 800}' +
    '@font-face{font-family:"codicon";src:url("' + staticFile('fonts/codicon.ttf') + '")}';
  return <style>{css}</style>;
};

export type Plate = 'cool' | 'warm' | 'violet' | 'mint' | 'blue';

/** Cloud backplates drift slowly; each later plate fades in over the ones before it */
export const Atmosphere = ({frame, plates}: {frame: number; plates: readonly (readonly [Plate, number, number])[]}) => <AbsoluteFill style={{background: '#28262c', overflow: 'hidden'}}>
  {plates.map(([name, from, to], i) => <Img key={name + from} src={staticFile('atmosphere/' + name + '.jpg')} style={{
    position: 'absolute', left: -60, top: -40, width: 2040, height: 1160, objectFit: 'cover',
    opacity: i === 0 ? 1 : r(frame, from, to),
    transform: 'translate(' + Math.sin(frame / 270 + i) * 22 + 'px,' + Math.cos(frame / 330 + i) * 15 + 'px) scale(' + (1.02 + frame / 90000) + ')',
  }}/>)}
  <AbsoluteFill style={{background: 'linear-gradient(180deg,#090a1638,#090a1610 45%,#090a163d)'}}/>
</AbsoluteFill>;

/** Darkened edges keep the eye on the middle of the frame */
export const Vignette = ({strength = .42}: {strength?: number}) => <AbsoluteFill style={{pointerEvents: 'none', background: `radial-gradient(ellipse 75% 70% at 50% 48%, transparent 55%, rgba(6,7,14,${strength}) 100%)`}}/>;

export const Brand = ({size = 38, suffix}: {size?: number; suffix?: string}) => <div style={{display: 'flex', alignItems: 'center', gap: size * .34}}>
  <Img src={staticFile('capmac-icon.svg')} style={{width: size, height: size}}/>
  <span style={{fontSize: size * .72, fontWeight: 600, letterSpacing: -.7}}>CapMac{suffix && <span style={{fontWeight: 400, color: '#d9d6e6', marginLeft: size * .2}}>{suffix}</span>}</span>
</div>;

export const Caption = ({frame, text, detail, code = false}: {frame: number; text: string; detail?: string; code?: boolean}) => <div style={{position: 'absolute', left: 50, top: 43, zIndex: 200, padding: '14px 22px', borderRadius: 9, border: '1px solid #ffffff17', background: '#171a23dc', backdropFilter: 'blur(10px)', boxShadow: '0 6px 24px #0002', opacity: r(frame, 0, 8)}}>
  <RevealText frame={frame} style={{fontSize: 32, fontWeight: 500, letterSpacing: -.6, color: C.text}}>{text}</RevealText>
  {detail && <RevealText frame={frame} from={8} style={{fontSize: code ? 23 : 19, fontFamily: code ? mono : body, color: '#eeedf0cb', marginTop: 6}}>{detail}</RevealText>}
</div>;

/** Small print for requirements; `boxed` gives it a backing where it lies over a product window */
export const Note = ({children, opacity = 1, boxed = false}: {children: React.ReactNode; opacity?: number; boxed?: boolean}) => <div style={{position: 'absolute', bottom: 35, left: boxed ? 50 : 80, fontSize: 16, color: boxed ? '#e9e6ecd9' : '#f2eff1b0', zIndex: 200, textShadow: '0 2px 15px #0008', opacity, ...(boxed ? {padding: '8px 14px', borderRadius: 8, background: '#14161ee6', border: '1px solid #ffffff14', backdropFilter: 'blur(8px)'} : {})}}>{children}</div>;

export const Chrome = ({title, children, width = 1440, height = 690}: {title: string; children: React.ReactNode; width?: number; height?: number}) => <div style={{
  position: 'relative', width, height, border: '1px solid #ffffff30', borderRadius: 12, background: '#1c1f28', overflow: 'hidden',
  boxShadow: '0 38px 100px #00000065,0 2px 12px #0003', color: C.text,
}}>
  <div style={{height: 49, borderBottom: '1px solid #ffffff10', display: 'flex', alignItems: 'center', padding: '0 21px', fontSize: 18, color: '#b6b7c2', background: '#232630'}}>
    <span style={{color: C.violet, fontFamily: mono, fontSize: 22, marginRight: 15}}>&gt;_</span>{title}
    <div style={{marginLeft: 'auto', display: 'flex', gap: 31, fontSize: 22}}><span>−</span><span style={{fontSize: 15}}>□</span><span>×</span></div>
  </div>
  {children}
</div>;

export const Typed = ({frame, start, text, speed = 1.25}: {frame: number; start: number; text: string; speed?: number}) => <span>{text.slice(0, Math.max(0, Math.floor((frame - start) * speed)))}{frame >= start && frame < start + text.length / speed + 6 && <span style={{color: C.violet}}>▌</span>}</span>;
export const Prompt = ({frame, start, text, path = 'C:\\code\\orbit', size = 29}: {frame: number; start: number; text: string; path?: string; size?: number}) => <div style={{fontFamily: mono, fontSize: size, color: C.text, whiteSpace: 'nowrap'}}><span style={{color: '#9299b0', marginRight: size * .55}}>PS {path}&gt;</span><Typed frame={frame} start={start} text={text}/></div>;
export const Check = ({children, color = C.mint, mark = '✓', size = 24}: {children: React.ReactNode; color?: string; mark?: string; size?: number}) => <div style={{display: 'flex', alignItems: 'center', gap: 14, fontSize: size, color: '#b7bdcc'}}><span style={{color}}>{mark}</span>{children}</div>;

export const KeyCap = ({children, down = false}: {children: React.ReactNode; down?: boolean}) => <span style={{
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 46, padding: '0 16px', borderRadius: 8, boxSizing: 'border-box',
  background: down ? '#2d3140' : '#3a3e4b', border: '1px solid #ffffff30', borderBottomWidth: down ? 1 : 4, fontFamily: mono, fontSize: 19, color: '#eceef4',
  boxShadow: down ? '0 3px 10px #0005' : '0 9px 24px #0006', transform: down ? 'translateY(3px)' : undefined,
}}>{children}</span>;

/** A quiet interface sound on a cursor's click or a key press, from scripts/sfx.py */
export const Sfx = ({at, sound = 'click'}: {at: number; sound?: 'click' | 'key'}) => <Sequence from={at} durationInFrames={sound === 'key' ? 10 : 6} layout="none" name={sound}>
  <Html5Audio src={staticFile(`sfx/${sound}.wav`)} volume={sound === 'key' ? .32 : .3}/>
</Sequence>;

/** A brief lift of light that links two scenes without hiding the product */
export const Cuts = ({frame, at, color = '#e4dbec', peak = .1}: {frame: number; at: readonly number[]; color?: string; peak?: number}) => <AbsoluteFill style={{pointerEvents: 'none'}}>{at.map(cut => {
  const d = frame - cut; if (d < -3 || d > 7) return null;
  return <AbsoluteFill key={cut} style={{opacity: d < 0 ? r(d, -3, 0, 0, peak) : r(d, 0, 7, peak, 0), background: color}}/>;
})}</AbsoluteFill>;

/** A small pill, used for frameworks and labels */
export const Chip = ({children, dot, style}: {children: React.ReactNode; dot?: string; style?: React.CSSProperties}) => <span style={{display: 'inline-flex', alignItems: 'center', gap: 11, height: 52, padding: '0 24px', borderRadius: 26, border: '1px solid #ffffff26', background: '#ffffff0d', backdropFilter: 'blur(6px)', fontSize: 24, color: '#eeebf2', whiteSpace: 'nowrap', ...style}}>
  {dot && <span style={{width: 9, height: 9, borderRadius: 9, background: dot, boxShadow: `0 0 12px ${dot}88`}}/>}{children}
</span>;

export const FRAMEWORKS = [
  {name: 'Capacitor', dot: '#53b9ff'},
  {name: 'Ionic', dot: '#7aa7ff'},
  {name: 'Flutter', dot: '#5fd3f6'},
  {name: 'React Native', dot: '#7fe7ff'},
  {name: 'Electron', dot: '#a9b4ff'},
] as const;
