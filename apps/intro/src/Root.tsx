import {Composition, Still} from 'remotion';
import {CapMacIntro, CapMacPoster} from './CapMacIntro';

export const RemotionRoot = () => <>
  <Composition id="CapMacIntro" component={CapMacIntro} durationInFrames={2040} fps={30} width={1920} height={1080}/>
  <Still id="CapMacPoster" component={CapMacPoster} width={1920} height={1080}/>
</>;
