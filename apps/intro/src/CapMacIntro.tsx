import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Html5Audio, Img, Sequence, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame} from 'remotion';
import {Phone, StudioWindow} from './ProductVisuals';
import {Camera, Cursor, RevealText, type CameraKey} from './Motion';
import {MacRemoteLoginWindow, PairingOptionsTerminal, RemoteAccessWindow} from './RemoteFeatures';

const C = {ink: '#141722', text: '#f4f3ef', dim: '#adb0bc', violet: '#bcaafa', mint: '#9bd7bc'};
const body = '"IBM Plex Sans", sans-serif';
const mono = '"JetBrains Mono", monospace';
const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
const r = (f: number, a: number, b: number, x = 0, y = 1) => interpolate(f, [a, b], [x, y], clamp);
const ease = (f: number, a: number, b: number) => {const p = r(f,a,b); return p*p*(3-2*p);};
const W = {left:240, top:255, width:1440, height:690};

// A shot holds until an interaction gives the camera a reason to move
export const CHAPTERS = [
  {from:0,duration:180,label:'Purpose and features'},
  {from:180,duration:240,label:'Same Ionic and Capacitor commands'},
  {from:420,duration:210,label:'Remote Login and SSH pairing'},
  {from:630,duration:210,label:'Local and internet access'},
  {from:840,duration:240,label:'Live control and build'},
  {from:1080,duration:240,label:'Ionic live reload'},
  {from:1320,duration:240,label:'Console and source'},
  {from:1560,duration:270,label:'Screenshot agents and delivery'},
  {from:1830,duration:210,label:'Install CapMac'},
] as const;

const FontGate = () => {
  const [handle] = useState(() => delayRender('Bundled fonts'));
  useEffect(() => {
    Promise.all([document.fonts.load('500 64px "IBM Plex Sans"'),document.fonts.load('400 24px "JetBrains Mono"')])
      .then(() => continueRender(handle)).catch(() => continueRender(handle));
  },[handle]);
  const css = '@font-face{font-family:"IBM Plex Sans";src:url("' + staticFile('fonts/IBMPlexSans.ttf') + '");font-weight:100 700}' +
    '@font-face{font-family:"JetBrains Mono";src:url("' + staticFile('fonts/JetBrainsMono.ttf') + '");font-weight:100 800}';
  return <style>{css}</style>;
};

const Atmosphere = ({frame}:{frame:number}) => <AbsoluteFill style={{background:'#28262c',overflow:'hidden'}}>
  {['cool','warm','violet'].map((name,i) => <Img key={name} src={staticFile('atmosphere/'+name+'.jpg')} style={{
    position:'absolute',left:-60,top:-40,width:2040,height:1160,objectFit:'cover',
    opacity:i===0?1:i===1?r(frame,580,880):r(frame,1050,1260),
    transform:'translate('+Math.sin(frame/270+i)*22+'px,'+Math.cos(frame/330+i)*15+'px) scale('+ (1.02+frame/90000)+')',
  }}/>)}
  <AbsoluteFill style={{background:'linear-gradient(180deg,#090a1638,#090a1610 45%,#090a163d)'}}/>
</AbsoluteFill>;

const Brand = ({size=38}:{size?:number}) => <div style={{display:'flex',alignItems:'center',gap:13}}>
  <Img src={staticFile('capmac-icon.svg')} style={{width:size,height:size}}/>
  <span style={{fontSize:size*.72,fontWeight:600,letterSpacing:-.7}}>CapMac</span>
</div>;

const Caption = ({frame,text,detail}:{frame:number;text:string;detail?:string}) => <div style={{position:'absolute',left:50,top:43,zIndex:200,padding:'14px 22px',borderRadius:9,border:'1px solid #ffffff17',background:'#171a23dc',backdropFilter:'blur(10px)',boxShadow:'0 6px 24px #0002',opacity:r(frame,0,8)}}>
  <RevealText frame={frame} style={{fontSize:32,fontWeight:500,letterSpacing:-.6,color:C.text}}>{text}</RevealText>
  {detail && <RevealText frame={frame} from={8} style={{fontSize:detail.startsWith('ionic ')?23:19,fontFamily:detail.startsWith('ionic ')?mono:body,color:'#eeedf0cb',marginTop:6}}>{detail}</RevealText>}
</div>;

const Note = ({children}:{children:React.ReactNode}) => <div style={{position:'absolute',bottom:35,left:80,fontSize:16,color:'#f2eff1b0',zIndex:200,textShadow:'0 2px 15px #0008'}}>{children}</div>;

const Chrome = ({title,children,height=690}:{title:string;children:React.ReactNode;height?:number}) => <div style={{
  width:1440,height,border:'1px solid #ffffff30',borderRadius:12,background:'#1c1f28',overflow:'hidden',
  boxShadow:'0 38px 100px #00000065,0 2px 12px #0003',color:C.text,
}}>
  <div style={{height:49,borderBottom:'1px solid #ffffff10',display:'flex',alignItems:'center',padding:'0 21px',fontSize:18,color:'#b6b7c2',background:'#232630'}}>
    <span style={{color:C.violet,fontFamily:mono,fontSize:22,marginRight:15}}>&gt;_</span>{title}
    <div style={{marginLeft:'auto',display:'flex',gap:31,fontSize:22}}><span>−</span><span style={{fontSize:15}}>□</span><span>×</span></div>
  </div>
  {children}
</div>;

const Typed = ({frame,start,text}:{frame:number;start:number;text:string}) => <span>{text.slice(0,Math.max(0,Math.floor((frame-start)*1.25)))}{frame>=start && frame<start+text.length/.9 && <span style={{color:C.violet}}>▌</span>}</span>;
const Prompt = ({frame,start,text}:{frame:number;start:number;text:string}) => <div style={{fontFamily:mono,fontSize:29,color:C.text,whiteSpace:'nowrap'}}><span style={{color:'#9299b0',marginRight:20}}>PS &gt;</span><Typed frame={frame} start={start} text={text}/></div>;
const Check = ({children}:{children:React.ReactNode}) => <div style={{display:'flex',alignItems:'center',gap:14,fontSize:24,color:'#b7bdcc'}}><span style={{color:C.mint}}>✓</span>{children}</div>;

const FamiliarTerminal = ({frame}:{frame:number}) => <Chrome title="Windows PowerShell">
  <div style={{padding:'46px 56px'}}>
    <Prompt frame={frame} start={0} text="ionic capacitor run ios"/>
    <div style={{marginTop:26,opacity:r(frame,38,47)}}><Check>Ionic prepares your app on Windows</Check></div>
    <div style={{marginTop:17,opacity:r(frame,54,64)}}><Check>CapMac runs the iOS build on your paired Mac</Check></div>
    <div style={{opacity:r(frame,76,87),display:'flex',alignItems:'center',gap:24,width:1040,height:117,marginTop:24,padding:'22px 30px',border:'1px solid #9bd7bc2a',borderRadius:9,background:'#24403355'}}>
      <svg width="47" height="63" viewBox="0 0 47 63"><rect x="9" y="1" width="30" height="61" rx="7" fill="#262d35" stroke="#abc0b2" strokeWidth="2"/><path d="M20 7h8M21 55h6" stroke="#abc0b2" strokeWidth="2"/></svg>
      <div><div style={{fontSize:28,fontWeight:500}}>Your iOS app is running</div><div style={{fontSize:21,color:'#9fb7a8',marginTop:8}}>iPhone simulator on the paired Mac</div></div>
    </div>
    <div style={{marginTop:33,opacity:r(frame,158,169)}}><Prompt frame={frame} start={168} text="npx cap run ios"/></div>
    <div style={{marginTop:25,opacity:r(frame,190,201)}}><Check>Existing Capacitor command routed to your Mac</Check></div>
    <div style={{marginTop:19,opacity:r(frame,212,223),fontSize:24,color:'#c6dfd0'}}>Native build → install → launch → app console</div>
  </div>
</Chrome>;

const Opening = ({still=false}:{still?:boolean}) => {
  const actual=useCurrentFrame();const f=still?83:actual;
  const rise=spring({frame:f-50,fps:30,config:{damping:22,stiffness:92,mass:1.05}});
  return <AbsoluteFill>
    <div style={{position:'absolute',left:78,top:56}}><Brand/></div>
    <div style={{position:'absolute',left:0,right:0,top:218-ease(f,40,97)*191,textAlign:'center',opacity:1-r(f,119,144)}}>
      <RevealText frame={f} from={0} style={{fontSize:64,fontWeight:500,letterSpacing:-2,lineHeight:1.18}}>Build iOS apps from Windows</RevealText>
      <RevealText frame={f} from={6} style={{fontSize:28,color:'#e6e2e8',marginTop:14}}>Keep your Ionic and Capacitor commands</RevealText>
      <RevealText frame={f} from={10} style={{marginTop:25}}>
        <div style={{display:'flex',justifyContent:'center',gap:23,fontSize:23,color:'#eee9ee'}}>
          {['Same CLI commands','Remote Login','Internet access','Live reload'].map((x,i)=><span key={x} style={{borderLeft:i?'1px solid #ffffff45':undefined,paddingLeft:i?23:0}}>{x}</span>)}
        </div>
      </RevealText>
    </div>
    <div style={{position:'absolute',left:240,top:255+(1-rise)*920,transform:'scale('+(1.045-.045*rise)+')',transformOrigin:'center center',opacity:r(f,50,68)}}><FamiliarTerminal frame={Math.max(0,f-93)}/></div>
    <Note>Mac with Xcode, Remote Login and an active desktop session required</Note>
  </AbsoluteFill>;
};

const FAMILIAR_KEYS:CameraKey[]=[
  {at:0,x:960,y:595,scale:1},{at:13,x:960,y:595,scale:1},
  {at:36,x:860,y:481,scale:1.6},{at:104,x:860,y:481,scale:1.6},
  {at:137,x:860,y:766,scale:1.6},{at:202,x:860,y:770,scale:1.6},
  {at:233,x:960,y:595,scale:1},{at:240,x:960,y:595,scale:1},
];
const FamiliarScene=()=>{const f=useCurrentFrame();return <AbsoluteFill>
  <Camera frame={f} keys={FAMILIAR_KEYS}><div style={{position:'absolute',left:W.left,top:W.top}}><FamiliarTerminal frame={f*.8+87}/></div></Camera>
  <Caption frame={f<121?f:f-121} text={f<121?'Use your Ionic command on Windows':'Capacitor commands work too'} detail={f<121?'CapMac runs the iOS work on your Mac':'Your project and existing CLI workflow stay the same'}/>
  <Note>Install CapMac and pair your Mac · Open a new Windows terminal after setup</Note>
</AbsoluteFill>;};

const LOGIN_KEYS:CameraKey[]=[
  {at:0,x:960,y:595,scale:1},{at:12,x:960,y:595,scale:1},
  {at:31,x:1080,y:454,scale:1.6},{at:54,x:1080,y:454,scale:1.6},
  {at:76,x:960,y:595,scale:1},{at:83,x:960,y:595,scale:1},
  {at:101,x:885,y:454,scale:1.45},{at:119,x:885,y:454,scale:1.45},
  {at:143,x:890,y:614,scale:1.35},{at:155,x:890,y:614,scale:1.35},
  {at:178,x:890,y:764,scale:1.45},{at:192,x:890,y:764,scale:1.45},
  {at:209,x:960,y:595,scale:1},
];
const RemoteLoginScene=()=>{const f=useCurrentFrame();return <AbsoluteFill>
  <Camera frame={f} keys={LOGIN_KEYS}>
    <div style={{position:'absolute',left:W.left,top:W.top}}>
      {f<83?<MacRemoteLoginWindow frame={f}/>:<PairingOptionsTerminal frame={f-83}/>}
    </div>
    {f<83&&<Cursor frame={f} size={24} keys={[{at:0,x:1130,y:677},{at:27,x:1550,y:434},{at:68,x:1550,y:434}]} clicks={[32]}/>}
  </Camera>
  <Caption frame={f<83?f:f-83} text={f<83?'Enable Remote Login on your Mac':'Choose how you pair over SSH'} detail={f<83?'System Settings → General → Sharing':'Password once · Your SSH key · Windows OpenSSH agent'}/>
  <Note>Mac with Xcode and an active desktop session required</Note>
</AbsoluteFill>;};

const REMOTE_KEYS:CameraKey[]=[
  {at:0,x:960,y:595,scale:1},{at:10,x:960,y:595,scale:1},
  {at:29,x:1125,y:466,scale:1.65},{at:54,x:1125,y:466,scale:1.65},
  {at:77,x:1060,y:570,scale:1.6},{at:112,x:1060,y:570,scale:1.6},
  {at:135,x:1100,y:752,scale:1.55},{at:175,x:1100,y:752,scale:1.55},
  {at:204,x:960,y:595,scale:1},{at:210,x:960,y:595,scale:1},
];
const RemoteScene=()=>{const f=useCurrentFrame();return <AbsoluteFill>
  <Camera frame={f} keys={REMOTE_KEYS}><div style={{position:'absolute',left:W.left,top:W.top}}><RemoteAccessWindow frame={f}/></div>
    <Cursor frame={f} size={23} keys={[{at:0,x:1000,y:641},{at:27,x:1550,y:489},{at:43,x:1550,y:489},{at:56,x:1444,y:560},{at:63,x:1444,y:560},{at:80,x:1434,y:707},{at:107,x:1434,y:707},{at:132,x:1550,y:634},{at:142,x:1550,y:634},{at:153,x:1444,y:701},{at:159,x:1444,y:701},{at:177,x:1434,y:755},{at:192,x:1434,y:755}]} clicks={[30,60,85,135,155,190]}/>
  </Camera>
  <Caption frame={f<69?f:f-69} text={f<69?'Reach your Mac away from its network':'Choose local or internet access'} detail={f<69?'Enable remote access once while on the Mac network':'Automatic routing · Relay when needed · Keep Mac awake'}/>
  <Note>Internet access needs your configured signaling server · Mac must stay awake and logged in</Note>
</AbsoluteFill>;};

const BUILD_KEYS:CameraKey[]=[
  {at:0,x:960,y:595,scale:1},{at:12,x:960,y:595,scale:1},
  {at:34,x:1400,y:335,scale:2.3},{at:57,x:1400,y:335,scale:2.3},
  {at:88,x:1185,y:527,scale:1.88},{at:131,x:1185,y:527,scale:1.9},
  {at:159,x:511,y:645,scale:1.45},{at:208,x:511,y:645,scale:1.5},
  {at:238,x:960,y:595,scale:1},
];
const BuildScene=()=>{const f=useCurrentFrame();return <AbsoluteFill>
  <Camera frame={f} keys={BUILD_KEYS}><div style={{position:'absolute',left:W.left,top:W.top}}><StudioWindow frame={f} mode="build"/></div>
    <Cursor frame={f} size={22} keys={[{at:0,x:1120,y:623},{at:12,x:1120,y:623},{at:31,x:1370,y:332},{at:56,x:1370,y:332},{at:145,x:485,y:691},{at:177,x:480,y:853},{at:209,x:480,y:853}]} clicks={[36,185]}/>
  </Camera>
  <Caption frame={f<66?f:f<145?f-66:f-145} text={f<66?'Start a session in CapMac Studio':f<145?'Follow every build step':'Control the iOS simulator from Windows'}/>
</AbsoluteFill>;};

const CodeWorkspace=({frame}:{frame:number})=>{
  const changed=frame>=106;const reloaded=frame>=145;const view=frame>=199?'home':'activity';
  const hex=frame<95?'#C5B5EC':'#A1DDBD'.slice(0,Math.min(7,Math.max(0,frame-95)));
  const lines=[
    <><span style={{color:'#ba9ae5'}}>import</span> {'{ createApp }'} <span style={{color:'#ba9ae5'}}>from</span> <span style={{color:'#a7c795'}}>'vue'</span></>,
    <><span style={{color:'#ba9ae5'}}>import</span> App <span style={{color:'#ba9ae5'}}>from</span> <span style={{color:'#a7c795'}}>'./App.vue'</span></>,
    <></>,
    <><span style={{color:'#ba9ae5'}}>export const</span> theme = {'{'}</>,
    <>  accent: <span style={{color:changed?'#99d1b5':'#c7b0e9',background:frame>=69&&frame<95?'#5e507f':undefined}}>'{hex}'</span>,</>,
    <>  background: <span style={{color:'#a7c795'}}>'#F5F3ED'</span>,</>,
    <>{'}'}</>,
    <></>,
    <>createApp(App)</>,
    <>  .provide(<span style={{color:'#a7c795'}}>'theme'</span>, theme)</>,
    <>  .mount(<span style={{color:'#a7c795'}}>'#app'</span>)</>,
  ];
  return <Chrome title="Visual Studio Code   /   orbit">
    <div style={{display:'flex',height:639}}>
      <div style={{width:54,background:'#1e212a',borderRight:'1px solid #ffffff09',paddingTop:22,textAlign:'center',fontSize:27,color:'#838a9b'}}>▱<div style={{marginTop:29}}>⌕</div><div style={{marginTop:28}}>⑂</div></div>
      <div style={{width:839,borderRight:'1px solid #ffffff18'}}>
        <div style={{height:44,background:'#252933',display:'flex',alignItems:'center',fontSize:18,padding:'0 24px',color:'#dbdfe5'}}> <span style={{color:'#7da8d5',marginRight:13}}>TS</span> theme.ts <span style={{marginLeft:27,color:changed?'#748c7a':'#a3a9b3'}}>{changed?'✓':'●'}</span></div>
        <div style={{fontFamily:mono,fontSize:22,lineHeight:'37px',padding:'28px 28px 0',color:'#d6dce5'}}>{lines.map((line,i)=><div key={i} style={{background:i===4?'#b3a0e910':undefined,margin:'0 -8px',padding:'0 8px',whiteSpace:'pre'}}><span style={{display:'inline-block',width:42,color:'#667082',fontSize:19}}>{i+1}</span>{line}</div>)}</div>
        <div style={{margin:'24px 30px 0',height:74,borderTop:'1px solid #ffffff11',paddingTop:17,fontFamily:mono,fontSize:19,color:changed?C.mint:'#85909f'}}>
          {reloaded?'[vite] hot updated: /src/theme.ts':changed?'File saved · forwarding update':'ionic capacitor run ios -l · watching for changes'}
          {reloaded&&<div style={{color:'#a6b6ab',fontSize:17,marginTop:9}}>iOS WebView connected · update delivered</div>}
        </div>
        <div style={{position:'absolute',left:68,bottom:0,height:30,fontSize:14,color:'#b5bcc6'}}>TypeScript · UTF8 <span style={{marginLeft:260}}>{changed?'Saved':'Editing theme.ts'}</span></div>
      </div>
      <div style={{flex:1,background:'#171b22',position:'relative'}}>
        <div style={{height:44,borderBottom:'1px solid #ffffff10',padding:'11px 24px',fontSize:18,color:'#b1b8c2'}}>iPhone 16 Pro <span style={{float:'right',color:C.mint}}>Live</span></div>
        <div style={{position:'absolute',left:121,top:60}}><Phone frame={frame} variant={reloaded?'mint':'violet'} scale={.89} view={view} tapFrame={60}/></div>
      </div>
    </div>
    {frame>=93&&frame<113&&<div style={{position:'absolute',left:545,top:313,padding:'12px 18px',borderRadius:7,background:'#383c48',border:'1px solid #ffffff30',fontFamily:mono,fontSize:18,boxShadow:'0 8px 22px #0005'}}>Ctrl + S</div>}
  </Chrome>;
};
const EDIT_KEYS:CameraKey[]=[
  {at:0,x:960,y:595,scale:1},{at:13,x:960,y:595,scale:1},
  {at:38,x:648,y:509,scale:2.2},{at:103,x:648,y:509,scale:2.22},
  {at:139,x:1387,y:628,scale:1.58},{at:176,x:1387,y:628,scale:1.62},
  {at:203,x:1387,y:650,scale:1.7},{at:217,x:1387,y:650,scale:1.7},
  {at:239,x:960,y:595,scale:1},
];
const EditScene=()=>{const f=useCurrentFrame();return <AbsoluteFill>
  <Camera frame={f} keys={EDIT_KEYS}><div style={{position:'absolute',left:W.left,top:W.top}}><CodeWorkspace frame={f}/></div>
    <Cursor frame={f} size={21} keys={[{at:0,x:1165,y:550},{at:20,x:880,y:650},{at:62,x:544,y:524},{at:103,x:544,y:524},{at:160,x:1346,y:715},{at:193,x:1302,y:845},{at:221,x:1302,y:845}]} clicks={[66,196]}/>
  </Camera>
  <Caption frame={f<145?f:f-145} text={f<145?'Ionic live reload from Windows':'Your iOS app reloads'} detail={f<145?'ionic capacitor run ios -l':'Interact with the app while the session stays live'}/>
</AbsoluteFill>;};

const INSPECT_KEYS:CameraKey[]=[
  {at:0,x:960,y:595,scale:1},{at:12,x:960,y:595,scale:1},
  {at:35,x:1157,y:760,scale:1.85},{at:76,x:1157,y:760,scale:1.85},
  {at:97,x:1070,y:786,scale:2.1},{at:114,x:1070,y:786,scale:2.1},
  {at:139,x:1140,y:735,scale:1.7},{at:169,x:1140,y:735,scale:1.7},
  {at:192,x:1200,y:694,scale:1.7},{at:214,x:1200,y:694,scale:1.7},
  {at:239,x:960,y:595,scale:1},
];
const InspectScene=()=>{const f=useCurrentFrame();const problems=f>=121;return <AbsoluteFill>
  <Camera frame={f} keys={INSPECT_KEYS}>
    <div style={{position:'absolute',left:W.left,top:W.top}}><StudioWindow frame={f+240} interactionFrame={f} mode="inspect" active={problems?'problems':'console'}/></div>
    <Cursor frame={f} size={21} keys={[{at:0,x:1300,y:615},{at:30,x:746,y:655},{at:41,x:746,y:655},{at:63,x:846,y:688},{at:108,x:846,y:688},{at:119,x:843,y:617},{at:141,x:1020,y:732},{at:169,x:1020,y:732},{at:211,x:1085,y:719}]} clicks={[40,80,121,170]}/>
    {f>=171&&<div style={{position:'absolute',left:920,top:510,width:596,height:357,opacity:r(f,171,181),transform:'translateY('+(1-ease(f,171,185))*25+'px)',background:'#20242d',border:'1px solid #ffffff25',borderRadius:8,boxShadow:'0 18px 50px #0007',overflow:'hidden'}}>
      <div style={{height:42,padding:'11px 19px',fontSize:17,color:'#a8b1c3',background:'#292e3a'}}>AppDelegate.swift <span style={{float:'right'}}>Line 24</span></div>
      <div style={{fontFamily:mono,fontSize:18,lineHeight:2,padding:'28px 22px',color:'#c6ccd7'}}>
        <div><span style={{color:'#6b7487',marginRight:18}}>22</span><span style={{color:'#b496d3'}}>func</span> applicationDidBecomeActive() {'{'}</div>
        <div><span style={{color:'#6b7487',marginRight:18}}>23</span>  <span style={{color:'#737f90'}}>// Resume app state</span></div>
        <div style={{background:'#92515022',borderLeft:'2px solid #da9e90',margin:'0 -22px',padding:'0 20px'}}><span style={{color:'#da9e90',marginRight:18}}>24</span>  analytics.track(<span style={{color:'#acc59c'}}>"app_open"</span>)</div>
        <div><span style={{color:'#6b7487',marginRight:18}}>25</span>{'}'}</div>
        <div style={{marginTop:18,fontSize:16,color:'#d99d91'}}>Cannot find 'analytics' in scope</div>
      </div>
    </div>}
  </Camera>
  <Caption frame={problems?f-121:f} text={problems?'Open build errors at the source line':'Read JavaScript and native logs'} detail={problems?'Clickable Windows file paths':'Filter sources and expand structured output'}/>
</AbsoluteFill>;};

const ToolTerminal=({frame}:{frame:number})=>{
  const commands=['capmac screenshot','capmac skill add --agent codex --global','capmac build --ipa --upload'];
  const scroll=620*ease(frame,81,105)+620*ease(frame,171,195);
  return <Chrome title="Windows PowerShell   /   capmac">
    <div style={{height:641,overflow:'hidden'}}>
      <div style={{transform:'translateY('+(-scroll)+'px)'}}>
        {commands.map((command,phase)=>{
          const t=frame-phase*90;
          const ready=phase===1?35:25;
          return <div key={command} style={{height:620,padding:'44px 56px',opacity:t<0?0:1}}>
            <Prompt frame={t} start={0} text={command}/>
            <div style={{opacity:r(t,ready,ready+7),marginTop:28}}>
              {phase===0?<><Check>Screenshot saved to screenshots/orbit.png</Check><div style={{marginTop:28,display:'flex',alignItems:'center',gap:34}}>
                <div style={{width:175,height:350,position:'relative',overflow:'hidden',borderRadius:16,boxShadow:'0 18px 35px #0005'}}><Phone frame={70} variant="mint" scale={.58}/></div>
                <div><div style={{fontSize:27,color:C.text}}>orbit.png</div><div style={{fontFamily:mono,fontSize:18,color:'#858fa2',marginTop:15}}>Full resolution PNG</div></div>
              </div></>:phase===1?<><Check>CapMac skill installed for Codex</Check><div style={{marginTop:35,border:'1px solid #ffffff15',padding:'25px 30px',width:930,borderRadius:8,background:'#252a35',fontFamily:mono,fontSize:25,lineHeight:1.85}}><div style={{color:C.violet}}>CapMac tools available to your agent</div><div style={{color:'#bac3cf'}}>Build · Run · Read logs · Take screenshots</div></div></>:<><Check>Signed archive prepared</Check><div style={{marginTop:35,padding:'26px 32px',width:1040,borderRadius:8,border:'1px solid #a1cbb22b',background:'#25453444'}}>
                <div style={{fontSize:27,color:'#c5e1d0'}}>Upload complete</div><div style={{fontFamily:mono,fontSize:21,color:'#93b4a0',marginTop:13}}>App Store Connect</div>
              </div></>}
            </div>
          </div>;
        })}
      </div>
    </div>
  </Chrome>;
};
const TOOLS_KEYS:CameraKey[]=[
  {at:0,x:960,y:595,scale:1},{at:19,x:834,y:619,scale:1.35},
  {at:33,x:834,y:619,scale:1.35},{at:48,x:575,y:726,scale:1.9},
  {at:77,x:575,y:726,scale:1.92},{at:89,x:960,y:595,scale:1},
  {at:100,x:960,y:595,scale:1},{at:119,x:878,y:501,scale:1.5},
  {at:160,x:878,y:501,scale:1.52},{at:179,x:960,y:595,scale:1},
  {at:190,x:960,y:595,scale:1},{at:209,x:874,y:535,scale:1.55},
  {at:249,x:874,y:535,scale:1.57},{at:269,x:960,y:595,scale:1},
];
const ToolsScene=()=>{const f=useCurrentFrame();const phase=Math.min(2,Math.floor(f/90));return <AbsoluteFill>
  <Camera frame={f} keys={TOOLS_KEYS}><div style={{position:'absolute',left:W.left,top:W.top}}><ToolTerminal frame={f}/></div></Camera>
  <Caption frame={f-phase*90} text={['Capture the simulator','Set up your coding agent','Upload a signed iOS build'][phase]}/>
  <Note>{phase===2?'Apple signing credentials required':'Illustrative session using documented CapMac commands'}</Note>
</AbsoluteFill>;};

const Finale=()=>{const f=useCurrentFrame();return <AbsoluteFill>
  <div style={{position:'absolute',left:240,top:255,opacity:1-r(f,0,28),filter:'blur('+r(f,0,28,0,20)+'px)',transform:'scale('+r(f,0,28,1,.72)+')',transformOrigin:'center center'}}><ToolTerminal frame={269}/></div>
  <div style={{position:'absolute',left:0,right:0,top:283,textAlign:'center'}}>
    <RevealText frame={f} from={15} style={{display:'flex',justifyContent:'center',marginBottom:23}}><Brand size={67}/></RevealText>
    <RevealText frame={f} from={24} style={{fontSize:52,fontWeight:500,letterSpacing:-1.7}}>Pair to Mac for Capacitor</RevealText>
    <RevealText frame={f} from={30} style={{fontSize:26,color:'#e6e1ed',marginTop:21}}>CLI and Studio for your Windows workflow</RevealText>
    <div style={{fontFamily:mono,fontSize:30,color:C.text,marginTop:56}}><span style={{color:C.violet,marginRight:18}}>&gt;</span><Typed frame={f} start={40} text="npm install -g capmac"/></div>
  </div>
  <Note>Requires a Mac with Xcode</Note>
</AbsoluteFill>;};

// Brief depth defocus links scenes without placing a flash over the product
const SceneTransition=()=>{const f=useCurrentFrame();return <AbsoluteFill style={{pointerEvents:'none'}}>{CHAPTERS.slice(1).map(c=>{
  const d=f-c.from;if(d<-3||d>7)return null;return <AbsoluteFill key={c.from} style={{opacity:d<0?r(d,-3,0,0,.1):r(d,0,7,.1,0),background:'#e4dbec'}}/>;
})}</AbsoluteFill>;};

export const CapMacIntro=()=>{const f=useCurrentFrame();const scenes=[Opening,FamiliarScene,RemoteLoginScene,RemoteScene,BuildScene,EditScene,InspectScene,ToolsScene,Finale];return <AbsoluteFill style={{fontFamily:body,color:C.text,overflow:'hidden'}}>
  <FontGate/><Atmosphere frame={f}/><Html5Audio src={staticFile('intro-background.wav')} volume={.7}/>
  {CHAPTERS.map((c,i)=>{const Scene=scenes[i];return <Sequence key={c.label} from={c.from} durationInFrames={c.duration} name={c.label}><Scene/></Sequence>;})}
  <SceneTransition/><AbsoluteFill style={{pointerEvents:'none',background:'#101020',opacity:r(f,2022,2039)}}/>
</AbsoluteFill>;};
export const CapMacPoster=()=> <AbsoluteFill style={{fontFamily:body,color:C.text,overflow:'hidden'}}>
  <FontGate/><Atmosphere frame={540}/>
  <div style={{position:'absolute',left:78,top:56}}><Brand/></div>
  <div style={{position:'absolute',left:0,right:0,top:72,textAlign:'center',fontSize:59,fontWeight:500,letterSpacing:-1.8}}>Your Ionic commands on Windows</div>
  <div style={{position:'absolute',left:0,right:0,top:155,textAlign:'center',fontSize:26,color:'#ebe7ee'}}>Remote Login · Internet access · Live reload · Simulator control</div>
  <div style={{position:'absolute',left:W.left,top:W.top}}><StudioWindow frame={190} mode="live" active="console"/></div>
  <Note>ionic capacitor run ios · npx cap run ios · Paired Mac with Xcode</Note>
</AbsoluteFill>;
