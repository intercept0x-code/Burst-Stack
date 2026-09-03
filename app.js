import LibRaw from 'libraw-wasm';
import './style.css';

const RAW_EXTS = new Set(['dng','cr2','cr3','nef','arw','raf','rw2','orf']);
const $ = (s) => document.querySelector(s);
const state = {
  files: [], frames: [], cv: null, cvReady: false, busy: false,
  mode: 'balanced', scale: 2, result: null, before: null,
  outputName: 'burststacked.png', stats: null,
};

const els = {
  fileInput: $('#fileInput'), pick: $('#pickFilesBtn'), add: $('#addMoreBtn'), clear: $('#clearBtn'),
  drop: $('#dropZone'), empty: $('#emptyState'), framesCard: $('#framesCard'), controls: $('#controlsCard'),
  frameStrip: $('#frameStrip'), frameSummary: $('#frameSummary'), combine: $('#combineBtn'), save: $('#saveBtn'),
  enginePill: $('#enginePill'), engineText: $('#engineText'), processCard: $('#processCard'),
  processTitle: $('#processTitle'), processDetail: $('#processDetail'), progressPct: $('#progressPct'),
  progressBar: $('#progressBar'), stepStrip: $('#stepStrip'), resultStage: $('#resultStage'),
  resultCanvas: $('#resultCanvas'), beforeCanvas: $('#beforeCanvas'), resultMeta: $('#resultMeta'),
  compareSlider: $('#compareSlider'), beforeLayer: $('#beforeLayer'), compareLine: $('#compareLine'),
  motion: $('#motionRange'), sharpWeight: $('#sharpWeightRange'), exposure: $('#exposureRange'),
  brightness: $('#brightnessRange'), detail: $('#detailRange'), adaptive: $('#adaptiveToggle'),
  motionValue: $('#motionValue'), sharpWeightValue: $('#sharpWeightValue'), exposureValue: $('#exposureValue'),
  brightnessValue: $('#brightnessValue'), detailValue: $('#detailValue'), resolutionValue: $('#resolutionValue'), toast: $('#toast')
};

function toast(msg) {
  els.toast.textContent = msg; els.toast.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

function extOf(name) { return name.split('.').pop().toLowerCase(); }
function isRaw(file) { return RAW_EXTS.has(extOf(file.name)); }
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function sleepFrame(){return new Promise(r=>requestAnimationFrame(()=>r()));}

async function loadOpenCV() {
  try {
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.x/opencv.js';
    script.async = true;
    document.head.appendChild(script);
    await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;});
    let cvObj = window.cv;
    if (cvObj instanceof Promise) cvObj = await cvObj;
    const start = performance.now();
    while (!cvObj?.Mat) {
      if (performance.now()-start > 20000) throw new Error('OpenCV initialization timed out');
      await new Promise(r=>setTimeout(r,80));
      cvObj = window.cv instanceof Promise ? await window.cv : window.cv;
    }
    state.cv = cvObj; state.cvReady = true;
    els.enginePill.classList.add('ready'); els.engineText.textContent = 'Compute engine ready';
  } catch (err) {
    console.error(err); els.enginePill.classList.add('error'); els.engineText.textContent = 'Engine failed to load';
  }
}
loadOpenCV();

function syncRange(el, out){ out.textContent = el.value; }
[['motion', 'motionValue'],['sharpWeight','sharpWeightValue'],['exposure','exposureValue'],['brightness','brightnessValue'],['detail','detailValue']].forEach(([a,b])=>{
  els[a].addEventListener('input',()=>syncRange(els[a],els[b]));
});

$('#modeSegment').addEventListener('click', e => {
  const b=e.target.closest('button[data-mode]'); if(!b||state.busy)return;
  state.mode=b.dataset.mode; [...b.parentElement.children].forEach(x=>x.classList.toggle('active',x===b));
  const presets={
    balanced:[72,68,42,'Aligns repeated samples, suppresses random noise, rejects moving pixels, and gives sharper regions more influence instead of blindly averaging everything.'],
    detail:[55,92,28,'Prioritizes locally sharper samples and 2× sub-pixel reconstruction. Best when the scene is nearly still.'],
    motion:[92,52,28,'Aggressively rejects pixels that disagree with the reference frame to suppress double edges and moving-subject ghosts.'],
    exposure:[66,60,92,'Weights well-exposed pixels more strongly so brighter and darker frames can contribute where each contains better usable signal.']
  };
  const p=presets[state.mode]; els.motion.value=p[0];els.sharpWeight.value=p[1];els.exposure.value=p[2];
  syncRange(els.motion,els.motionValue);syncRange(els.sharpWeight,els.sharpWeightValue);syncRange(els.exposure,els.exposureValue);$('#whyText').textContent=p[3];
});

$('#resolutionSegment').addEventListener('click',e=>{
  const b=e.target.closest('button[data-scale]'); if(!b||state.busy)return;
  state.scale=Number(b.dataset.scale); [...b.parentElement.children].forEach(x=>x.classList.toggle('active',x===b));
  els.resolutionValue.textContent=state.scale===2?'2× reconstruct':'1× native';
});

function openPicker(){if(!state.busy)els.fileInput.click();}
els.pick.addEventListener('click',openPicker); els.add.addEventListener('click',openPicker);
els.fileInput.addEventListener('change',e=>{addFiles([...e.target.files]);e.target.value='';});

for(const ev of ['dragenter','dragover']) els.drop.addEventListener(ev,e=>{e.preventDefault();if(!state.busy)els.drop.classList.add('drag');});
for(const ev of ['dragleave','drop']) els.drop.addEventListener(ev,e=>{e.preventDefault();els.drop.classList.remove('drag');});
els.drop.addEventListener('drop',e=>{if(!state.busy)addFiles([...e.dataTransfer.files]);});

function addFiles(newFiles){
  const allowed=newFiles.filter(f=>f.type.startsWith('image/')||RAW_EXTS.has(extOf(f.name)));
  for(const file of allowed){
    const key=`${file.name}:${file.size}:${file.lastModified}`;
    if(!state.files.some(x=>x.key===key)) state.files.push({file,key,status:'ready'});
  }
  renderFiles();
}

function removeFile(key){if(state.busy)return;state.files=state.files.filter(x=>x.key!==key);renderFiles();}
function clearAll(){if(state.busy)return;state.files=[];state.frames=[];state.result=null;state.before=null;els.resultStage.classList.add('hidden');els.empty.classList.remove('hidden');els.save.classList.add('hidden');renderFiles();}
els.clear.addEventListener('click',clearAll);

function renderFiles(){
  const has=state.files.length>0; els.framesCard.classList.toggle('hidden',!has);els.controls.classList.toggle('hidden',!has);
  if(!state.result){els.empty.classList.toggle('hidden',has);}
  els.frameSummary.textContent=`${state.files.length} selected${state.files.some(x=>isRaw(x.file))?' · RAW included':''}`;
  els.frameStrip.innerHTML='';
  for(const item of state.files){
    const div=document.createElement('div');div.className='frame-item';
    const raw=isRaw(item.file);
    div.innerHTML=`<div class="frame-thumb">${raw?`<span class="raw-badge">${extOf(item.file.name).toUpperCase()}</span>`:`<img alt="" />`}</div><div class="frame-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div><span class="frame-tag ${item.status==='failed'?'bad':''}">${item.status==='reference'?'REF':item.status==='failed'?'SKIP':''}</span><button class="remove-frame" aria-label="Remove">×</button>`;
    div.querySelector('.remove-frame').onclick=()=>removeFile(item.key);
    if(!raw){const img=div.querySelector('img');const url=URL.createObjectURL(item.file);img.src=url;img.onload=()=>URL.revokeObjectURL(url);}
    els.frameStrip.appendChild(div);
  }
}
function escapeHtml(s){return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

function setProgress(p,title,detail,step){
  p=clamp(p,0,1);els.processCard.classList.remove('hidden');els.progressBar.style.width=`${Math.round(p*100)}%`;els.progressPct.textContent=`${Math.round(p*100)}%`;
  els.processTitle.textContent=title;els.processDetail.textContent=detail||'';
  const order=['decode','analyze','align','fuse','enhance'];const idx=order.indexOf(step);
  [...els.stepStrip.children].forEach((el,i)=>{el.classList.toggle('active',i===idx);el.classList.toggle('done',i<idx||(p===1&&i===idx));});
}

function chooseMaxSide(nativeW,nativeH,scale){
  if(!els.adaptive.checked) return Math.max(nativeW,nativeH);
  const mem=navigator.deviceMemory||4; const mobile=matchMedia('(max-width: 700px)').matches;
  if(scale===2){if(mem<=4||mobile)return 1900;if(mem<=8)return 2800;return 3600;}
  if(mem<=4||mobile)return 2600;if(mem<=8)return 3800;return 5000;
}

async function decodeRaw(file){
  const raw=new LibRaw();
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());
    await raw.open(bytes,{useCameraWb:true,useCameraMatrix:3,outputColor:1,outputBps:8,noAutoBright:true,highlight:2,userQual:3,fbddNoiserd:0});
    const out=await raw.imageData(); if(!out)throw new Error('RAW decoder returned no pixels');
    const {width,height,colors,bits,data}=out; const rgba=new Uint8ClampedArray(width*height*4); const max=bits>8?65535:255;
    for(let i=0,p=0;i<width*height;i++,p+=4){const o=i*colors;rgba[p]=Math.round(data[o]/max*255);rgba[p+1]=Math.round(data[o+1]/max*255);rgba[p+2]=Math.round(data[o+2]/max*255);rgba[p+3]=255;}
    return new ImageData(rgba,width,height);
  }finally{raw.dispose();}
}

async function decodeStandard(file,targetW=null,targetH=null){
  const bmp=await createImageBitmap(file,{imageOrientation:'from-image'}); const w=targetW||bmp.width,h=targetH||bmp.height;
  const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bmp,0,0,w,h);bmp.close();return ctx.getImageData(0,0,w,h);
}
async function resizeImageData(data,w,h){if(data.width===w&&data.height===h)return data;const c=document.createElement('canvas');c.width=data.width;c.height=data.height;c.getContext('2d').putImageData(data,0,0);const out=document.createElement('canvas');out.width=w;out.height=h;out.getContext('2d').drawImage(c,0,0,w,h);return out.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h);}
async function decodeFirst(file){return isRaw(file)?decodeRaw(file):decodeStandard(file);}
async function decodeTo(file,w,h){if(isRaw(file))return resizeImageData(await decodeRaw(file),w,h);return decodeStandard(file,w,h);}

function matFromImageData(img){const cv=state.cv;return cv.matFromArray(img.height,img.width,cv.CV_8UC4,img.data);}
function grayOf(src){const cv=state.cv,g=new cv.Mat();cv.cvtColor(src,g,cv.COLOR_RGBA2GRAY);return g;}
function resizeMatMax(src,maxSide){const cv=state.cv;const s=Math.min(1,maxSide/Math.max(src.cols,src.rows));if(s===1)return {mat:src.clone(),scale:1};const m=new cv.Mat();cv.resize(src,m,new cv.Size(Math.round(src.cols*s),Math.round(src.rows*s)),0,0,cv.INTER_AREA);return{mat:m,scale:s};}
function sharpnessScore(src){const cv=state.cv;const {mat}=resizeMatMax(src,1100);const g=grayOf(mat),lap=new cv.Mat();cv.Laplacian(g,lap,cv.CV_32F,3,1,0,cv.BORDER_DEFAULT);const a=lap.data32F;let sum=0,sum2=0;for(let i=0;i<a.length;i+=2){const v=a[i];sum+=v;sum2+=v*v;}const n=Math.ceil(a.length/2),mean=sum/n,score=sum2/n-mean*mean;mat.delete();g.delete();lap.delete();return score;}
function identityH(){const cv=state.cv;return cv.matFromArray(3,3,cv.CV_64F,[1,0,0,0,1,0,0,0,1]);}
function hArray(H){return Array.from(H.data64F.length?H.data64F:H.data32F);}
function matH(a){return state.cv.matFromArray(3,3,state.cv.CV_64F,a);}
function multiplyH(A,B){const a=hArray(A),b=hArray(B),o=new Array(9).fill(0);for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++)o[r*3+c]+=a[r*3+k]*b[k*3+c];return matH(o);}
function rescaleHomography(H,fromScale){const a=hArray(H);a[2]/=fromScale;a[5]/=fromScale;a[6]*=fromScale;a[7]*=fromScale;return matH(a);}
function outputTransform(H,outScale,cropX,cropY){const S=matH([outScale,0,0,0,outScale,0,0,0,1]);const C=matH([1,0,-cropX*outScale,0,1,-cropY*outScale,0,0,1]);const t1=multiplyH(S,H),out=multiplyH(C,t1);S.delete();C.delete();t1.delete();return out;}

function translationFallback(moving,reference){
  const cv=state.cv;const max=700;const rm=resizeMatMax(moving,max),rr=resizeMatMax(reference,max);const mg=grayOf(rm.mat),rg=grayOf(rr.mat);const margin=Math.max(24,Math.round(Math.min(mg.cols,mg.rows)*.12));const roi=mg.roi(new cv.Rect(margin,margin,mg.cols-2*margin,mg.rows-2*margin));const result=new cv.Mat();cv.matchTemplate(rg,roi,result,cv.TM_CCOEFF_NORMED);const mm=cv.minMaxLoc(result);const dx=(mm.maxLoc.x-margin)/rr.scale,dy=(mm.maxLoc.y-margin)/rr.scale;const H=matH([1,0,dx,0,1,dy,0,0,1]);rm.mat.delete();rr.mat.delete();mg.delete();rg.delete();roi.delete();result.delete();return{H,inliers:0,fallback:true};
}

function estimateHomography(moving,reference){
  const cv=state.cv;const ms=resizeMatMax(moving,1500),rs=resizeMatMax(reference,1500);const mg=grayOf(ms.mat),rg=grayOf(rs.mat);
  const orb=new cv.ORB(5000,1.2,8,23,0,2,cv.ORB_HARRIS_SCORE,31,12),mask0=new cv.Mat(),kpM=new cv.KeyPointVector(),kpR=new cv.KeyPointVector(),dM=new cv.Mat(),dR=new cv.Mat();
  try{
    orb.detectAndCompute(mg,mask0,kpM,dM);orb.detectAndCompute(rg,mask0,kpR,dR);
    if(dM.empty()||dR.empty()||kpM.size()<18||kpR.size()<18)throw new Error('too few features');
    const bf=cv.BFMatcher.create?cv.BFMatcher.create(cv.NORM_HAMMING,true):new cv.BFMatcher(cv.NORM_HAMMING,true),matches=new cv.DMatchVector();bf.match(dM,dR,matches);
    const arr=[];for(let i=0;i<matches.size();i++)arr.push(matches.get(i));arr.sort((a,b)=>a.distance-b.distance);const take=arr.slice(0,Math.min(600,Math.max(30,Math.round(arr.length*.65)))).filter(m=>m.distance<72);
    if(take.length<12){bf.delete();matches.delete();throw new Error('too few reliable matches');}
    const src=[],dst=[];for(const m of take){const p=kpM.get(m.queryIdx).pt,q=kpR.get(m.trainIdx).pt;src.push(p.x,p.y);dst.push(q.x,q.y);}const sm=cv.matFromArray(take.length,1,cv.CV_32FC2,src),dm=cv.matFromArray(take.length,1,cv.CV_32FC2,dst),inlierMask=new cv.Mat();
    const hs=cv.findHomography(sm,dm,cv.RANSAC,3.2,inlierMask);let inliers=0;for(const v of inlierMask.data)if(v)inliers++;
    sm.delete();dm.delete();inlierMask.delete();bf.delete();matches.delete();if(hs.empty()||inliers<10){hs.delete();throw new Error('unstable transform');}
    const H=rescaleHomography(hs,ms.scale);hs.delete();return{H,inliers,fallback:false};
  }catch(err){return translationFallback(moving,reference);}finally{ms.mat.delete();rs.mat.delete();mg.delete();rg.delete();orb.delete();mask0.delete();kpM.delete();kpR.delete();dM.delete();dR.delete();}
}

function commonCrop(frames,w,h){
  const cv=state.cv;let common=new cv.Mat(h,w,cv.CV_8UC1,new cv.Scalar(255));
  for(const f of frames){const src=new cv.Mat(h,w,cv.CV_8UC1,new cv.Scalar(255)),warped=new cv.Mat();cv.warpPerspective(src,warped,f.H,new cv.Size(w,h),cv.INTER_NEAREST,cv.BORDER_CONSTANT,new cv.Scalar(0));cv.bitwise_and(common,warped,common);src.delete();warped.delete();}
  const kernel=cv.Mat.ones(7,7,cv.CV_8U);cv.erode(common,common,kernel);kernel.delete();const d=common.data;let x0=w,y0=h,x1=0,y1=0;for(let y=0;y<h;y++){let row=y*w;for(let x=0;x<w;x++){if(d[row+x]>0){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}}}common.delete();if(x1<=x0||y1<=y0)throw new Error('Frames do not share enough aligned area.');return{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};
}

function medianLuma(mat){const g=grayOf(mat),d=g.data;const hist=new Uint32Array(256);for(let i=0;i<d.length;i+=4)hist[d[i]]++;const target=Math.ceil(d.length/4/2);let s=0,m=128;for(let i=0;i<256;i++){s+=hist[i];if(s>=target){m=i;break;}}g.delete();return m;}
const SRGB_TO_LINEAR=Float32Array.from({length:256},(_,i)=>{const v=i/255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);});
function linearToSrgb(v){v=clamp(v,0,1);const s=v<=.0031308?12.92*v:1.055*Math.pow(v,1/2.4)-.055;return Math.round(clamp(s*255,0,255));}

async function fuseFrames(frames,refIndex,crop,outScale,opts){
  const cv=state.cv,W=Math.round(crop.w*outScale),H=Math.round(crop.h*outScale),N=W*H;
  const accum=new Float32Array(N*3),weights=new Float32Array(N);let refGrayData=null,referenceImage=null;
  const refFrame=frames[refIndex]; const targetMedian=refFrame.median;
  // Build the aligned reference first so motion comparison is anchored to one real instant.
  {
    const M=outputTransform(refFrame.H,outScale,crop.x,crop.y),warped=new cv.Mat();cv.warpPerspective(refFrame.mat,warped,M,new cv.Size(W,H),cv.INTER_LANCZOS4,cv.BORDER_CONSTANT,new cv.Scalar(0,0,0,0));M.delete();const g=grayOf(warped);refGrayData=new Uint8Array(g.data);referenceImage=new ImageData(new Uint8ClampedArray(warped.data),W,H);g.delete();warped.delete();
  }
  for(let fi=0;fi<frames.length;fi++){
    const f=frames[fi];setProgress(.58+.30*(fi/frames.length),`Fusing frame ${fi+1} of ${frames.length}`,fi===refIndex?'Locking the reference instant':'Rejecting motion and weighting usable detail','fuse');await sleepFrame();
    const M=outputTransform(f.H,outScale,crop.x,crop.y),warped=new cv.Mat();cv.warpPerspective(f.mat,warped,M,new cv.Size(W,H),cv.INTER_LANCZOS4,cv.BORDER_CONSTANT,new cv.Scalar(0,0,0,0));M.delete();
    const g=grayOf(warped),lap=new cv.Mat(),absLap=new cv.Mat(),sharp=new cv.Mat();cv.Laplacian(g,lap,cv.CV_16S,3);cv.convertScaleAbs(lap,absLap);cv.GaussianBlur(absLap,sharp,new cv.Size(5,5),1.1,1.1,cv.BORDER_DEFAULT);
    const rgba=warped.data,lum=g.data,sh=sharp.data;const gainRaw=clamp(targetMedian/Math.max(8,f.median),.62,1.55);const gain=Math.pow(gainRaw,state.mode==='exposure'?.28:.78);const motion=opts.motion/100,sharpAmt=opts.sharp/100,expAmt=opts.exposure/100;const threshold=42-28*motion;
    for(let i=0,p=0;i<N;i++,p+=4){if(rgba[p+3]===0)continue;const l0=lum[i],ln=clamp(l0*gain,0,255);let w=1;
      const sNorm=Math.min(3,sh[i]/30);w*=1+sharpAmt*1.1*sNorm;
      const well=Math.exp(-.5*Math.pow((l0/255-.52)/.27,2));w*=1-expAmt*.72+expAmt*.72*(.22+.78*well);
      if(fi!==refIndex&&motion>0){const diff=Math.abs(ln-refGrayData[i]);const q=diff/Math.max(5,threshold);w*=Math.max(.025,Math.exp(-motion*2.7*q*q));}
      const r=clamp(Math.round(rgba[p]*gain),0,255),gg=clamp(Math.round(rgba[p+1]*gain),0,255),b=clamp(Math.round(rgba[p+2]*gain),0,255);const a=i*3;accum[a]+=SRGB_TO_LINEAR[r]*w;accum[a+1]+=SRGB_TO_LINEAR[gg]*w;accum[a+2]+=SRGB_TO_LINEAR[b]*w;weights[i]+=w;
    }
    warped.delete();g.delete();lap.delete();absLap.delete();sharp.delete();
  }
  const out=new Uint8ClampedArray(N*4);for(let i=0,p=0;i<N;i++,p+=4){const w=Math.max(weights[i],1e-6),a=i*3;out[p]=linearToSrgb(accum[a]/w);out[p+1]=linearToSrgb(accum[a+1]/w);out[p+2]=linearToSrgb(accum[a+2]/w);out[p+3]=255;}
  return{image:new ImageData(out,W,H),reference:referenceImage};
}

function enhance(image,brightness,detail){
  const cv=state.cv;const data=new Uint8ClampedArray(image.data);const b=brightness/100,gamma=1/(1+b*.9);for(let i=0;i<data.length;i+=4){data[i]=255*Math.pow(data[i]/255,gamma);data[i+1]=255*Math.pow(data[i+1]/255,gamma);data[i+2]=255*Math.pow(data[i+2]/255,gamma);}
  if(detail<=0)return new ImageData(data,image.width,image.height);const src=cv.matFromArray(image.height,image.width,cv.CV_8UC4,data),blur=new cv.Mat(),out=new cv.Mat();cv.GaussianBlur(src,blur,new cv.Size(5,5),1.0,1.0,cv.BORDER_DEFAULT);const amt=.12+.0062*detail;cv.addWeighted(src,1+amt,blur,-amt,0,out);const result=new ImageData(new Uint8ClampedArray(out.data),image.width,image.height);src.delete();blur.delete();out.delete();return result;
}

async function combine(){
  if(state.busy)return;if(state.files.length<2){toast('Add at least two frames.');return;}if(!state.cvReady){toast('The image engine is still loading.');return;}
  state.busy=true;els.combine.disabled=true;els.save.classList.add('hidden');state.files.forEach(x=>x.status='ready');renderFiles();
  const mats=[]; let localFrames=[];
  try{
    setProgress(.02,'Reading the burst','Decoding frames locally on this device','decode');
    const firstNative=await decodeFirst(state.files[0].file);const maxSide=chooseMaxSide(firstNative.width,firstNative.height,state.scale),s=Math.min(1,maxSide/Math.max(firstNative.width,firstNative.height));const W=Math.max(64,Math.round(firstNative.width*s)),H=Math.max(64,Math.round(firstNative.height*s));
    const frames=[]; localFrames=frames;
    for(let i=0;i<state.files.length;i++){
      setProgress(.03+.20*(i/state.files.length),`Decoding frame ${i+1} of ${state.files.length}`,isRaw(state.files[i].file)?'Developing RAW sensor data':'Reading rendered image','decode');await sleepFrame();
      const img=i===0?await resizeImageData(firstNative,W,H):await decodeTo(state.files[i].file,W,H);const mat=matFromImageData(img);frames.push({item:state.files[i],mat,H:null,sharpness:0,median:0});mats.push(mat);
    }
    setProgress(.25,'Finding the cleanest reference','Measuring real edge detail in every frame','analyze');await sleepFrame();
    for(let i=0;i<frames.length;i++){frames[i].sharpness=sharpnessScore(frames[i].mat);frames[i].median=medianLuma(frames[i].mat);}
    let refIndex=0;for(let i=1;i<frames.length;i++)if(frames[i].sharpness>frames[refIndex].sharpness)refIndex=i;frames[refIndex].H=identityH();frames[refIndex].item.status='reference';
    const ref=frames[refIndex];const used=[ref];
    for(let i=0;i<frames.length;i++){if(i===refIndex)continue;setProgress(.30+.25*(used.length/frames.length),`Aligning ${frames[i].item.file.name}`,`Matching stable features to ${ref.item.file.name}`,'align');await sleepFrame();try{const r=estimateHomography(frames[i].mat,ref.mat);frames[i].H=r.H;frames[i].inliers=r.inliers;frames[i].fallback=r.fallback;used.push(frames[i]);}catch(e){console.warn('Skipping frame',frames[i].item.file.name,e);frames[i].item.status='failed';}}
    if(used.length<2)throw new Error('Only one frame could be aligned. Try a burst with more shared visual detail.');
    // reference index changes after failed-frame removal
    const usedRef=used.indexOf(ref);renderFiles();setProgress(.56,'Cropping alignment borders','Finding the region captured by every usable frame','align');await sleepFrame();const crop=commonCrop(used,W,H);
    const opts={motion:+els.motion.value,sharp:+els.sharpWeight.value,exposure:+els.exposure.value};const fused=await fuseFrames(used,usedRef,crop,state.scale,opts);
    setProgress(.91,'Finishing the image','Applying the final tone and detail pass','enhance');await sleepFrame();const final=enhance(fused.image,+els.brightness.value,+els.detail.value);
    state.result=final;state.before=fused.reference;state.outputName=(state.files[refIndex].file.name.replace(/\.[^.]+$/,'')||'burst')+'-stacked.png';
    state.stats={used:used.length,total:frames.length,ref:ref.item.file.name,scale:state.scale,w:final.width,h:final.height,noise:Math.sqrt(used.length)};
    showResult();setProgress(1,'Burst complete',`${used.length} aligned frames fused into ${final.width} × ${final.height}`,'enhance');els.save.classList.remove('hidden');toast('Stack complete');
  }catch(err){console.error(err);toast(err.message||'Processing failed');setProgress(0,'Could not finish the burst',err.message||String(err),'decode');}
  finally{for(const f of localFrames)try{f.H?.delete();}catch{};for(const m of mats)try{m.delete();}catch{};state.busy=false;els.combine.disabled=false;}
}
els.combine.addEventListener('click',combine);

function drawImageData(canvas,img){canvas.width=img.width;canvas.height=img.height;canvas.getContext('2d').putImageData(img,0,0);}
function syncCompare(){const v=+els.compareSlider.value;els.beforeLayer.style.width=`${v}%`;els.compareLine.style.left=`${v}%`;const rect=els.resultCanvas.getBoundingClientRect();els.beforeCanvas.style.width=`${rect.width}px`;els.beforeCanvas.style.height=`${rect.height}px`;}
els.compareSlider.addEventListener('input',syncCompare);window.addEventListener('resize',syncCompare);
function showResult(){els.empty.classList.add('hidden');els.resultStage.classList.remove('hidden');drawImageData(els.resultCanvas,state.result);drawImageData(els.beforeCanvas,state.before);requestAnimationFrame(syncCompare);const s=state.stats;els.resultMeta.innerHTML=`<span class="stat-chip">${s.used}/${s.total} frames used</span><span class="stat-chip">${s.scale}× sub-pixel ${s.scale===2?'reconstruction':'stack'}</span><span class="stat-chip">≈${s.noise.toFixed(2)}× random-noise SNR</span><span class="stat-chip">${s.w} × ${s.h}</span><span class="stat-chip">Reference: ${escapeHtml(s.ref)}</span>`;}

els.save.addEventListener('click',()=>{if(!state.result)return;els.resultCanvas.toBlob(blob=>{if(!blob)return;const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=state.outputName;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);},'image/png');});

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
renderFiles();
