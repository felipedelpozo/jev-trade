import { normalizeMeta, classifyUpdate, money } from './core.js';
import { TradeTracker, randomCombination, presentation, SYMBOLS } from './slot-engine.js';
import { OrbitAudio } from './audio.js';
import { createReel, lockReel, reelFrame, reelSymbol, SYMBOL_STEP_PX, hasReelResult } from './reel-motion.js';
import { SAFE_ZONE, fitStage, resultCue, mascotReaction, cueProgress, accountReadout, updateCycle, timerReadout, closeBalanceTransition, animatedBalance, scoreboardRows } from './stage.js';

const $ = (id) => document.getElementById(id);
const canvas = $('orbit');
const ctx = canvas.getContext('2d', { alpha: false });
const W = 1080, H = 1920;
const chromeRect = { x: 48, y: 100, w: 900, h: 2752 * 900 / 1536 };
let machineFit = { s: 1, tx: 0, ty: 0 }, seedFractions = [.25,.5,.75];
let centers = [260, 498, 734];
let reelCenterY = 800, reelLabelY = 950;
let scoreContainer;
let timerDial, timerAccessible = '';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const state = { mode: 'live', motion: !reduced.matches, guides: false, current: null, lastLive: null,
  spin: null, replayIndex: 0, replay: [], history: [], replayEvents: [], connected: false, error: '', ready: false, generation: 0,
  outcome: {kind:'none'}, symbols: randomCombination(), held: 0, winAt: 0, effectPreview: false, previewKind: '', eventAt: -Infinity, cue: null, cycle: null, balanceTween: null, restingReels: [], pendingExecution: null };
let liveTracker = new TradeTracker(), replayTracker = new TradeTracker();
$('motion').checked = state.motion;

const images = {};
let chrome, windows, robot;
const mascotClips = {};
let mascotKey = 'idle', mascotPrevious = null, mascotChangedAt = 0;
let pollTimer, pollController;

const sound = new OrbitAudio({ onChange: ({running,loading,error}) => {
  for(const id of ['audio-toggle','quick-audio']){
    $(id).textContent=loading?'Preparando audio…':running?'Silenciar todo':'Activar audio';
    $(id).setAttribute('aria-pressed',String(running));$(id).disabled=loading;
  }
  $('audio-status').textContent=error|| (loading?'Cargando sonidos locales…':running?'Audio activo · música y efectos con mezcla independiente.':'Audio apagado.');
  $('audio-status').classList.toggle('error',Boolean(error));
} });
function toggleAudio(){if(sound.running)sound.disable();else sound.enable();}
$('audio-toggle').addEventListener('click',toggleAudio);
$('quick-audio').addEventListener('click',toggleAudio);
$('music-volume').addEventListener('input',event=>{sound.setMusicLevel(Number(event.target.value)/100);$('music-volume-value').value=`${event.target.value}%`;});
$('effects-volume').addEventListener('input',event=>{sound.setEffectsLevel(Number(event.target.value)/100);$('effects-volume-value').value=`${event.target.value}%`;});

function loadImage(name, path) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { images[name] = image; resolve(image); };
    image.onerror = () => reject(new Error(`No se ha podido cargar ${name}`));
    image.src = path;
  });
}

function makeCanvas(width, height) {
  const element = document.createElement('canvas');
  element.width = Math.round(width); element.height = Math.round(height);
  return element;
}

async function prepareChrome() {
  const source = images.shell;
  const scaleX=chromeRect.w/source.naturalWidth,scaleY=chromeRect.h/source.naturalHeight;
  scoreContainer={top:chromeRect.y+999*scaleY,bottom:chromeRect.y+1213*scaleY,
    footer:chromeRect.y+1240*scaleY,capsule:chromeRect.y+1311*scaleY};
  const surface = makeCanvas(source.naturalWidth, source.naturalHeight);
  const c = surface.getContext('2d', { willReadFrequently: true });
  c.drawImage(source, 0, 0);
  const rgba = c.getImageData(0, 0, surface.width, surface.height);
  const isGreen = (i) => rgba.data[i+1] > 180 && rgba.data[i] < 100 && rgba.data[i+2] < 100;
  // Read the actual closed green holes so a repaired frame keeps exact pixel masks.
  const width=surface.width,height=surface.height,visited=new Uint8Array(width*height),queue=new Int32Array(width*height);
  const seeds=seedFractions.map(fraction=>[fraction,.43]).concat([[.31,.225]]);
  const regions=seeds.map(([fx,fy],column)=>{
    const sx=Math.round(width*fx),sy=Math.round(height*fy),seed=sy*width+sx;
    if(!isGreen(seed*4)||visited[seed])throw new Error('El marco no tiene ventanas independientes');
    let head=0,tail=1,minX=sx,maxX=sx,minY=sy,maxY=sy;queue[0]=seed;visited[seed]=column+1;
    const points=[];
    while(head<tail){
      const p=queue[head++],x=p%width,y=Math.floor(p/width);points.push(p);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      const neighbors=[x>0?p-1:-1,x<width-1?p+1:-1,y>0?p-width:-1,y<height-1?p+width:-1];
      for(const n of neighbors)if(n>=0&&!visited[n]&&isGreen(n*4)){visited[n]=column+1;queue[tail++]=n;}
    }
    if(minX===0||maxX===width-1||minY===0||maxY===height-1||points.length<10000)throw new Error('El contorno de un rodillo está abierto');
    return {x0:minX,y0:minY,x1:maxX+1,y1:maxY+1,points};
  });
  const dial=regions.pop();
  timerDial={x:chromeRect.x+(dial.x0+dial.x1)/2*scaleX,y:chromeRect.y+(dial.y0+dial.y1)/2*scaleY,
    radius:Math.min((dial.x1-dial.x0)*scaleX,(dial.y1-dial.y0)*scaleY)/2,clip:new Path2D()};
  const dialRows=new Map();
  for(const point of dial.points){
    const y=Math.floor(point/width),x=point%width,bounds=dialRows.get(y)||[x,x];
    bounds[0]=Math.min(bounds[0],x);bounds[1]=Math.max(bounds[1],x);dialRows.set(y,bounds);
  }
  for(const [y,[left,right]] of dialRows)timerDial.clip.rect(chromeRect.x+left*scaleX,chromeRect.y+y*scaleY,(right-left+1)*scaleX,scaleY);
  centers=regions.map(r=>Math.round(chromeRect.x+(r.x0+r.x1)/2*scaleX));
  reelCenterY=Math.round(chromeRect.y+regions.reduce((sum,r)=>sum+(r.y0+r.y1)/2,0)/3*scaleY);
  reelLabelY=Math.round(chromeRect.y+Math.max(...regions.map(r=>r.y1))*scaleY-28);
  windows = await Promise.all(regions.map(async ({x0,y0,x1,y1,points}, column) => {
    const maskCanvas = makeCanvas(x1-x0,y1-y0);
    const mc = maskCanvas.getContext('2d');
    const mask = mc.createImageData(maskCanvas.width,maskCanvas.height);
    for(const p of points) {
      const x=p%width,y=Math.floor(p/width),di=((y-y0)*maskCanvas.width+x-x0)*4;
      mask.data[di]=255; mask.data[di+1]=255; mask.data[di+2]=255;
      mask.data[di+3]=255;
    }
    mc.putImageData(mask,0,0);
    const layer=makeCanvas((x1-x0)*scaleX,(y1-y0)*scaleY);
    const lc=layer.getContext('2d');
    const shade=lc.createLinearGradient(0,0,0,layer.height);
    shade.addColorStop(0,'#061735');shade.addColorStop(.48,'#143354');shade.addColorStop(1,'#06132c');
    return {mask:await createImageBitmap(maskCanvas),layer,c:lc,shade,column,
      x:Math.round(chromeRect.x+x0*scaleX),y:Math.round(chromeRect.y+y0*scaleY)};
  }));
  c.clearRect(0,0,surface.width,surface.height);
  c.drawImage(images.shellAlpha,0,0);
  const cutout=c.getImageData(0,0,surface.width,surface.height);
  for(let i=0;i<cutout.data.length;i+=4) {
    if(cutout.data[i+1]>180&&cutout.data[i]<100&&cutout.data[i+2]<100)cutout.data[i+3]=0;
  }
  // Replace only the original blue meter material, keeping its bevel and gold occluders.
  const cx=(dial.x0+dial.x1)/2,cy=(dial.y0+dial.y1)/2,hole=(dial.x1-dial.x0)/2;
  const inner=hole*1.155,outer=hole*1.405,left=Math.floor(cx-outer-2),top=Math.floor(cy-outer-2),size=Math.ceil(outer*2+4);
  const track=makeCanvas(size,size),tc=track.getContext('2d'),pixels=tc.createImageData(size,size);
  let trackPixels=0;
  for(let py=0;py<size;py++)for(let px=0;px<size;px++){
    const sx=left+px,sy=top+py,i=(sy*width+sx)*4,distance=Math.hypot(sx-cx,sy-cy);
    const r=cutout.data[i],g=cutout.data[i+1],b=cutout.data[i+2];
    if(sy>cy+hole*.9||distance<=inner||distance>=outer||b-r<24||g<r*.9||cutout.data[i+3]===0)continue;
    const coverage=Math.min(1,(distance-inner)/1.3,(outer-distance)/1.3),light=r*.2+g*.5+b*.3,j=(py*size+px)*4;
    pixels.data[j]=30+light*.4;pixels.data[j+1]=125+light*.5;pixels.data[j+2]=Math.min(255,155+light*.6);
    pixels.data[j+3]=Math.round(cutout.data[i+3]*coverage);
    cutout.data[i]=Math.round(r*(1-coverage)+(6+light*.1)*coverage);
    cutout.data[i+1]=Math.round(g*(1-coverage)+(25+light*.2)*coverage);
    cutout.data[i+2]=Math.round(b*(1-coverage)+(44+light*.35)*coverage);trackPixels++;
  }
  if(trackPixels<1000)throw new Error('No se puede localizar la barra exterior del contador');
  tc.putImageData(pixels,0,0);
  timerDial.track={image:await createImageBitmap(track),x:chromeRect.x+left*scaleX,y:chromeRect.y+top*scaleY,w:size*scaleX,h:size*scaleY};
  c.putImageData(cutout,0,0);
  chrome=await createImageBitmap(surface);
}

function drawText(value,x,y,size,color='#f4fbff',weight=700,tracking=0,maxWidth=Infinity,centerInk=false) {
  ctx.save();ctx.font=`${weight} ${size}px "Trebuchet MS", Arial, sans-serif`;
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;
  if('letterSpacing' in ctx)ctx.letterSpacing=`${tracking}px`;
  const measured=ctx.measureText(value).width;
  if(measured>maxWidth)ctx.font=`${weight} ${Math.floor(size*maxWidth/measured)}px "Trebuchet MS", Arial, sans-serif`;
  if(centerInk){
    ctx.textBaseline='alphabetic';const m=ctx.measureText(value);
    ctx.fillText(value,x+(m.actualBoundingBoxLeft-m.actualBoundingBoxRight)/2,y+(m.actualBoundingBoxAscent-m.actualBoundingBoxDescent)/2);
  }else ctx.fillText(value,Math.round(x),Math.round(y));ctx.restore();
}

const numberCache=new Map();
function resultAmount(value,positive) {
  const neutral=positive===null;
  const key=`${value}/${positive}`;
  let sprite=numberCache.get(key);
  if(!sprite){
    const layer=makeCanvas(730,190);const c=layer.getContext('2d');
    let size=120;c.font=`${size}px "Lilita One"`;
    if(c.measureText(value).width>560)size=Math.floor(size*560/c.measureText(value).width);
    c.font=`${size}px "Lilita One"`;c.textAlign='center';c.textBaseline='alphabetic';
    const metrics=c.measureText(value),cx=365+(metrics.actualBoundingBoxLeft-metrics.actualBoundingBoxRight)/2,cy=94+(metrics.actualBoundingBoxAscent-metrics.actualBoundingBoxDescent)/2;
    c.shadowColor=neutral?'#83a8cd':positive?'#36ffc7':'#ff6d94';c.shadowBlur=18;
    c.fillStyle=neutral?'#d1e2f3':positive?'#a4ffe4':'#ffc1ce';c.fillText(value,cx,cy);
    c.shadowBlur=0;c.fillStyle=neutral?'#42607f':positive?'#198b80':'#913b65';c.fillText(value,cx,cy+5);
    const fill=c.createLinearGradient(0,35,0,155);
    fill.addColorStop(0,neutral?'#f4f8ff':positive?'#f2fff5':'#fff1f3');fill.addColorStop(.46,neutral?'#d2e4f5':positive?'#bdffe5':'#ffcbd5');fill.addColorStop(1,neutral?'#a4bed8':positive?'#62f0c6':'#ff8eb2');
    c.lineWidth=1.1;c.strokeStyle=neutral?'#eff7ff':positive?'#e7fff3':'#ffe8ee';c.strokeText(value,cx,cy);c.fillStyle=fill;c.fillText(value,cx,cy);
    sprite={image:layer,height:metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent+5};
    numberCache.set(key,sprite);if(numberCache.size>24)numberCache.delete(numberCache.keys().next().value);
  }
  return sprite;
}

function drawResultTitle(y) {
  ctx.save();ctx.font='36px "Lilita One"';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle='#c7fbff';ctx.shadowColor='#49cfe8';ctx.shadowBlur=8;
  if('letterSpacing'in ctx)ctx.letterSpacing='2px';ctx.textBaseline='alphabetic';
  const m=ctx.measureText('NETO ACUMULADO');ctx.fillText('NETO ACUMULADO',498+(m.actualBoundingBoxLeft-m.actualBoundingBoxRight)/2,y+(m.actualBoundingBoxAscent-m.actualBoundingBoxDescent)/2);ctx.restore();
}

function rng(seed) { return () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296; }; }
const random=rng(5082);
const stars=Array.from({length:115},()=>({x:random()*W,y:random()*H,r:.9+random()*2.8,
  depth:.3+random()*.7,speed:14+random()*34,phase:random()*Math.PI*2}));
let sceneTime=0,lastFrame=0,lastPaint=0;

function background(time) {
  const image=images.scene;
  const cover=Math.max(W/image.naturalWidth,H/image.naturalHeight)*1.14;
  const dw=image.naturalWidth*cover,dh=image.naturalHeight*cover;
  const dx=(W-dw)/2+Math.sin(time/15)*48,dy=(H-dh)/2+Math.cos(time/19)*30;
  ctx.drawImage(image,dx,dy,dw,dh);
  ctx.save();
  for(const star of stars) {
    const x=(star.x-time*star.speed*.52+W*10)%W;
    const y=(star.y+Math.sin(time*.17+star.phase)*18*star.depth+H)%H;
    const pulse=.28+.34*(.5+.5*Math.sin(time*1.25+star.phase));
    ctx.globalAlpha=pulse;ctx.fillStyle=star.depth>.7?'#d2fdff':'#93baff';
    ctx.beginPath();ctx.arc(x,y,star.r*star.depth,0,Math.PI*2);ctx.fill();
  }
  const streak=(time%13)/2.1;
  if(streak<1) {
    const x=1030-streak*600,y=150+streak*340;
    const line=ctx.createLinearGradient(x,y,x+110,y-62);
    line.addColorStop(0,'#dcffff');line.addColorStop(1,'#92dfff00');
    ctx.globalAlpha=Math.sin(streak*Math.PI)*.7;ctx.strokeStyle=line;ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+110,y-62);ctx.stroke();
  }
  ctx.restore();
}

function planOutcome(row, event={kind:'none'}, preview=false, advance=true) {
  let held=state.held;
  if(preview)return {symbols:preview==='loss'?randomCombination():['btc','btc','btc'],held:0,event:{kind:'effect-preview'},preview:true,previewKind:preview===true?'win':preview};
  if(event.kind==='opened')held=1;
  else if(event.kind.startsWith('closed-') || row.position?.side==='flat')held=0;
  else if(row.position?.size>0 && advance)held=Math.min(2,Math.max(1,held+1));
  const heldSymbols=Array.from({length:held},()=> 'btc');
  const view=presentation(event,{symbols:heldSymbols});
  return {symbols:view.symbols,held,event,preview:false};
}

function settle(plan,row,react=true) {
  const at=performance.now(),previousBalance=animatedBalance(state.balanceTween,state.current?.paper.netPnlUsd,at,state.motion).value;
  state.balanceTween=react?closeBalanceTransition(plan.event,previousBalance,row.paper.netPnlUsd,at):null;
  state.current=row;state.symbols=plan.symbols;state.held=plan.held;state.outcome=plan.event;state.effectPreview=plan.preview;
  state.previewKind=plan.previewKind||'';
  state.eventAt=react?at:-Infinity;
  const cue=react?resultCue(plan.event,state.previewKind):null;
  state.cue=cue?{...cue,at:state.eventAt}:null;
  state.winAt=react&&(plan.event.kind==='closed-win'||state.previewKind==='win')?state.eventAt:0;
  if(react)sound.outcome(plan.event,state.previewKind);
}

async function prepareMotionSprites() {
  await Promise.all(SYMBOLS.map(async name=>{
    const surface=makeCanvas(256,448),c=surface.getContext('2d');
    c.filter='blur(8px)';
    for(let offset=-72;offset<=72;offset+=24){c.globalAlpha=offset===0?.24:.13;c.drawImage(images[name],24,120+offset,208,208);}
    images[`${name}Motion`]=await createImageBitmap(surface);
  }));
}

function drawReels(now) {
  const spin=state.spin;
  if(spin&&!spin.frozen&&spin.target&&spin.confirmed&&now-spin.start>=(state.motion?900:300)){
    spin.frozen=true;
    spin.retained=spin.reels.map((_,column)=>column<state.held&&spin.plan.held>=state.held&&!spin.plan.event.kind.startsWith('closed-'));
    spin.reels=spin.reels.map((reel,column)=>spin.retained[column]?reel:lockReel(reel,now,spin.plan.symbols[column],state.motion?1100+column*180:450));
    spin.endAt=Math.max(now,...spin.reels.filter((_,column)=>!spin.retained[column]).map(reel=>reel.landing.startedMs+reel.landing.durationMs));
  }
  let allStopped=Boolean(spin?.frozen);
  for(const win of windows){
    const c=win.c,column=win.column;
    c.clearRect(0,0,win.layer.width,win.layer.height);c.fillStyle=win.shade;c.fillRect(0,0,win.layer.width,win.layer.height);
    const retained=spin?(spin.frozen?spin.retained[column]:column<state.held&&(!spin.plan||spin.plan.held>=state.held)&&!spin.plan?.event.kind.startsWith('closed-')):false;
    const moving=Boolean(spin&&!retained),reel=moving?spin.reels[column]:state.restingReels[column];
    const frame=reel?reelFrame(reel,now):{position:0,velocity:0,stopped:true};
    if(moving&&!frame.stopped)allStopped=false;
    if(moving&&frame.stopped&&!spin.stops.has(column)){spin.stops.add(column);sound.reelStop(column);}
    const cx=centers[column]-win.x,cy=reelCenterY-win.y;
    if(moving&&!state.motion){
      const end=reel.landing?reel.landing.startedMs+reel.landing.durationMs:Infinity;
      const reveal=Math.max(0,Math.min(1,(now-end+220)/220));
      c.globalAlpha=1-reveal;c.drawImage(images.processorMotion,cx-128,cy-224,256,448);
      if(reveal>0){c.globalAlpha=reveal;c.drawImage(images[spin.plan.symbols[column]],cx-104,cy-104,208,208);}
    }else{
      const blur=moving?Math.max(0,Math.min(1,(frame.velocity-.6)/3)):0;
      const base=Math.floor(frame.position),centerIndex=reel?.landing?.index??0;
      for(let k=-3;k<=3;k++){
        const index=base+k,name=reel?reelSymbol(reel,index):index===0?state.symbols[column]:SYMBOLS[((index*3+column)%SYMBOLS.length+SYMBOLS.length)%SYMBOLS.length];
        const y=cy+(frame.position-index)*SYMBOL_STEP_PX;
        const alpha=index===centerIndex?1:.28+.72*Math.min(1,frame.velocity/3);
        if(blur<1){c.globalAlpha=alpha*(1-blur);c.drawImage(images[name],cx-104,y-104,208,208);}
        if(blur>0){c.globalAlpha=alpha*blur;c.drawImage(images[`${name}Motion`],cx-128,y-224,256,448);}
      }
    }
    c.globalAlpha=1;c.globalCompositeOperation='destination-in';c.drawImage(win.mask,0,0,win.layer.width,win.layer.height);
    c.globalCompositeOperation='source-over';ctx.drawImage(win.layer,win.x,win.y);
    if(!moving&&column<state.held){
      ctx.save();ctx.strokeStyle='#ffe1a0';ctx.lineWidth=4;ctx.beginPath();ctx.roundRect(centers[column]-93,reelCenterY-106,186,212,22);ctx.stroke();ctx.restore();
    }
  }
  if(spin&&allStopped){
    state.restingReels=spin.reels.map((reel,column)=>spin.retained[column]?state.restingReels[column]:reel);
    state.spin=null;
    if(state.pendingExecution){
      state.symbols=spin.plan.symbols;state.held=spin.plan.held;
      const pending=state.pendingExecution;state.pendingExecution=null;
      beginSpin(pending.row,pending.event,false,{advance:false,kind:'execution'});
    }else{settle(spin.plan,spin.target);updatePanel();}
  }else if(spin&&!spin.frozen&&now-spin.start>12000){
    state.current={...state.current,validDecision:false};state.spin=null;state.error='La consulta no ha devuelto una decisión confirmada';
    sound.stopSpin();sound.outcome({kind:'closed-unverified'});updatePanel();
  }
}

function drawWin(now) {
  if(!state.winAt || state.spin)return;
  const elapsed=(now-state.winAt)/1000;
  if(elapsed>9)return;
  ctx.save();ctx.strokeStyle='#ffe1a0';ctx.lineWidth=5;ctx.shadowColor='#ffbd49';ctx.shadowBlur=20;
  ctx.beginPath();ctx.moveTo(centers[0]-85,reelCenterY);ctx.lineTo(centers[2]+85,reelCenterY);ctx.stroke();
  ctx.shadowBlur=0;
  if(state.motion){
    for(let i=0;i<36;i++){
      const phase=(elapsed*.35+i*.137)%1,x=498+Math.sin(i*2.399)*phase*350,y=reelCenterY-Math.cos(i*2.399)*phase*260+phase*phase*160;
      ctx.globalAlpha=(1-phase)*.9;ctx.fillStyle=i%2?'#fff0b5':'#ffc75d';ctx.fillRect(x,y,4,8);
    }
  }
  ctx.restore();
}

function drawTimer(now) {
  const row=state.lastLive||state.current,spinning=state.spin;
  const reading=timerReadout({now:Date.now(),mode:state.mode,tickMs:row?.tickMs||60000,cycle:state.cycle,
    connected:state.connected,stale:row&&Date.now()-row.ts>row.tickMs*2+15000,
    spin:spinning?{elapsed:now-spinning.start,duration:spinning.frozen?spinning.endAt-spinning.start:spinning.confirmed?(state.motion?2600:1600):12000,waiting:!spinning.confirmed,label:spinning.kind==='execution'?'AVANCE':undefined}:null});
  const progress=Math.round(reading.progress*100),description=`${reading.value} · ${reading.label}`;
  if(timerAccessible!==`${progress}/${description}`){
    $('cycle-progress').setAttribute('aria-label',spinning?'Progreso de la tirada':state.mode==='replay'?'Cadencia de las consultas':'Tiempo hasta la siguiente consulta');
    $('cycle-progress').setAttribute('aria-valuenow',String(progress));
    $('cycle-progress').setAttribute('aria-valuetext',description);timerAccessible=`${progress}/${description}`;
  }
  const {x,y,radius,track}=timerDial;
  if(reading.progress>0){
    ctx.save();ctx.beginPath();ctx.moveTo(x,y);
    ctx.arc(x,y,radius*1.6,-Math.PI/2,-Math.PI/2+Math.PI*2*reading.progress);ctx.closePath();ctx.clip();
    ctx.drawImage(track.image,track.x,track.y,track.w,track.h);ctx.restore();
  }
  ctx.save();ctx.clip(timerDial.clip);
  const fill=ctx.createRadialGradient(x,y-20,0,x,y,radius);
  fill.addColorStop(0,'#10365b');fill.addColorStop(1,'#06162e');
  ctx.fillStyle=fill;ctx.beginPath();ctx.arc(x,y,radius-1,0,Math.PI*2);ctx.fill();
  ctx.textAlign='center';ctx.textBaseline='alphabetic';
  const lines=[{value:reading.value,size:44,weight:800},{value:reading.label,size:18,weight:700}];
  for(const line of lines){ctx.font=`${line.weight} ${line.size}px "Trebuchet MS", Arial, sans-serif`;line.metrics=ctx.measureText(line.value);}
  const height=lines.reduce((sum,line)=>sum+line.metrics.actualBoundingBoxAscent+line.metrics.actualBoundingBoxDescent,0)+9;
  let baseline=y-height/2;
  for(const line of lines){
    const m=line.metrics;baseline+=m.actualBoundingBoxAscent;
    ctx.font=`${line.weight} ${line.size}px "Trebuchet MS", Arial, sans-serif`;ctx.fillStyle=reading.active?'#e5fdff':'#b9d4eb';
    ctx.fillText(line.value,x+(m.actualBoundingBoxLeft-m.actualBoundingBoxRight)/2,baseline);
    baseline+=m.actualBoundingBoxDescent+9;
  }
  ctx.restore();
}

function drawHud(now) {
  const row=state.current;
  if(!row){drawText(state.error?'SIN CONEXIÓN':'LEYENDO EL BOT',498,1077,34);drawText('—',498,1277,80,'#b7d2e8');return;}
  const stale=state.mode==='live' && Date.now()-row.ts>row.tickMs*2+15000;
  if(!state.spin) {
    for(let i=0;i<state.held;i++)drawText('RETENIDO',centers[i],reelLabelY,19,'#ffe2a3',800,1.2);
  }
  const winning=state.outcome.kind==='closed-win',preview=state.effectPreview;
  const title=state.spin?(state.spin.kind==='execution'?'AVANCE POR EJECUCIÓN':'GIRANDO RODILLOS'):
    stale?'DATOS DESACTUALIZADOS':state.error?'SIN SEÑAL VÁLIDA':
    preview?(state.previewKind==='loss'?'OPERACIÓN CERRADA':'COMBINACIÓN GANADORA'):winning?'¡JUGADA GANADORA!':
    state.outcome.kind==='closed-loss'?'CIERRE SIN GANANCIA':
    state.outcome.kind==='closed-unverified'?'CIERRE SIN VERIFICAR':
    row.position?.size>0?'OPERACIÓN EN CURSO':!row.validDecision?'CONSULTA SIN RESULTADO':'JUGADA SIN PREMIO';
  drawText(title,498,1077,44,'#fff7ff',800,.7,760);
  const balance=animatedBalance(state.balanceTween,row.paper.netPnlUsd,now,state.motion);
  if(state.balanceTween&&!balance.active)state.balanceTween=null;
  const result=accountReadout(balance.value);
  const amount=resultAmount(result.text,result.positive);
  ctx.save();ctx.font='36px "Lilita One"';const titleMetrics=ctx.measureText('NETO ACUMULADO');
  ctx.font='600 22px "Trebuchet MS", Arial, sans-serif';const captionMetrics=ctx.measureText('tras todos los costes');ctx.restore();
  const rows=scoreboardRows(scoreContainer.top,scoreContainer.bottom,
    titleMetrics.actualBoundingBoxAscent+titleMetrics.actualBoundingBoxDescent,amount.height,
    captionMetrics.actualBoundingBoxAscent+captionMetrics.actualBoundingBoxDescent);
  drawResultTitle(rows.title);
  ctx.save();ctx.translate(498,rows.amount);ctx.scale(1+balance.pulse,1+balance.pulse);ctx.translate(-498,-rows.amount);
  ctx.drawImage(amount.image,133,rows.amount-96.5);ctx.restore();
  drawText('tras todos los costes',498,rows.caption,22,'#d0f7ff',600,.4,Infinity,true);
  drawText(`IA $${row.paper.modelUsd.toFixed(4)}`,350,scoreContainer.footer,27,'#f2fcff',800,0,240,true);
  ctx.save();ctx.strokeStyle='#a7d9ed';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(498,scoreContainer.footer-12);ctx.lineTo(498,scoreContainer.footer+12);ctx.stroke();ctx.restore();
  drawText(`${row.totals.fills} EJEC.`,646,scoreContainer.footer,27,'#f2fcff',800,0,240,true);
  drawText('1 CONSULTA = 1 TIRADA',498,scoreContainer.capsule,22,'#d0ebfa',700,.3,285,true);
  if(stale)drawText('La animación no representa nuevas decisiones',498,1595,17,'#ffb8a0',600);
}

function drawGuides() {
  if(!state.guides)return;
  const {x,y,width,height}=SAFE_ZONE;
  ctx.save();ctx.fillStyle='#091020aa';ctx.fillRect(x+width,0,W-x-width,H);
  ctx.fillRect(0,y+height,W,H-y-height);ctx.fillRect(0,0,W,y);
  ctx.strokeStyle='#f7d581';ctx.lineWidth=2;ctx.setLineDash([12,12]);ctx.strokeRect(x,y,width,height);ctx.setLineDash([]);
  drawText('COMENTARIOS DEL LIVE',486,1750,23,'#ffdda2',700,2);ctx.restore();
}

function activeCue(now) {
  return state.cue&&cueProgress(state.cue,now,state.motion)?state.cue:null;
}

function drawMascot(now,x,y,size,reaction) {
  const key=reaction==='win'?'win':reaction==='loss'||reaction==='miss'?'loss':reaction==='curious'||reaction==='opened'||reaction==='signal'?'curious':'idle';
  if(key!==mascotKey){
    mascotPrevious=mascotClips[mascotKey];mascotKey=key;mascotChangedAt=now;
    const clip=mascotClips[key];clip.currentTime=state.motion?(key==='loss'?1:0):Math.min(2.5,clip.duration/2);
    if(state.motion)clip.play().catch(()=>{});
  }
  const clip=mascotClips[key],mix=state.motion?Math.min(1,(now-mascotChangedAt)/180):1;
  const bob=state.motion&&reaction==='idle'?Math.sin(sceneTime*1.15)*5:0;
  const tilt=state.motion&&reaction==='miss'?Math.sin(Math.min(1,(now-state.eventAt)/1400)*Math.PI)*.035:0;
  ctx.save();ctx.translate(x+size/2,y+size/2+bob);ctx.rotate(tilt);
  if(mix<1&&mascotPrevious?.readyState>=2){ctx.globalAlpha=1-mix;ctx.drawImage(mascotPrevious,-size/2,-size/2,size,size);}
  ctx.globalAlpha=mix;
  ctx.drawImage(clip.readyState>=2?clip:images.mascot,-size/2,-size/2,size,size);ctx.restore();
  if(mix===1&&mascotPrevious){if(mascotPrevious!==clip)mascotPrevious.pause();mascotPrevious=null;}
}

const resultBackdrop={};
function drawResultScene(now,cue) {
  const progress=cueProgress(cue,now,state.motion);if(!progress)return;
  const win=cue.kind==='win',accent=win?'#a4ffe4':'#e5bbff';
  if(!resultBackdrop[cue.kind]){
    const layer=makeCanvas(W,H),c=layer.getContext('2d');
    const shade=c.createRadialGradient(486,720,40,486,850,1100);
    shade.addColorStop(0,win?'#153e5cf0':'#302653f0');shade.addColorStop(1,'#020b22fc');
    c.fillStyle=shade;c.fillRect(0,0,W,H);resultBackdrop[cue.kind]=layer;
  }
  ctx.save();ctx.globalAlpha=progress.opacity;ctx.drawImage(resultBackdrop[cue.kind],0,0);
  if(state.motion){
    const t=progress.elapsed/1000;
    ctx.save();ctx.translate(486,680);ctx.rotate(t*(win?.09:-.035));
    for(let i=0;i<12;i++){
      ctx.rotate(Math.PI/6);ctx.fillStyle=win?'#ffd7830c':'#b499ed09';
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(-100,-1500);ctx.lineTo(100,-1500);ctx.closePath();ctx.fill();
    }ctx.restore();
    if(win)for(let i=0;i<28;i++){
      const phase=(t*.24+i*.137)%1,x=(i*193.7)%W,y=-200+phase*2250;
      const size=32+(i%4)*16;ctx.save();ctx.translate(x,y);ctx.rotate(t*(i%2?1:-1));ctx.globalAlpha=progress.opacity*.62;
      ctx.drawImage(images.btc,-size/2,-size/2,size,size);ctx.restore();
    }
    else {
      ctx.save();ctx.strokeStyle='#b1a0e8';ctx.globalAlpha=progress.opacity*.22;ctx.lineWidth=3;
      ctx.beginPath();ctx.ellipse(486,760,100+t*250,60+t*150,0,0,Math.PI*2);ctx.stroke();ctx.restore();
    }
  }
  drawMascot(now,281,250,410,cue.kind);
  drawText('OPERACIÓN',486,700,42,'#d1e9ff',800,6,700);
  ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='100px "Lilita One"';
  ctx.fillStyle=win?'#ffe3a0':'#d8c7ff';ctx.shadowColor=win?'#f2a644':'#9d7aff';ctx.shadowBlur=22;
  ctx.fillText(win?'GANADORA':'CERRADA',486,797);ctx.restore();
  if(cue.netUsd!==null){
    const amount=money(cue.netUsd*progress.count,6);
    ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';let size=112;ctx.font=`${size}px "Lilita One"`;
    if(ctx.measureText(amount).width>710){size*=710/ctx.measureText(amount).width;ctx.font=`${size}px "Lilita One"`;}
    ctx.fillStyle=accent;ctx.shadowColor=win?'#36e6bc':'#976eda';ctx.shadowBlur=18;ctx.fillText(amount,486,940);ctx.restore();
    drawText('NETO DE ESTA OPERACIÓN',486,1030,28,'#c5d7f4',700,1,700);
  }
  drawText(cue.netUsd===null?(win?'Combinación completa':'Volvemos a observar el mercado'):win?'Beneficio registrado':'Volvemos a observar el mercado',486,1120,30,'#dfedff',700,0,700);
  if(state.current)drawText(`Cuenta: ${money(animatedBalance(state.balanceTween,state.current.paper.netPnlUsd,now,state.motion).value,4)}`,486,1230,27,'#adc8e5',700,0,700);
  ctx.restore();
}

function frame(now) {
  const interval=state.motion?0:state.spin||activeCue(now)?1000/30:250;
  if(now-lastPaint<interval){requestAnimationFrame(frame);return;}lastPaint=now;
  const delta=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;
  if(state.motion)sceneTime+=delta;
  background(sceneTime);
  const cue=activeCue(now),stale=state.mode==='live'&&state.current&&Date.now()-state.current.ts>state.current.tickMs*2+15000;
  const reaction=mascotReaction({spinning:Boolean(state.spin),error:state.error,stale,cue,event:state.outcome,elapsed:now-state.eventAt});
  ctx.save();ctx.translate(machineFit.tx,machineFit.ty);ctx.scale(machineFit.s,machineFit.s);
  drawReels(now);ctx.drawImage(chrome,chromeRect.x,chromeRect.y,chromeRect.w,chromeRect.h);drawTimer(now);drawWin(now);
  if(!cue)drawMascot(now,452,180,470,reaction);
  drawHud(now);ctx.restore();
  if(cue)drawResultScene(now,cue);
  drawGuides();requestAnimationFrame(frame);
}

function updatePanel() {
  const row=state.current;
  $('live-mode').setAttribute('aria-pressed',String(state.mode==='live'));
  $('replay-mode').setAttribute('aria-pressed',String(state.mode==='replay'));
  $('connection').textContent=state.error|| (state.mode==='replay'?'Reproduciendo una lectura guardada':state.connected?'Conectado al bot':'Leyendo el bot');
  $('connection-dot').className=`dot ${state.error?'error':state.mode==='replay'?'replay':state.connected?'live':''}`;
  if(row) {
    $('last-read').textContent=new Date(row.ts).toLocaleTimeString('es-ES');
    $('request-count').textContent=state.mode==='replay'?`Lectura ${state.replayIndex+1} / ${state.replay.length}`:String(state.lastLive?.requests??'—');
    $('ai-cost').textContent=`$${row.paper.modelUsd.toFixed(6)}`;
    $('account-mode').textContent=`${row.dryRun?'Simulación':'Trading real'}${row.paper.modelCostEstimated?' · costes estimados':''}`;
    const outcomeText=state.spin?(state.spin.kind==='execution'?'Avance por ejecución':'Consulta en curso'):state.effectPreview?`Prueba del efecto ${state.previewKind==='loss'?'de cierre':'ganador'}, sin cambio financiero`:state.outcome.kind==='closed-win'?`Cierre con ganancia neta ${money(state.outcome.netUsd,6)}`:state.held?'Operación abierta con símbolos retenidos':state.outcome.kind==='closed-loss'?'Cierre sin ganancia':state.outcome.kind==='closed-unverified'?'Cierre sin verificar; costes o historial incompletos':'Jugada sin premio';
    $('accessible-state').textContent=`${outcomeText}; cuenta neta ${money(row.paper.netPnlUsd)} dólares. ${state.error}`;
    canvas.setAttribute('aria-label',`Jev Orbit. ${row.dryRun?'Simulación':'Trading real'}. ${outcomeText}. Combinación ${state.symbols.join(', ')}. ${state.mode==='replay'?'Repetición.':''}`);
    if(state.outcome.kind==='closed-win'&&!state.spin){
      $('detail').textContent=`Cierre: ${money(state.outcome.netUsd,6)} netos${state.outcome.estimated?' estimados':''}. El marcador mantiene el neto acumulado de la cuenta.`;
    }
  }
  $('spin').disabled=!state.ready || Boolean(state.spin);
}

function beginSpin(target,event={kind:'none'},preview=false,{advance=true,kind='query'}={}) {
  const start=performance.now();
  state.spin={start,target,plan:target?planOutcome(target,event,preview,advance):null,stops:new Set(),
    reels:[0,1,2].map(column=>createReel(start,column)),frozen:false,confirmed:state.mode==='replay'||kind==='execution',kind};
  sound.startSpin();state.error='';state.effectPreview=false;state.previewKind='';state.cue=null;state.outcome={kind:'none'};state.winAt=0;updatePanel();
  $('detail').textContent=preview?'Prueba del efecto: no representa un cierre ni modifica el balance.':kind==='execution'?'Avance por una ejecución confirmada; no es una nueva consulta.':state.mode==='replay'?'Jugada basada en una operación guardada. No envía consultas ni órdenes.':'Esperando una lectura confirmada antes de frenar los rodillos.';
}

async function observeTrade(next, kind, generation) {
  let detected={kind:'none'};
  if(kind==='request'&&Number.isFinite(liveTracker.lastRow?.block)){
    const lastBlock=liveTracker.lastRow.block;
    try{
      const response=await fetch('/api/history',{cache:'no-store',signal:AbortSignal.timeout(6000)});
      if(response.ok){
        const body=await response.json();
        if(generation!==state.generation)return detected;
        const rows=Array.isArray(body.BTC)?body.BTC:[];
        // Re-read the previous block revision to recover fills between polls.
        for(const row of rows.filter(r=>r.block>=lastBlock&&r.ts<=next.ts)){
          const event=liveTracker.ingest(row);
          if(event.kind!=='none')detected=event;
        }
      }
    }catch{/* Missing history leaves the tracker conservative about gaps. */}
  }
  if(generation!==state.generation)return detected;
  const latest=liveTracker.ingest(next);
  return latest.kind==='none'?detected:latest;
}

async function poll(generation) {
  if(state.mode!=='live'||generation!==state.generation)return;
  pollController=new AbortController();
  try {
    const response=await fetch('/api',{signal:AbortSignal.any([pollController.signal,AbortSignal.timeout(16000)]),cache:'no-store'});
    if(!response.ok)throw new Error('No se puede leer el bot');
    const next=normalizeMeta(await response.json());
    if(generation!==state.generation)return;
    const kind=classifyUpdate(state.lastLive,next);
    state.cycle=updateCycle(kind==='reset'?null:state.cycle,next);
    if(kind==='reset')liveTracker.reset();
    const tradeEvent=await observeTrade(next,kind,generation);
    if(generation!==state.generation)return;
    if(kind==='initial'||kind==='reset') {
      state.held=liveTracker.hasOpenPosition?1:0;
      settle(planOutcome(next,{kind:'none'},false,false),next,false);state.spin=null;
    }
    else if(kind==='request')beginSpin(hasReelResult(next.validDecision,tradeEvent)?next:null,tradeEvent);
    else if(state.spin&&!state.spin.frozen){
      if(hasReelResult(next.validDecision,tradeEvent)||hasReelResult(false,state.spin.plan?.event)){
        state.spin.confirmed=true;state.spin.target=next;
        if(!state.spin.plan||tradeEvent.kind!=='none')state.spin.plan=planOutcome(next,tradeEvent,false,false);
      }
    }
    else if(tradeEvent.kind!=='none'){
      if(state.spin)state.pendingExecution={row:next,event:tradeEvent};
      else beginSpin(next,tradeEvent,false,{advance:false,kind:'execution'});
    }
    else if(!state.spin)state.current=next;
    if(state.balanceTween&&!state.spin)state.balanceTween.to=state.current.paper.netPnlUsd;
    state.lastLive=next;state.connected=true;state.error='';updatePanel();
  }catch(error) {
    if(generation!==state.generation)return;
    state.connected=false;state.error=error.name==='AbortError'?'Lectura interrumpida':'Sin conexión con el bot';updatePanel();
    $('detail').textContent='Los últimos valores permanecen visibles. No se han sustituido por cifras de prueba.';
  }finally{if(generation===state.generation&&state.mode==='live')pollTimer=setTimeout(()=>poll(generation),4000);}
}

function decorateReplay(row,index=0) {
  return {...row,dryRun:true,tickMs:60000,requests:row.paper?.usage?.allTime?.requests??null,historyIndex:index,
    validDecision:Boolean(row.decision&&!row.decision.late&&['open','hold','close'].includes(row.decision.intent))};
}

function prepareHistory(rows) {
  state.history=rows;
  const scan=new TradeTracker();
  state.replayEvents=rows.map((row,index)=>({index,event:scan.ingest(row)}));
  state.replay=rows.map(decorateReplay).filter(row=>Number.isFinite(row.paper?.netPnlUsd)&&Number.isFinite(row.paper?.modelUsd)&&Number.isFinite(row.totals?.fills));
  state.replayIndex=Math.max(0,state.replay.length-3);
  liveTracker=new TradeTracker().initialize(rows);
}

async function refreshHistory(generation) {
  try{
    const response=await fetch('/api/history',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('History unavailable');
    const body=await response.json();
    if(!Array.isArray(body.BTC))throw new Error('Invalid history');
    if(generation===state.generation)prepareHistory(body.BTC);
  }catch{if(generation===state.generation)liveTracker=new TradeTracker();}
}

function setMode(mode) {
  sound.clearGame();state.cycle=null;state.balanceTween=null;state.restingReels=[];state.pendingExecution=null;
  state.generation++;clearTimeout(pollTimer);pollController?.abort();state.mode=mode;state.spin=null;state.error='';
  state.held=0;state.effectPreview=false;state.previewKind='';state.cue=null;state.eventAt=-Infinity;state.outcome={kind:'none'};state.winAt=0;state.symbols=randomCombination();
  $('detail').textContent=mode==='live'?'Los símbolos son visuales. El marcador muestra el neto acumulado.':'Repetición de lecturas guardadas. No envía consultas ni órdenes.';
  if(mode==='live') {
    state.lastLive=null;state.current=null;state.connected=false;
    const generation=state.generation;
    refreshHistory(generation).finally(()=>{if(generation===state.generation)poll(generation);});
  }
  else {
    const selected=state.replay[state.replayIndex];
    if(!selected){
      state.error='No hay historial vivo disponible para repetir';
      $('detail').textContent='La repetición necesita una respuesta válida de /api/history.';
      updatePanel();
      return;
    }
    replayTracker=new TradeTracker().initialize(state.history.slice(0,selected.historyIndex+1));
    state.current=selected;state.held=replayTracker.hasOpenPosition?1:0;state.connected=false;
    state.symbols=randomCombination(Math.random,Array.from({length:state.held},()=> 'btc'));
  }
  updatePanel();
}

function replaySpin() {
  if(!state.ready||state.spin)return;
  state.balanceTween=null;
  if(state.mode!=='replay')setMode('replay');
  if(!state.replay.length){
    state.error='No hay historial vivo disponible para repetir';
    $('detail').textContent='La repetición necesita una respuesta válida de /api/history.';
    updatePanel();
    return;
  }
  const scenario=$('scenario').value;
  if(scenario==='effect'||scenario==='loss-effect'){
    state.held=0;beginSpin(state.current,{kind:'none'},scenario==='effect'?'win':'loss');return;
  }
  if(scenario==='open'||scenario==='close'||scenario==='win') {
    const selected=state.replayEvents.findLast(item=>scenario==='open'?item.event.kind==='opened':scenario==='win'?item.event.kind==='closed-win':item.event.kind==='closed-loss');
    const match=selected?state.replay.findIndex(row=>row.historyIndex===selected.index):-1;
    if(match<0){$('detail').textContent='No hay una operación de ese tipo en el historial disponible.';return;}
    state.replayIndex=match;
  }else state.replayIndex=(state.replayIndex+1)%state.replay.length;
  const next=state.replay[state.replayIndex];
  const previousEpisode=replayTracker.active?.id,previousHeld=state.held;
  replayTracker=new TradeTracker().initialize(state.history.slice(0,next.historyIndex));
  const previous=replayTracker.lastRow;
  if(previous && Number.isFinite(previous.paper?.netPnlUsd))state.current=decorateReplay(previous,next.historyIndex-1);
  state.held=replayTracker.hasOpenPosition?(replayTracker.active?.id===previousEpisode?Math.max(1,previousHeld):1):0;
  const tradeEvent=replayTracker.ingest(next);
  beginSpin(next,tradeEvent);
}

$('live-mode').addEventListener('click',()=>setMode('live'));
$('replay-mode').addEventListener('click',()=>setMode('replay'));
$('spin').addEventListener('click',replaySpin);
$('motion').addEventListener('change',(event)=>{state.motion=event.target.checked;for(const [key,clip] of Object.entries(mascotClips)){if(state.motion&&key===mascotKey)clip.play().catch(()=>{});else clip.pause();}});
$('safe-zones').addEventListener('change',(event)=>{state.guides=event.target.checked;});
function setBroadcast(enabled){document.body.classList.toggle('broadcast',enabled);}
$('broadcast').addEventListener('click',()=>setBroadcast(true));
$('leave-broadcast').addEventListener('click',()=>setBroadcast(false));
document.addEventListener('keydown',(event)=>{
  if(event.key==='Escape')setBroadcast(false);
  if(event.code==='KeyM'&&!event.repeat&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)){event.preventDefault();toggleAudio();}
  if(event.code==='Space'&&!['INPUT','BUTTON','SELECT','TEXTAREA'].includes(document.activeElement.tagName)){event.preventDefault();replaySpin();}
});
$('capture').addEventListener('click',()=>canvas.toBlob((blob)=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='jev-orbit-canvas.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);},'image/png'));

try {
  await Promise.all(['scene','shell','mascot'].map(name=>loadImage(name,`/orbit/assets/${name==='shell'?'shell-complete-raw':name==='mascot'?'mascot-alpha':'scene'}.png`))
    .concat([loadImage('shellAlpha','/orbit/assets/shell-complete-alpha.png')])
    .concat(['btc','bull','bear','hold','exit','processor'].map(name=>loadImage(name,`/orbit/assets/icons/${name}.png`))));
  const layout=await fetch('/orbit/assets/shell-complete-layout.json').then(r=>{if(!r.ok)throw new Error('No se puede cargar el encuadre');return r.json();});
  Object.assign(chromeRect,layout.chrome);machineFit=fitStage(layout.fit);seedFractions=layout.seedFractions;
  await prepareChrome();await prepareMotionSprites();
  await document.fonts.load('136px "Lilita One"');
  await Promise.all(['idle','curious','win','loss'].map(key=>new Promise((resolve,reject)=>{
    const clip=document.createElement('video');clip.muted=true;clip.loop=key==='idle'||key==='curious';clip.playsInline=true;clip.preload='auto';
    const timeout=setTimeout(()=>reject(new Error(`La animación ${key} no ha cargado`)),15000);
    clip.onloadeddata=()=>{clearTimeout(timeout);resolve();};clip.onerror=()=>{clearTimeout(timeout);reject(new Error(`No se puede cargar la mascota ${key}`));};
    clip.src=`/orbit/assets/mascot-${key}.webm`;mascotClips[key]=clip;
  })));
  robot=mascotClips.idle;if(state.motion)robot.play().catch(()=>{});
  state.ready=true;$('loading').hidden=true;$('capture').disabled=false;updatePanel();
  if(new URLSearchParams(location.search).has('broadcast'))setBroadcast(true);
  requestAnimationFrame(frame);setMode('live');
}catch(error){$('loading').textContent=error.message;$('connection').textContent='No se ha podido preparar la vista';}
