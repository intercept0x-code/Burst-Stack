const RAW_EXTS = new Set(['dng','cr2','cr3','nef','arw','raf','rw2','orf']);
let LibRawCtor = null;
let libRawPromise = null;

async function getLibRaw(){
  if(LibRawCtor)return LibRawCtor;
  if(!libRawPromise){
    libRawPromise=import('https://esm.sh/libraw-wasm@1.6.0?bundle').then(mod=>{
      const ctor=mod.default||mod.LibRaw||mod;
      if(typeof ctor!=='function')throw new Error('RAW decoder module did not expose LibRaw.');
      LibRawCtor=ctor;return ctor;
    }).catch(err=>{libRawPromise=null;throw new Error(`RAW decoder could not load: ${err?.message||err}`);});
  }
  return libRawPromise;
}

const $=s=>document.querySelector(s);
const state={
  files:[],cv:null,cvReady:false,busy:false,cancel:false,wakeLock:null,
  mode:'balanced',scale:2,crop:'reference',pinnedRefKey:null,
  fused:null,before:null,previewFused:null,previewBefore:null,result:null,stats:null,
  outputName:'burst-stacked.jpg',view:'compare',installPrompt:null,previewTimer:null,
  sourceSize:null,workingSize:null
};
const els={
  fileInput:$('#fileInput'),pick:$('#pickFilesBtn'),add:$('#addMoreBtn'),clear:$('#clearBtn'),mobileAdd:$('#mobileAddBtn'),
  drop:$('#dropZone'),empty:$('#emptyState'),burstStage:$('#burstStage'),burstHeroImage:$('#burstHeroImage'),burstFallback:$('#burstFallback'),burstKicker:$('#burstKicker'),burstTitle:$('#burstTitle'),burstSubtitle:$('#burstSubtitle'),burstCount:$('#burstCount'),
  framesCard:$('#framesCard'),controls:$('#controlsCard'),frameStrip:$('#frameStrip'),frameSummary:$('#frameSummary'),healthRow:$('#healthRow'),healthTitle:$('#healthTitle'),healthText:$('#healthText'),
  combine:$('#combineBtn'),mobileCombine:$('#mobileCombineBtn'),save:$('#saveBtn'),share:$('#shareBtn'),exportRow:$('#exportRow'),mobileExport:$('#mobileExportBtn'),mobileShare:$('#mobileShareBtn'),mobileDock:$('#mobileDock'),
  enginePill:$('#enginePill'),engineText:$('#engineText'),processCard:$('#processCard'),processTitle:$('#processTitle'),processDetail:$('#processDetail'),progressPct:$('#progressPct'),progressBar:$('#progressBar'),stepStrip:$('#stepStrip'),cancel:$('#cancelBtn'),
  resultStage:$('#resultStage'),resultCanvas:$('#resultCanvas'),beforeCanvas:$('#beforeCanvas'),resultMeta:$('#resultMeta'),compareSlider:$('#compareSlider'),beforeLayer:$('#beforeLayer'),compareLine:$('#compareLine'),compareWrap:$('#compareWrap'),viewSwitch:$('#viewSwitch'),resetCompare:$('#resetCompareBtn'),
  motion:$('#motionRange'),sharpWeight:$('#sharpWeightRange'),exposure:$('#exposureRange'),brightness:$('#brightnessRange'),shadows:$('#shadowsRange'),highlights:$('#highlightsRange'),contrast:$('#contrastRange'),saturation:$('#saturationRange'),warmth:$('#warmthRange'),detail:$('#detailRange'),
  adaptive:$('#adaptiveToggle'),reject:$('#rejectToggle'),alignment:$('#alignmentSelect'),motionValue:$('#motionValue'),sharpWeightValue:$('#sharpWeightValue'),exposureValue:$('#exposureValue'),brightnessValue:$('#brightnessValue'),shadowsValue:$('#shadowsValue'),highlightsValue:$('#highlightsValue'),contrastValue:$('#contrastValue'),saturationValue:$('#saturationValue'),warmthValue:$('#warmthValue'),detailValue:$('#detailValue'),resolutionValue:$('#resolutionValue'),cropValue:$('#cropValue'),memoryHint:$('#memoryHint'),
  resetTune:$('#resetTuneBtn'),toast:$('#toast'),install:$('#installBtn'),exportDialog:$('#exportDialog'),exportFormat:$('#exportFormat'),exportQuality:$('#exportQuality'),qualityText:$('#qualityText'),qualityOption:$('#qualityOption'),exportConfirm:$('#exportConfirm')
};

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function extOf(name){return name.split('.').pop().toLowerCase();}
function isRaw(file){return RAW_EXTS.has(extOf(file.name));}
function sleepFrame(){return new Promise(r=>requestAnimationFrame(r));}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toast(msg){els.toast.textContent=msg;els.toast.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>els.toast.classList.remove('show'),2400);}
function checkCancel(){if(state.cancel)throw new Error('Processing cancelled.');}

async function loadOpenCV(){
  try{
    const script=document.createElement('script');script.src='https://docs.opencv.org/4.x/opencv.js';script.async=true;document.head.appendChild(script);
    await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;});
    let cvObj=window.cv;if(cvObj instanceof Promise)cvObj=await cvObj;const start=performance.now();
    while(!cvObj?.Mat){if(performance.now()-start>25000)throw new Error('OpenCV initialization timed out');await new Promise(r=>setTimeout(r,80));cvObj=window.cv instanceof Promise?await window.cv:window.cv;}
    state.cv=cvObj;state.cvReady=true;els.enginePill.classList.add('ready');els.engineText.textContent='Ready';updateButtons();
  }catch(err){console.error(err);els.enginePill.classList.add('error');els.engineText.textContent='Engine offline';updateButtons();}
}
loadOpenCV();

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;els.install.classList.remove('hidden');});
els.install.addEventListener('click',async()=>{if(!state.installPrompt)return;state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;els.install.classList.add('hidden');});

const rangePairs=[['motion','motionValue'],['sharpWeight','sharpWeightValue'],['exposure','exposureValue'],['brightness','brightnessValue'],['shadows','shadowsValue'],['highlights','highlightsValue'],['contrast','contrastValue'],['saturation','saturationValue'],['warmth','warmthValue'],['detail','detailValue']];
for(const [a,b] of rangePairs){els[a].addEventListener('input',()=>{els[b].textContent=els[a].value;if(['brightness','shadows','highlights','contrast','saturation','warmth','detail'].includes(a))schedulePreviewTune();});}

const presets={
  balanced:{values:[72,68,42],why:'Builds one reference instant, aligns the rest, rejects disagreeing motion, rewards sharper local samples, and fuses light in linear space.'},
  detail:{values:[52,96,30],why:'Leans hard into locally sharp samples and sub-pixel reconstruction. Best when the scene and subject are nearly still.'},
  motion:{values:[96,48,24],why:'Anchors moving regions to the reference instant and aggressively suppresses pixels that disagree after alignment.'},
  exposure:{values:[68,58,96],why:'Uses well-exposed samples more strongly while still rejecting motion, helping preserve usable shadow and highlight information.'}
};
$('#modeSegment').addEventListener('click',e=>{const b=e.target.closest('button[data-mode]');if(!b||state.busy)return;state.mode=b.dataset.mode;[...b.parentElement.children].forEach(x=>x.classList.toggle('active',x===b));const p=presets[state.mode];[els.motion.value,els.sharpWeight.value,els.exposure.value]=p.values;for(const [a,bn] of rangePairs.slice(0,3))els[bn].textContent=els[a].value;$('#whyText').textContent=p.why;});
$('#resolutionSegment').addEventListener('click',e=>{const b=e.target.closest('button[data-scale]');if(!b||state.busy)return;state.scale=+b.dataset.scale;[...b.parentElement.children].forEach(x=>x.classList.toggle('active',x===b));els.resolutionValue.textContent=state.scale===2?'2× multi-frame':'1× native';preflight();});
$('#cropSegment').addEventListener('click',e=>{const b=e.target.closest('button[data-crop]');if(!b||state.busy)return;state.crop=b.dataset.crop;[...b.parentElement.children].forEach(x=>x.classList.toggle('active',x===b));els.cropValue.textContent=state.crop==='reference'?'Keep reference frame':'Common overlap only';});
els.adaptive.addEventListener('change',preflight);
els.resetTune.addEventListener('click',()=>{const vals={brightness:12,shadows:8,highlights:-8,contrast:6,saturation:4,warmth:0,detail:28};for(const [k,v] of Object.entries(vals)){els[k].value=v;els[`${k}Value`].textContent=v;}schedulePreviewTune(true);});

function openPicker(){if(!state.busy)els.fileInput.click();}
for(const b of [els.pick,els.add,els.mobileAdd])b.addEventListener('click',openPicker);
els.fileInput.addEventListener('change',e=>{addFiles([...e.target.files]);e.target.value='';});
for(const ev of ['dragenter','dragover'])els.drop.addEventListener(ev,e=>{e.preventDefault();if(!state.busy)els.drop.classList.add('drag');});
for(const ev of ['dragleave','drop'])els.drop.addEventListener(ev,e=>{e.preventDefault();els.drop.classList.remove('drag');});
els.drop.addEventListener('drop',e=>{if(!state.busy)addFiles([...e.dataTransfer.files]);});

function addFiles(newFiles){
  const allowed=newFiles.filter(f=>f.type.startsWith('image/')||RAW_EXTS.has(extOf(f.name)));
  for(const file of allowed){const key=`${file.name}:${file.size}:${file.lastModified}`;if(!state.files.some(x=>x.key===key))state.files.push({file,key,status:'ready',analysis:null});}
  if(allowed.length!==newFiles.length)toast('Some unsupported files were ignored.');
  state.result=null;state.fused=null;state.before=null;state.stats=null;renderFiles();preflight();
}
function removeFile(key){if(state.busy)return;if(state.pinnedRefKey===key)state.pinnedRefKey=null;state.files=state.files.filter(x=>x.key!==key);state.result=null;state.fused=null;renderFiles();preflight();}
function clearAll(){if(state.busy)return;state.files=[];state.pinnedRefKey=null;state.fused=null;state.before=null;state.result=null;state.stats=null;state.sourceSize=null;state.workingSize=null;els.resultStage.classList.add('hidden');els.burstStage.classList.add('hidden');els.empty.classList.remove('hidden');els.processCard.classList.add('hidden');renderFiles();preflight();}
els.clear.addEventListener('click',clearAll);

function renderFiles(){
  const has=state.files.length>0;els.framesCard.classList.toggle('hidden',!has);els.controls.classList.toggle('hidden',!has);els.mobileDock.classList.toggle('hidden',!has);
  if(!has){els.empty.classList.remove('hidden');els.burstStage.classList.add('hidden');els.resultStage.classList.add('hidden');}
  else if(!state.result){els.empty.classList.add('hidden');els.burstStage.classList.remove('hidden');els.resultStage.classList.add('hidden');updateBurstHero();}
  els.frameSummary.textContent=`${state.files.length} selected${state.files.some(x=>isRaw(x.file))?' · RAW included':''}${state.pinnedRefKey?' · reference pinned':''}`;
  els.frameStrip.innerHTML='';
  for(const item of state.files){
    const div=document.createElement('div');div.className=`frame-item${state.pinnedRefKey===item.key?' pinned':''}`;const raw=isRaw(item.file);
    const tag=item.status==='reference'?'REF':item.status==='failed'?'SKIP':item.status==='good'?'GOOD':state.pinnedRefKey===item.key?'PIN':'';
    div.innerHTML=`<div class="frame-thumb">${raw?`<span class="raw-badge">${extOf(item.file.name).toUpperCase()}</span>`:`<img alt="" />`}</div><div class="frame-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div><span class="frame-tag ${item.status==='failed'?'bad':item.status==='good'?'good':''}">${tag}</span><button class="remove-frame" aria-label="Remove frame">×</button>`;
    div.querySelector('.remove-frame').onclick=e=>{e.stopPropagation();removeFile(item.key);};
    div.addEventListener('click',()=>{if(state.busy)return;state.pinnedRefKey=state.pinnedRefKey===item.key?null:item.key;renderFiles();toast(state.pinnedRefKey?'Reference pinned':'Reference back to Auto');});
    if(!raw){const img=div.querySelector('img');const url=URL.createObjectURL(item.file);img.src=url;img.onload=()=>URL.revokeObjectURL(url);}
    els.frameStrip.appendChild(div);
  }
  updateButtons();
}
function updateBurstHero(){
  els.burstCount.textContent=state.files.length;els.burstTitle.textContent=state.files.length<2?'Add one more frame':'Ready to reconstruct';els.burstSubtitle.textContent=state.pinnedRefKey?'Pinned reference · automatic motion protection':'Auto reference · automatic motion protection';
  const f=state.files.find(x=>!isRaw(x.file));if(f){const url=URL.createObjectURL(f.file);els.burstHeroImage.src=url;els.burstHeroImage.onload=()=>URL.revokeObjectURL(url);els.burstFallback.classList.add('hidden');}else{els.burstHeroImage.removeAttribute('src');els.burstFallback.classList.remove('hidden');}
}
function updateButtons(){const can=state.files.length>=2&&state.cvReady&&!state.busy;els.combine.disabled=!can;els.mobileCombine.disabled=!can;els.mobileCombine.textContent=state.busy?'Processing…':state.result?'Recombine burst':'Combine burst';const hasResult=!!state.fused;els.exportRow.classList.toggle('hidden',!hasResult);els.mobileExport.classList.toggle('hidden',!hasResult);const canShare=hasResult&&!!navigator.share;els.mobileShare.classList.toggle('hidden',!canShare);els.share.classList.toggle('hidden',!canShare);}

async function preflight(){
  const n=state.files.length;els.healthRow.className='health-row';if(!n){els.healthTitle.textContent='Burst preflight';els.healthText.textContent='Choose photos to estimate output.';return;}
  if(n<2){els.healthRow.classList.add('warn');els.healthTitle.textContent='Need another frame';els.healthText.textContent='At least 2 photos are required.';return;}
  try{
    let dims=state.sourceSize;if(!dims){const f=state.files.find(x=>!isRaw(x.file));if(f){const bmp=await createImageBitmap(f.file,{imageOrientation:'from-image'});dims={w:bmp.width,h:bmp.height};bmp.close();state.sourceSize=dims;}}
    if(!dims){els.healthRow.classList.add('good');els.healthTitle.textContent='Burst ready';els.healthText.textContent=`${n} RAW frames · dimensions read during processing`;return;}
    const maxSide=chooseMaxSide(dims.w,dims.h,state.scale,n),s=Math.min(1,maxSide/Math.max(dims.w,dims.h)),w=Math.max(64,Math.round(dims.w*s)),h=Math.max(64,Math.round(dims.h*s));state.workingSize={w,h};const ow=w*state.scale,oh=h*state.scale;const mp=ow*oh/1e6;const reduced=s<.999;
    els.healthRow.classList.add(reduced?'warn':'good');els.healthTitle.textContent=reduced?'Adaptive sizing active':'Full source sampling';els.healthText.textContent=`${n} frames → about ${ow} × ${oh} (${mp.toFixed(1)} MP)`;els.memoryHint.textContent=reduced?'This burst is being downscaled internally to stay inside a safer mobile memory budget.':'Current settings fit the estimated device memory budget.';
  }catch{els.healthRow.classList.add('good');els.healthTitle.textContent='Burst ready';els.healthText.textContent=`${n} frames selected`;}
}

function setProgress(p,title,detail,step){p=clamp(p,0,1);els.processCard.classList.remove('hidden');els.progressBar.style.width=`${Math.round(p*100)}%`;els.progressPct.textContent=`${Math.round(p*100)}%`;els.processTitle.textContent=title;els.processDetail.textContent=detail||'';const order=['decode','analyze','align','fuse','enhance'],idx=order.indexOf(step);[...els.stepStrip.children].forEach((el,i)=>{el.classList.toggle('active',i===idx);el.classList.toggle('done',i<idx||(p===1&&i===idx));});}
els.cancel.addEventListener('click',()=>{if(state.busy){state.cancel=true;els.processDetail.textContent='Stopping after the current chunk…';}});

function chooseMaxSide(nativeW,nativeH,scale,count){
  if(!els.adaptive.checked)return Math.max(nativeW,nativeH);
  const mem=navigator.deviceMemory||4,mobile=matchMedia('(max-width:700px)').matches,n=Math.max(2,count||2);
  // Approximate final-output megapixel budget. Fusion itself needs several full-size float buffers,
  // so mobile limits are deliberately conservative even on high-RAM phones.
  let budgetMP=mobile?(mem<=4?7:mem<=8?10:14):(mem<=4?10:mem<=8?18:28);
  budgetMP*=Math.min(1.12,Math.sqrt(8/n));if(scale===2)budgetMP/=4;
  const aspect=nativeW/nativeH,side=Math.sqrt(budgetMP*1e6*Math.max(aspect,1/aspect));return Math.min(Math.max(nativeW,nativeH),Math.max(1200,Math.floor(side)));
}

async function decodeRaw(file){const LibRaw=await getLibRaw(),raw=new LibRaw();try{const bytes=new Uint8Array(await file.arrayBuffer());await raw.open(bytes,{useCameraWb:true,useCameraMatrix:3,outputColor:1,outputBps:8,noAutoBright:true,highlight:2,userQual:3,fbddNoiserd:0});const out=await raw.imageData();if(!out)throw new Error('RAW decoder returned no pixels');const {width,height,colors,bits,data}=out,rgba=new Uint8ClampedArray(width*height*4),max=bits>8?65535:255;for(let i=0,p=0;i<width*height;i++,p+=4){const o=i*colors;rgba[p]=Math.round(data[o]/max*255);rgba[p+1]=Math.round(data[o+1]/max*255);rgba[p+2]=Math.round(data[o+2]/max*255);rgba[p+3]=255;}return new ImageData(rgba,width,height);}finally{raw.dispose();}}
async function decodeStandard(file,targetW=null,targetH=null){const bmp=await createImageBitmap(file,{imageOrientation:'from-image'}),w=targetW||bmp.width,h=targetH||bmp.height,c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bmp,0,0,w,h);bmp.close();return ctx.getImageData(0,0,w,h);}
async function resizeImageData(data,w,h){if(data.width===w&&data.height===h)return data;const a=document.createElement('canvas');a.width=data.width;a.height=data.height;a.getContext('2d').putImageData(data,0,0);const b=document.createElement('canvas');b.width=w;b.height=h;b.getContext('2d').drawImage(a,0,0,w,h);return b.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h);}
async function decodeFirst(file){return isRaw(file)?decodeRaw(file):decodeStandard(file);}async function decodeTo(file,w,h){return isRaw(file)?resizeImageData(await decodeRaw(file),w,h):decodeStandard(file,w,h);}

function matFromImageData(img){return state.cv.matFromArray(img.height,img.width,state.cv.CV_8UC4,img.data);}function grayOf(src){const g=new state.cv.Mat();state.cv.cvtColor(src,g,state.cv.COLOR_RGBA2GRAY);return g;}function resizeMatMax(src,maxSide){const cv=state.cv,s=Math.min(1,maxSide/Math.max(src.cols,src.rows));if(s===1)return{mat:src.clone(),scale:1};const m=new cv.Mat();cv.resize(src,m,new cv.Size(Math.round(src.cols*s),Math.round(src.rows*s)),0,0,cv.INTER_AREA);return{mat:m,scale:s};}
function sharpnessScore(src){const cv=state.cv,{mat}=resizeMatMax(src,1000),g=grayOf(mat),lap=new cv.Mat();cv.Laplacian(g,lap,cv.CV_32F,3,1,0,cv.BORDER_DEFAULT);const a=lap.data32F;let sum=0,sum2=0,n=0;for(let i=0;i<a.length;i+=3){const v=a[i];sum+=v;sum2+=v*v;n++;}const mean=sum/Math.max(1,n),score=sum2/Math.max(1,n)-mean*mean;mat.delete();g.delete();lap.delete();return score;}
function exposureStats(src){const g=grayOf(src),d=g.data,hist=new Uint32Array(256);let clipped=0,total=0;for(let i=0;i<d.length;i++){const v=d[i];hist[v]++;if(v<4||v>251)clipped++;total++;}const target=Math.ceil(total/2);let s=0,median=128;for(let i=0;i<256;i++){s+=hist[i];if(s>=target){median=i;break;}}g.delete();return{median,clipped:clipped/Math.max(1,total)};}
function identityH(){return state.cv.matFromArray(3,3,state.cv.CV_64F,[1,0,0,0,1,0,0,0,1]);}function hArray(H){return Array.from(H.data64F.length?H.data64F:H.data32F);}function matH(a){return state.cv.matFromArray(3,3,state.cv.CV_64F,a);}function multiplyH(A,B){const a=hArray(A),b=hArray(B),o=new Array(9).fill(0);for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++)o[r*3+c]+=a[r*3+k]*b[k*3+c];return matH(o);}function rescaleHomography(H,fromScale){const a=hArray(H);a[2]/=fromScale;a[5]/=fromScale;a[6]*=fromScale;a[7]*=fromScale;return matH(a);}function outputTransform(H,outScale,cropX,cropY){const S=matH([outScale,0,0,0,outScale,0,0,0,1]),C=matH([1,0,-cropX*outScale,0,1,-cropY*outScale,0,0,1]),t1=multiplyH(S,H),out=multiplyH(C,t1);S.delete();C.delete();t1.delete();return out;}
function translationFallback(moving,reference){const cv=state.cv,max=700,rm=resizeMatMax(moving,max),rr=resizeMatMax(reference,max),mg=grayOf(rm.mat),rg=grayOf(rr.mat),margin=Math.max(24,Math.round(Math.min(mg.cols,mg.rows)*.12)),roi=mg.roi(new cv.Rect(margin,margin,mg.cols-2*margin,mg.rows-2*margin)),result=new cv.Mat();cv.matchTemplate(rg,roi,result,cv.TM_CCOEFF_NORMED);const mm=cv.minMaxLoc(result),dx=(mm.maxLoc.x-margin)/rr.scale,dy=(mm.maxLoc.y-margin)/rr.scale,H=matH([1,0,dx,0,1,dy,0,0,1]);rm.mat.delete();rr.mat.delete();mg.delete();rg.delete();roi.delete();result.delete();return{H,inliers:0,matches:0,fallback:true,quality:mm.maxVal};}
function saneTransform(H,w,h){const a=hArray(H),pts=[[0,0],[w,0],[w,h],[0,h]].map(([x,y])=>{const z=a[6]*x+a[7]*y+a[8];return[(a[0]*x+a[1]*y+a[2])/z,(a[3]*x+a[4]*y+a[5])/z];});const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]),bw=Math.max(...xs)-Math.min(...xs),bh=Math.max(...ys)-Math.min(...ys),ratio=(bw*bh)/(w*h);return Number.isFinite(ratio)&&ratio>.5&&ratio<1.8&&Math.abs(a[6])*w<.2&&Math.abs(a[7])*h<.2;}
function estimateTransform(moving,reference){if(els.alignment.value==='translation')return translationFallback(moving,reference);const cv=state.cv,ms=resizeMatMax(moving,1450),rs=resizeMatMax(reference,1450),mg=grayOf(ms.mat),rg=grayOf(rs.mat),orb=new cv.ORB(5200,1.2,8,23,0,2,cv.ORB_HARRIS_SCORE,31,12),mask0=new cv.Mat(),kpM=new cv.KeyPointVector(),kpR=new cv.KeyPointVector(),dM=new cv.Mat(),dR=new cv.Mat();try{orb.detectAndCompute(mg,mask0,kpM,dM);orb.detectAndCompute(rg,mask0,kpR,dR);if(dM.empty()||dR.empty()||kpM.size()<18||kpR.size()<18)throw new Error('too few features');const bf=cv.BFMatcher.create?cv.BFMatcher.create(cv.NORM_HAMMING,true):new cv.BFMatcher(cv.NORM_HAMMING,true),matches=new cv.DMatchVector();bf.match(dM,dR,matches);const arr=[];for(let i=0;i<matches.size();i++)arr.push(matches.get(i));arr.sort((a,b)=>a.distance-b.distance);const take=arr.slice(0,Math.min(700,Math.max(30,Math.round(arr.length*.68)))).filter(m=>m.distance<74);if(take.length<12){bf.delete();matches.delete();throw new Error('too few reliable matches');}const src=[],dst=[];for(const m of take){const p=kpM.get(m.queryIdx).pt,q=kpR.get(m.trainIdx).pt;src.push(p.x,p.y);dst.push(q.x,q.y);}const sm=cv.matFromArray(take.length,1,cv.CV_32FC2,src),dm=cv.matFromArray(take.length,1,cv.CV_32FC2,dst),inlierMask=new cv.Mat(),hs=cv.findHomography(sm,dm,cv.RANSAC,3.0,inlierMask);let inliers=0;for(const v of inlierMask.data)if(v)inliers++;sm.delete();dm.delete();inlierMask.delete();bf.delete();matches.delete();if(hs.empty()||inliers<10){hs.delete();throw new Error('unstable transform');}const H=rescaleHomography(hs,ms.scale);hs.delete();if(!saneTransform(H,moving.cols,moving.rows)){H.delete();throw new Error('implausible transform');}return{H,inliers,matches:take.length,fallback:false,quality:inliers/Math.max(1,take.length)};}catch{return translationFallback(moving,reference);}finally{ms.mat.delete();rs.mat.delete();mg.delete();rg.delete();orb.delete();mask0.delete();kpM.delete();kpR.delete();dM.delete();dR.delete();}}
function commonCrop(frames,w,h){const cv=state.cv;let common=new cv.Mat(h,w,cv.CV_8UC1,new cv.Scalar(255));for(const f of frames){const src=new cv.Mat(h,w,cv.CV_8UC1,new cv.Scalar(255)),warped=new cv.Mat();cv.warpPerspective(src,warped,f.H,new cv.Size(w,h),cv.INTER_NEAREST,cv.BORDER_CONSTANT,new cv.Scalar(0));cv.bitwise_and(common,warped,common);src.delete();warped.delete();}const kernel=cv.Mat.ones(7,7,cv.CV_8U);cv.erode(common,common,kernel);kernel.delete();const d=common.data;let x0=w,y0=h,x1=0,y1=0;for(let y=0;y<h;y++){const row=y*w;for(let x=0;x<w;x++)if(d[row+x]>0){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}}common.delete();if(x1<=x0||y1<=y0)throw new Error('Frames do not share enough aligned area.');return{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};}
const SRGB_TO_LINEAR=Float32Array.from({length:256},(_,i)=>{const v=i/255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);});function linearToSrgb(v){v=clamp(v,0,1);const s=v<=.0031308?12.92*v:1.055*Math.pow(v,1/2.4)-.055;return Math.round(clamp(s*255,0,255));}

async function fuseFrames(frames,refIndex,crop,outScale,opts,workW,workH){
  const cv=state.cv,W=Math.round(crop.w*outScale),H=Math.round(crop.h*outScale),N=W*H,accum=new Float32Array(N*3),weights=new Float32Array(N);let refGrayData=null,refRGBA=null,referenceImage=null;const refFrame=frames[refIndex],targetMedian=refFrame.median;
  // Frames are deliberately re-decoded one-at-a-time for fusion. It costs some CPU, but avoids
  // keeping an entire full-resolution burst resident in memory on a phone.
  {
    checkCancel();const refImg=await decodeTo(refFrame.item.file,workW,workH),refMat=matFromImageData(refImg),M=outputTransform(refFrame.H,outScale,crop.x,crop.y),warped=new cv.Mat();
    cv.warpPerspective(refMat,warped,M,new cv.Size(W,H),cv.INTER_LANCZOS4,cv.BORDER_CONSTANT,new cv.Scalar(0,0,0,0));M.delete();refMat.delete();const g=grayOf(warped);refGrayData=new Uint8Array(g.data);refRGBA=new Uint8Array(warped.data);referenceImage=new ImageData(new Uint8ClampedArray(warped.data),W,H);g.delete();warped.delete();
  }
  for(let fi=0;fi<frames.length;fi++){
    checkCancel();const f=frames[fi];setProgress(.58+.30*(fi/frames.length),`Fusing frame ${fi+1} of ${frames.length}`,fi===refIndex?'Locking the reference instant':'Streaming frame · robust motion + detail weighting','fuse');await sleepFrame();
    const img=await decodeTo(f.item.file,workW,workH);checkCancel();const srcMat=matFromImageData(img),M=outputTransform(f.H,outScale,crop.x,crop.y),warped=new cv.Mat();cv.warpPerspective(srcMat,warped,M,new cv.Size(W,H),cv.INTER_LANCZOS4,cv.BORDER_CONSTANT,new cv.Scalar(0,0,0,0));srcMat.delete();M.delete();const g=grayOf(warped),lap=new cv.Mat(),absLap=new cv.Mat(),sharp=new cv.Mat();cv.Laplacian(g,lap,cv.CV_16S,3);cv.convertScaleAbs(lap,absLap);cv.GaussianBlur(absLap,sharp,new cv.Size(5,5),1.15,1.15,cv.BORDER_DEFAULT);
    const rgba=warped.data,lum=g.data,sh=sharp.data,gainRaw=clamp(targetMedian/Math.max(8,f.median),.62,1.55),gain=Math.pow(gainRaw,state.mode==='exposure'?.28:.78),motion=opts.motion/100,sharpAmt=opts.sharp/100,expAmt=opts.exposure/100,threshold=44-27*motion;
    const CHUNK=220000;
    for(let start=0;start<N;start+=CHUNK){checkCancel();const end=Math.min(N,start+CHUNK);for(let i=start,p=start*4;i<end;i++,p+=4){if(rgba[p+3]===0)continue;const l0=lum[i],ln=clamp(l0*gain,0,255);let w=1;const sNorm=Math.min(3.2,sh[i]/28);w*=1+sharpAmt*1.15*sNorm;const well=Math.exp(-.5*Math.pow((l0/255-.52)/.27,2)),clipPenalty=(l0<4||l0>251)?.12:1;w*=clipPenalty*(1-expAmt*.76+expAmt*.76*(.22+.78*well));if(fi!==refIndex&&motion>0){const dr=Math.abs(rgba[p]*gain-refRGBA[p]),dg=Math.abs(rgba[p+1]*gain-refRGBA[p+1]),db=Math.abs(rgba[p+2]*gain-refRGBA[p+2]),colorDiff=(dr+dg+db)/3,lumaDiff=Math.abs(ln-refGrayData[i]),diff=.58*lumaDiff+.42*colorDiff,q=diff/Math.max(6,threshold);w*=Math.max(.015,1/(1+motion*5*q*q*q*q));}else if(fi===refIndex){w*=1+.22*motion;}const r=clamp(Math.round(rgba[p]*gain),0,255),gg=clamp(Math.round(rgba[p+1]*gain),0,255),b=clamp(Math.round(rgba[p+2]*gain),0,255),a=i*3;accum[a]+=SRGB_TO_LINEAR[r]*w;accum[a+1]+=SRGB_TO_LINEAR[gg]*w;accum[a+2]+=SRGB_TO_LINEAR[b]*w;weights[i]+=w;}if(N>900000)await sleepFrame();}
    warped.delete();g.delete();lap.delete();absLap.delete();sharp.delete();
  }
  const out=new Uint8ClampedArray(N*4),CHUNK=300000;for(let start=0;start<N;start+=CHUNK){checkCancel();const end=Math.min(N,start+CHUNK);for(let i=start,p=start*4;i<end;i++,p+=4){const w=Math.max(weights[i],1e-6),a=i*3;out[p]=linearToSrgb(accum[a]/w);out[p+1]=linearToSrgb(accum[a+1]/w);out[p+2]=linearToSrgb(accum[a+2]/w);out[p+3]=255;}if(N>1200000)await sleepFrame();}
  return{image:new ImageData(out,W,H),reference:referenceImage};
}

function tuneValues(){return{brightness:+els.brightness.value,shadows:+els.shadows.value,highlights:+els.highlights.value,contrast:+els.contrast.value,saturation:+els.saturation.value,warmth:+els.warmth.value,detail:+els.detail.value};}
function enhance(image,t){
  const data=new Uint8ClampedArray(image.data),br=t.brightness/100,sh=t.shadows/100,hi=t.highlights/100,ct=t.contrast/100,sat=1+t.saturation/100,warm=t.warmth/100,gamma=br>=0?1/(1+br*.95):1+(-br)*1.2;
  for(let i=0;i<data.length;i+=4){let r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255;const y=.2126*r+.7152*g+.0722*b;const shadowMask=Math.pow(1-y,2),highlightMask=Math.pow(y,2);let y2=Math.pow(clamp(y,0,1),gamma);y2+=sh*.34*shadowMask; y2+=hi*.28*highlightMask; y2=(y2-.5)*(1+ct*.72)+.5;const ratio=y>1e-5?y2/y:1;r*=ratio;g*=ratio;b*=ratio;const yy=.2126*r+.7152*g+.0722*b;r=yy+(r-yy)*sat;g=yy+(g-yy)*sat;b=yy+(b-yy)*sat;r+=warm*.055;b-=warm*.055;data[i]=clamp(Math.round(r*255),0,255);data[i+1]=clamp(Math.round(g*255),0,255);data[i+2]=clamp(Math.round(b*255),0,255);}
  if(t.detail<=0||!state.cvReady)return new ImageData(data,image.width,image.height);const cv=state.cv,src=cv.matFromArray(image.height,image.width,cv.CV_8UC4,data),blur=new cv.Mat(),out=new cv.Mat();cv.GaussianBlur(src,blur,new cv.Size(5,5),1.0,1.0,cv.BORDER_DEFAULT);const amt=.08+.0061*t.detail;cv.addWeighted(src,1+amt,blur,-amt,0,out);const result=new ImageData(new Uint8ClampedArray(out.data),image.width,image.height);src.delete();blur.delete();out.delete();return result;
}
async function makePreview(img,maxSide=1700){if(Math.max(img.width,img.height)<=maxSide)return img;const s=maxSide/Math.max(img.width,img.height),w=Math.round(img.width*s),h=Math.round(img.height*s);return resizeImageData(img,w,h);}
function schedulePreviewTune(immediate=false){if(!state.previewFused)return;clearTimeout(state.previewTimer);state.previewTimer=setTimeout(refreshPreview,immediate?0:140);}
function refreshPreview(){if(!state.previewFused)return;state.result=enhance(state.previewFused,tuneValues());drawImageData(els.resultCanvas,state.result);drawImageData(els.beforeCanvas,state.previewBefore);requestAnimationFrame(syncCompare);}

async function requestWakeLock(){try{if('wakeLock'in navigator)state.wakeLock=await navigator.wakeLock.request('screen');}catch{}}
async function releaseWakeLock(){try{await state.wakeLock?.release();}catch{}state.wakeLock=null;}
window.addEventListener('beforeunload',e=>{if(state.busy){e.preventDefault();e.returnValue='';}});

async function combine(){
  if(state.busy)return;if(state.files.length<2){toast('Add at least two frames.');return;}if(!state.cvReady){toast('The image engine is still loading.');return;}
  state.busy=true;state.cancel=false;updateButtons();els.cancel.classList.remove('hidden');state.files.forEach(x=>{x.status='ready';x.analysis=null;});renderFiles();await requestWakeLock();const mats=[];let localFrames=[];
  try{
    setProgress(.02,'Reading the burst','Decoding a lightweight analysis copy of each frame','decode');let firstNative=await decodeFirst(state.files[0].file);checkCancel();const sourceW=firstNative.width,sourceH=firstNative.height;state.sourceSize={w:sourceW,h:sourceH};const maxSide=chooseMaxSide(sourceW,sourceH,state.scale,state.files.length),workScale=Math.min(1,maxSide/Math.max(sourceW,sourceH)),W=Math.max(64,Math.round(sourceW*workScale)),H=Math.max(64,Math.round(sourceH*workScale));state.workingSize={w:W,h:H};
    // Alignment does not need the full fusion resolution. Keeping this copy around 1500 px cuts
    // memory sharply; transforms are promoted back to the working coordinate system afterward.
    const analysisMax=Math.min(1500,Math.max(W,H)),analysisScale=Math.min(1,analysisMax/Math.max(sourceW,sourceH)),AW=Math.max(64,Math.round(sourceW*analysisScale)),AH=Math.max(64,Math.round(sourceH*analysisScale));
    const frames=[];localFrames=frames;let firstAnalysis=await resizeImageData(firstNative,AW,AH);firstNative=null;
    for(let i=0;i<state.files.length;i++){checkCancel();setProgress(.03+.20*(i/state.files.length),`Analyzing frame ${i+1} of ${state.files.length}`,isRaw(state.files[i].file)?'Developing RAW analysis copy':'Reading analysis copy','decode');await sleepFrame();const img=i===0?firstAnalysis:await decodeTo(state.files[i].file,AW,AH),mat=matFromImageData(img);frames.push({item:state.files[i],mat,H:null,sharpness:0,median:0,clipped:0,quality:0,inliers:0,fallback:false});mats.push(mat);}firstAnalysis=null;
    setProgress(.25,'Scoring the burst','Measuring edge detail, clipping and exposure quality','analyze');await sleepFrame();for(let i=0;i<frames.length;i++){checkCancel();frames[i].sharpness=sharpnessScore(frames[i].mat);const ex=exposureStats(frames[i].mat);frames[i].median=ex.median;frames[i].clipped=ex.clipped;frames[i].referenceScore=frames[i].sharpness*Math.max(.35,1-frames[i].clipped*3)*Math.max(.55,1-Math.abs(frames[i].median-128)/230);}
    let refIndex=0;if(state.pinnedRefKey){const pi=frames.findIndex(f=>f.item.key===state.pinnedRefKey);if(pi>=0)refIndex=pi;}else for(let i=1;i<frames.length;i++)if(frames[i].referenceScore>frames[refIndex].referenceScore)refIndex=i;frames[refIndex].H=identityH();frames[refIndex].item.status='reference';const ref=frames[refIndex],used=[ref],skipped=[];
    for(let i=0;i<frames.length;i++){if(i===refIndex)continue;checkCancel();setProgress(.30+.25*((i+(i>refIndex?0:1))/frames.length),`Aligning ${frames[i].item.file.name}`,`Matching stable structure to ${ref.item.file.name}`,'align');await sleepFrame();try{const r=estimateTransform(frames[i].mat,ref.mat);frames[i].H=r.H;frames[i].inliers=r.inliers;frames[i].fallback=r.fallback;frames[i].quality=r.quality;const weak=r.fallback?r.quality<.32:(r.inliers<12||r.quality<.10);if(els.reject.checked&&weak){frames[i].H.delete();frames[i].H=null;frames[i].item.status='failed';skipped.push(frames[i]);}else{frames[i].item.status='good';used.push(frames[i]);}}catch(e){console.warn('Skipping frame',frames[i].item.file.name,e);frames[i].item.status='failed';skipped.push(frames[i]);}}
    if(used.length<2)throw new Error('Only one frame could be aligned reliably. Try a tighter burst or disable Auto-reject weak frames.');
    // Promote transforms from analysis coordinates to fusion-working coordinates, then release every
    // analysis image before allocating the much larger fusion buffers.
    const coordScale=AW/W;for(const f of used){const promoted=rescaleHomography(f.H,coordScale);f.H.delete();f.H=promoted;}for(const f of frames){try{f.mat?.delete();}catch{}f.mat=null;}mats.length=0;
    const usedRef=used.indexOf(ref);renderFiles();setProgress(.56,'Building the output frame',state.crop==='common'?'Finding the area shared by every usable frame':'Keeping the full reference composition','align');await sleepFrame();const crop=state.crop==='common'?commonCrop(used,W,H):{x:0,y:0,w:W,h:H};const opts={motion:+els.motion.value,sharp:+els.sharpWeight.value,exposure:+els.exposure.value},fused=await fuseFrames(used,usedRef,crop,state.scale,opts,W,H);checkCancel();
    setProgress(.91,'Preparing the live preview','Full-resolution fusion is complete','enhance');state.fused=fused.image;state.before=fused.reference;state.previewFused=await makePreview(state.fused);state.previewBefore=await makePreview(state.before);state.outputName=(ref.item.file.name.replace(/\.[^.]+$/,'')||'burst')+'-stacked';state.stats={used:used.length,total:frames.length,skipped:skipped.length,ref:ref.item.file.name,scale:state.scale,w:state.fused.width,h:state.fused.height,noise:Math.sqrt(used.length),crop:state.crop,fallbacks:used.filter(f=>f.fallback).length,sourceW,sourceH};showResult();setProgress(1,'Burst complete',`${used.length} aligned frames fused into ${state.fused.width} × ${state.fused.height}`,'enhance');toast('Stack complete');
  }catch(err){console.error(err);if(state.cancel||err.message==='Processing cancelled.')toast('Processing cancelled');else toast(err.message||'Processing failed');setProgress(0,state.cancel?'Cancelled':'Could not finish the burst',state.cancel?'Your selected frames are still here.':err.message||String(err),'decode');}
  finally{for(const f of localFrames)try{f.H?.delete();}catch{}for(const m of mats)try{m.delete();}catch{}state.busy=false;state.cancel=false;await releaseWakeLock();updateButtons();preflight();}
}
els.combine.addEventListener('click',combine);els.mobileCombine.addEventListener('click',combine);

function drawImageData(canvas,img){canvas.width=img.width;canvas.height=img.height;canvas.getContext('2d').putImageData(img,0,0);}
function syncCompare(){const v=+els.compareSlider.value,showCompare=state.view==='compare';els.beforeLayer.style.width=state.view==='reference'?'100%':state.view==='result'?'0%':`${v}%`;els.compareLine.style.left=`${v}%`;els.compareLine.classList.toggle('hidden',!showCompare);els.compareSlider.classList.toggle('hidden',!showCompare);document.querySelectorAll('.compare-label').forEach(x=>x.classList.toggle('hidden',!showCompare));const rect=els.resultCanvas.getBoundingClientRect();els.beforeCanvas.style.width=`${rect.width}px`;els.beforeCanvas.style.height=`${rect.height}px`;}
els.compareSlider.addEventListener('input',syncCompare);window.addEventListener('resize',syncCompare);els.resetCompare.addEventListener('click',()=>{els.compareSlider.value=50;syncCompare();});els.viewSwitch.addEventListener('click',e=>{const b=e.target.closest('button[data-view]');if(!b)return;state.view=b.dataset.view;[...b.parentElement.children].forEach(x=>x.classList.toggle('active',x===b));syncCompare();});
function showResult(){els.empty.classList.add('hidden');els.burstStage.classList.add('hidden');els.resultStage.classList.remove('hidden');refreshPreview();const s=state.stats;els.resultMeta.innerHTML=`<span class="stat-chip">${s.used}/${s.total} frames fused</span>${s.skipped?`<span class="stat-chip">${s.skipped} auto-skipped</span>`:''}<span class="stat-chip">${s.scale}× ${s.scale===2?'reconstruction':'stack'}</span><span class="stat-chip">≈${s.noise.toFixed(2)}× random-noise SNR</span><span class="stat-chip">${s.w} × ${s.h}</span><span class="stat-chip">${s.crop==='reference'?'full reference edges':'tight common crop'}</span><span class="stat-chip">Ref: ${escapeHtml(s.ref)}</span>`;updateButtons();requestAnimationFrame(()=>{syncCompare();els.resultStage.scrollIntoView({behavior:'smooth',block:'nearest'});});}

function openExport(){if(!state.fused)return;els.exportDialog.showModal();}
els.save.addEventListener('click',openExport);els.mobileExport.addEventListener('click',openExport);els.exportQuality.addEventListener('input',()=>els.qualityText.textContent=`${els.exportQuality.value}%`);els.exportFormat.addEventListener('change',()=>els.qualityOption.classList.toggle('hidden',els.exportFormat.value==='png'));
async function renderFullBlob(format=els.exportFormat.value,quality=+els.exportQuality.value/100){if(!state.fused)throw new Error('No stacked image yet.');toast('Rendering full-resolution export…');await sleepFrame();const final=enhance(state.fused,tuneValues()),c=document.createElement('canvas');c.width=final.width;c.height=final.height;c.getContext('2d').putImageData(final,0,0);const mime=format==='png'?'image/png':format==='webp'?'image/webp':'image/jpeg';const blob=await new Promise(resolve=>c.toBlob(resolve,mime,format==='png'?undefined:quality));if(!blob)throw new Error('The browser could not encode the image.');return{blob,mime,ext:format==='jpeg'?'jpg':format};}
async function saveExport(){try{els.exportConfirm.disabled=true;const {blob,ext}=await renderFullBlob(),a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`${state.outputName}.${ext}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2500);els.exportDialog.close();toast('Export ready');}catch(e){toast(e.message||'Export failed');}finally{els.exportConfirm.disabled=false;}}
els.exportConfirm.addEventListener('click',saveExport);
async function shareResult(){if(!navigator.share||!state.fused)return;try{const {blob,ext}=await renderFullBlob('jpeg',.94),file=new File([blob],`${state.outputName}.${ext}`,{type:blob.type});if(navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:'BurstStacker result'});else await navigator.share({title:'BurstStacker result'});}catch(e){if(e.name!=='AbortError')toast(e.message||'Share failed');}}
els.share.addEventListener('click',shareResult);els.mobileShare.addEventListener('click',shareResult);

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
renderFiles();preflight();
