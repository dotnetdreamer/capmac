import {Composition, Still} from 'remotion';
import {CapMacIntro, CapMacPoster, CapMacReadme, DURATION} from './CapMacIntro';
import {CapMacVSCodeIntro, CapMacVSCodePoster, VS_DURATION} from './VSCodeIntro';

export const RemotionRoot = () => <>
  <Composition id="CapMacIntro" component={CapMacIntro} durationInFrames={DURATION} fps={30} width={1920} height={1080}/>
  <Still id="CapMacPoster" component={CapMacPoster} width={1920} height={1080}/>
  <Still id="CapMacReadme" component={CapMacReadme} width={1920} height={1080}/>
  <Composition id="CapMacVSCodeIntro" component={CapMacVSCodeIntro} durationInFrames={VS_DURATION} fps={30} width={1920} height={1080}/>
  <Still id="CapMacVSCodePoster" component={CapMacVSCodePoster} width={1920} height={1080}/>
</>;
