import React from 'react';
import {AbsoluteFill} from 'remotion';

export type CameraKey = {
  at: number;
  x: number;
  y: number;
  scale: number;
  roll?: number;
  /** Reach this key with a gentle drift instead of a decisive move: a slow push should never surge */
  drift?: boolean;
};

export type CursorKey = {
  at: number;
  x: number;
  y: number;
};

export type CameraPosition = {
  x: number;
  y: number;
  scale: number;
  roll: number;
};

const WIDTH = 1920;
const HEIGHT = 1080;
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

// Quintic easing has zero velocity and acceleration at both ends of a move
const ease = (progress: number) => {
  const t = clamp(progress);
  return t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2;
};

// Smoothstep peaks at 1.5 times the average speed, where the quintic peaks at 5 times
const drift = (progress: number) => {
  const t = clamp(progress);
  return t * t * (3 - 2 * t);
};

const segmentAt = <T extends {at: number; drift?: boolean}>(frame: number, keys: readonly T[]) => {
  const ordered = [...keys].sort((left, right) => left.at - right.at);
  if (ordered.length === 0) return null;
  if (frame <= ordered[0].at) return {from: ordered[0], to: ordered[0], progress: 0};
  for (let index = 1; index < ordered.length; index++) {
    const to = ordered[index];
    if (frame <= to.at) {
      const from = ordered[index - 1];
      const linear = (frame - from.at) / Math.max(1, to.at - from.at);
      return {from, to, progress: to.drift ? drift(linear) : ease(linear)};
    }
  }
  const last = ordered[ordered.length - 1];
  return {from: last, to: last, progress: 1};
};

export const cameraAt = (frame: number, keys: readonly CameraKey[]): CameraPosition => {
  const segment = segmentAt(frame, keys);
  if (!segment) return {x: WIDTH / 2, y: HEIGHT / 2, scale: 1, roll: 0};
  const {from, to, progress} = segment;
  return {
    x: mix(from.x, to.x, progress),
    y: mix(from.y, to.y, progress),
    scale: Math.max(0.001, mix(from.scale, to.scale, progress)),
    roll: mix(from.roll ?? 0, to.roll ?? 0, progress),
  };
};

const screenPoint = (camera: CameraPosition, x: number, y: number) => {
  const radians = camera.roll * Math.PI / 180;
  const cosine = Math.cos(radians) * camera.scale;
  const sine = Math.sin(radians) * camera.scale;
  return {
    x: WIDTH / 2 + cosine * (x - camera.x) - sine * (y - camera.y),
    y: HEIGHT / 2 + sine * (x - camera.x) + cosine * (y - camera.y),
  };
};

const blurAt = (frame: number, keys: readonly CameraKey[]) => {
  const before = cameraAt(frame - 0.5, keys);
  const after = cameraAt(frame + 0.5, keys);
  const anchors = [[0, 0], [WIDTH, 0], [0, HEIGHT], [WIDTH, HEIGHT], [WIDTH / 2, HEIGHT / 2]];
  const velocity = anchors.reduce((total, [x, y]) => {
    const a = screenPoint(before, x, y);
    const b = screenPoint(after, x, y);
    return total + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0) / anchors.length;
  return velocity < 0.35 ? 0 : clamp(velocity * 0.07, 0, 5);
};

export const Camera: React.FC<{
  frame: number;
  keys: readonly CameraKey[];
  children: React.ReactNode;
  blur?: boolean;
  style?: React.CSSProperties;
}> = ({frame, keys, children, blur = true, style}) => {
  const {x, y, scale, roll} = cameraAt(frame, keys);
  // The filter applies before the zoom, so the radius is divided by it to blur by the motion seen on screen
  const radius = blur ? blurAt(frame, keys) / scale : 0;
  return <AbsoluteFill style={{overflow: 'hidden', ...style}}>
    <div style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: WIDTH,
      height: HEIGHT,
      transformOrigin: '0 0',
      transform: `translate(${WIDTH / 2}px, ${HEIGHT / 2}px) rotate(${roll}deg) scale(${scale}) translate(${-x}px, ${-y}px)`,
      filter: radius > 0 ? `blur(${radius.toFixed(3)}px)` : undefined,
      willChange: 'transform',
    }}>{children}</div>
  </AbsoluteFill>;
};

export const Cursor: React.FC<{
  frame: number;
  keys: readonly CursorKey[];
  clicks?: readonly number[];
  size?: number;
  color?: string;
}> = ({frame, keys, clicks = [], size = 35, color = '#ffffff'}) => {
  const segment = segmentAt(frame, keys);
  if (!segment) return null;
  const x = mix(segment.from.x, segment.to.x, segment.progress);
  const y = mix(segment.from.y, segment.to.y, segment.progress);
  const activeClick = [...clicks].reverse().find((at) => frame >= at && frame < at + 16);
  const clickFrame = activeClick === undefined ? -1 : frame - activeClick;
  const press = clickFrame < 0 ? 1 : clickFrame < 4
    ? mix(1, 0.8, ease(clickFrame / 4))
    : mix(0.8, 1, ease((clickFrame - 4) / 7));
  const rippleProgress = clickFrame < 0 ? 0 : clamp(clickFrame / 16);
  return <div style={{position: 'absolute', left: x, top: y, width: size, height: size * 1.35, zIndex: 100, pointerEvents: 'none'}}>
    {clickFrame >= 0 && <div style={{
      position: 'absolute',
      width: size * 1.65,
      height: size * 1.65,
      left: -size * 0.825,
      top: -size * 0.825,
      borderRadius: '50%',
      border: `2px solid ${color}`,
      background: `${color === '#ffffff' ? '#ffffff' : '#99aeff'}12`,
      opacity: (1 - rippleProgress) * 0.58,
      transform: `scale(${mix(0.18, 1.45, ease(rippleProgress))})`,
    }}/>}
    <svg width={size} height={size * 1.35} viewBox="0 0 28 38" style={{overflow: 'visible', transform: `scale(${press})`, transformOrigin: '0 0', filter: 'drop-shadow(0 2px 3px #00000055)'}}>
      <path d="M0 0 L0 29 L7.1 21.6 L13.5 35.5 L19.1 32.9 L12.7 19.1 L23.6 19.1 Z" fill={color} stroke="#18202b" strokeWidth="1.7" strokeLinejoin="round"/>
    </svg>
  </div>;
};

export const RevealText: React.FC<{
  frame: number;
  from?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({frame, from = 0, children, style}) => {
  const progress = ease((frame - from) / (30 * 0.35));
  return <div style={{...style, overflow: 'hidden'}}>
    <div style={{opacity: progress, transform: `translateY(${mix(18, 0, progress)}px)`}}>{children}</div>
  </div>;
};

/** Each word rises out of its own mask and comes into focus a few frames after the one before */
export const Words: React.FC<{
  frame: number;
  from?: number;
  text: string;
  stagger?: number;
  style?: React.CSSProperties;
  wordStyle?: (word: string, index: number) => React.CSSProperties | undefined;
}> = ({frame, from = 0, text, stagger = 3, style, wordStyle}) => <div style={{display: 'flex', flexWrap: 'wrap', columnGap: '0.24em', justifyContent: style?.textAlign === 'center' ? 'center' : undefined, ...style}}>
  {text.split(' ').map((word, index) => {
    const progress = ease((frame - from - index * stagger) / (30 * 0.42));
    return <span key={index} style={{display: 'inline-block', overflow: 'hidden', padding: '0.06em 0.04em 0.14em', margin: '-0.06em -0.04em -0.14em'}}>
      <span style={{display: 'inline-block', opacity: progress, transform: `translateY(${mix(0.7, 0, progress)}em)`, filter: progress < 1 ? `blur(${mix(9, 0, progress).toFixed(2)}px)` : undefined, ...wordStyle?.(word, index)}}>{word}</span>
    </span>;
  })}
</div>;

/** A window that rises out of depth: tilted back and low, settling flat and in place */
export const Lift: React.FC<{
  frame: number;
  from: number;
  duration?: number;
  distance?: number;
  tilt?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({frame, from, duration = 34, distance = 300, tilt = 24, children, style}) => {
  const progress = ease((frame - from) / duration);
  // Once settled it drops the 3D context, which would keep Chrome drawing it at low resolution under a zooming camera
  if (progress >= 1) return <div style={style}>{children}</div>;
  return <div style={{perspective: 2200, perspectiveOrigin: '50% 30%', ...style}}>
    <div style={{
      transformOrigin: '50% 100%',
      transform: `translateY(${mix(distance, 0, progress)}px) rotateX(${mix(tilt, 0, progress)}deg) scale(${mix(0.9, 1, progress)})`,
      opacity: clamp(progress * 2.2),
    }}>{children}</div>
  </div>;
};

/** A soft band of light that crosses a surface once, as glass catches it */
export const Sheen: React.FC<{frame: number; at: number; duration?: number; radius?: number; strength?: number}> = ({frame, at, duration = 26, radius = 0, strength = 0.32}) => {
  const progress = (frame - at) / duration;
  if (progress <= 0 || progress >= 1) return null;
  const x = mix(-60, 160, ease(progress));
  return <div style={{position: 'absolute', inset: 0, borderRadius: radius, overflow: 'hidden', pointerEvents: 'none', mixBlendMode: 'screen'}}>
    <div style={{position: 'absolute', inset: '-20%', background: `linear-gradient(105deg, transparent ${x - 22}%, rgba(255,255,255,${strength}) ${x}%, transparent ${x + 22}%)`}}/>
  </div>;
};
