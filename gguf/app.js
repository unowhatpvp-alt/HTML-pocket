import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { strings, helpHTML } from './i18n.js';
import { ENGINE_VERSION, ENGINE_BASE, PREFS_KEY, HISTORY_KEY, formatBytes, escapeHTML, numeric, inspectFiles, splitReasoning, normalizeImport, extractRuntimeStats } from './core.js';

const $ = id => document.getElementById(id);
const initialLanguage = (() => { try { return localStorage.getItem('mono.gguf.language') || (navigator.language.startsWith('zh') ? 'zh' : 'en'); } catch { return 'zh'; } })();
let lang = initialLanguage === 'en' ? 'en' : 'zh';
const t = key => strings[lang][key] || key;
const state = { engine:null, selected:null, model:null, busy:false, inspecting:false, loading:false, generating:false, abort:null, sessions:[], chat:freshChat(), status:'waiting', logs:[], runtime:{gpuLayers:null,buffers:{}}, requestedGPU:false, threadCount:0, loadedContext:0, firstToken:null, tokenCount:null, speed:null, elapsed:0, gpu:null, gpuName:'', lag:0, save:true, renderTimer:null };
const preferenceIds = ['backend','context','threads','gpuLayers','temperature','topP','topK','minP','maxTokens','repeatPenalty','seed','outputFormat','systemPrompt','batch','microBatch','chatTemplate'];
let storageWarned = false, toastTimer, wakeLock;
function freshChat() { return { id:crypto.randomUUID(), title:'', messages:[], updated:Date.now() }; }
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,2800); }
function notice(message) { $('noticeText').textContent=message; $('notice').hidden=!message; }
function log(...args) {
  const line=args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ');
  state.logs.push(line); if(state.logs.length>400) state.logs.splice(0,state.logs.length-400);
  extractRuntimeStats(line,state.runtime);
  if($('hardwareDialog').open) $('engineLogs').textContent=state.logs.join('\n');
}
function storeJSON(key,value) {
  try { localStorage.setItem(key,JSON.stringify(value)); return true; }
  catch { if(!storageWarned){storageWarned=true;notice(t('localStorageFail'));} return false; }
}
function persistPreferences() {
  const prefs={}; preferenceIds.forEach(id=>prefs[id]=$(id).value);
  prefs.thinking=$('thinking').checked; prefs.saveHistory=$('saveHistory').checked;
  state.save=prefs.saveHistory; storeJSON(PREFS_KEY,prefs);
}
function restore() {
  $('threads').value=String(Math.max(1,Math.floor((navigator.hardwareConcurrency||2)/2)));
  try {
    const prefs=JSON.parse(localStorage.getItem(PREFS_KEY)||'{}');
    preferenceIds.forEach(id=>{if(typeof prefs[id]==='string')$(id).value=prefs[id];});
    if(typeof prefs.thinking==='boolean')$('thinking').checked=prefs.thinking;
    if(typeof prefs.saveHistory==='boolean') state.save=$('saveHistory').checked=prefs.saveHistory;
    const saved=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
    if(Array.isArray(saved))state.sessions=saved.filter(s=>s&&typeof s.id==='string'&&Array.isArray(s.messages)&&s.messages.every(m=>m&&['user','assistant','system'].includes(m.role)&&typeof m.content==='string'));
    if(state.save&&state.sessions.length)state.chat=structuredClone(state.sessions[0]);
  } catch { /* A corrupt or unavailable preference store must not prevent startup. */ }
}
function saveChat() {
  if(!state.chat.messages.length||!state.save)return;
  state.chat.updated=Date.now();
  state.sessions=state.sessions.filter(s=>s.id!==state.chat.id);state.sessions.unshift(structuredClone(state.chat));
  storeJSON(HISTORY_KEY,state.sessions);$('historyCount').textContent=String(state.sessions.length);
}
function setStatus(key) { state.status=key;$('runState').textContent=t(key); }
function setControls() {
  const locked=state.loading||state.generating||state.inspecting;
  state.busy=locked;
  $('loadBtn').disabled=locked||!state.selected||!!state.model;
  $('loadBtn').textContent=t(state.loading?'loading':state.model?'ready':'loadModel');
  $('loadSettings').disabled=locked||!!state.model;$('advancedLoadSettings').disabled=locked||!!state.model;
  $('unloadBtn').hidden=!state.model;$('unloadBtn').disabled=locked;
  $('sendBtn').hidden=state.generating;$('stopBtn').hidden=!state.generating;
  $('sendBtn').disabled=!state.model||locked||!$('prompt').value.trim();
  for(const id of ['dropzone','heroChooseBtn'])$(id).disabled=locked||!!state.model;
  for(const id of ['newChatBtn','historyBtn','importBtn','clearHistoryBtn'])$(id).disabled=locked;
  $('loadProgress').hidden=!state.loading&&!state.inspecting;
  $('enginePill').textContent=t(state.loading?'loading':state.model?'ready':'notLoaded');
  $('enginePill').classList.toggle('pending',state.loading);
  $('prompt').placeholder=state.model?(lang==='zh'?'在这里输入消息…':'Type your message…'):t('promptPlaceholder');
}
function applyLanguage() {
  document.documentElement.lang=lang==='zh'?'zh-CN':'en';
  document.querySelectorAll('[data-i18n]').forEach(e=>e.textContent=t(e.dataset.i18n));
  document.querySelectorAll('[data-title]').forEach(e=>{e.title=t(e.dataset.title);e.setAttribute('aria-label',t(e.dataset.title));});
  document.querySelectorAll('[data-placeholder]').forEach(e=>e.placeholder=t(e.dataset.placeholder));
  $('languageBtn').textContent=lang==='zh'?'EN':'中';$('sidebar').setAttribute('aria-label',t('settings'));
  $('helpContent').innerHTML=helpHTML(lang);$('historyCount').textContent=String(state.sessions.length);
  setStatus(state.status);setControls();renderMessages();renderModelInfo();renderHistory();renderHardware();
}
function safeMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text,{gfm:true,breaks:true}),{
    USE_PROFILES:{html:true},SANITIZE_NAMED_PROPS:true,
    FORBID_TAGS:['script','img','video','audio','source','iframe','object','embed','style','form','button','textarea','select','input'],
    FORBID_ATTR:['style','src','srcset','id','name']
  });
}
function decorateMarkdown(body) {
  body.querySelectorAll('a').forEach(a=>{a.target='_blank';a.rel='noopener noreferrer';});
  body.querySelectorAll('table').forEach(table=>{const wrap=document.createElement('div');wrap.className='table-wrap';table.replaceWith(wrap);wrap.append(table);});
  body.querySelectorAll('pre').forEach(pre=>{
    const code=pre.querySelector('code');if(!code)return;
    const language=(code.className.match(/language-([\w+-]+)/)||[])[1]||'text';
    const raw=code.textContent;
    try { if(window.hljs&&window.hljs.getLanguage(language))code.innerHTML=window.hljs.highlight(raw,{language,ignoreIllegals:true}).value; } catch {code.textContent=raw;}
    const box=document.createElement('div');box.className='code-block';
    const header=document.createElement('div');header.className='code-header';
    header.innerHTML=`<span>${escapeHTML(language)}</span><div><button type="button" data-code-copy>${t('copy')}</button><button type="button" data-code-download>${t('download')}</button></div>`;
    pre.replaceWith(box);box.append(header,pre);box.dataset.language=language;
  });
}
function renderMessages() {
  const scroll=$('chatScroll'),nearBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<110;
  const opened=new Set([...$('messages').querySelectorAll('.thinking-block[open]')].map(e=>e.closest('.message').dataset.id));
  $('welcome').hidden=state.chat.messages.length>0;
  $('chatTitle').textContent=state.chat.title||t('untitled');
  $('messages').replaceChildren();
  for(const m of state.chat.messages) {
    const article=document.createElement('article');article.className=`message ${m.role==='user'?'user':'assistant'}`;article.dataset.id=m.id;
    const label=document.createElement('div');label.className='message-label';
    label.innerHTML=`<span class="avatar">${m.role==='user'?'↗':'m·'}</span><span>${m.role==='user'?t('you'):m.role==='system'?'System':t('assistant')}</span>`;article.append(label);
    const body=document.createElement('div');body.className='message-body';
    if(m.role==='user'||m.role==='system')body.textContent=m.content;
    else {
      const separated=splitReasoning(m.content,m.reasoning||'');
      if(separated.reasoning) {
        const details=document.createElement('details');details.className='thinking-block';details.open=opened.has(m.id);
        const summary=document.createElement('summary');summary.textContent=t('reasoning');
        const reasoning=document.createElement('div');reasoning.className='thinking-content';reasoning.textContent=separated.reasoning;
        details.append(summary,reasoning);article.append(details);
      }
      body.innerHTML=safeMarkdown(separated.content);decorateMarkdown(body);
      if(m.status==='generating'&&!separated.content){const dot=document.createElement('span');dot.className='typing-dot';body.append(dot);}
    }
    article.append(body);
    const actions=document.createElement('div');actions.className='message-actions';
    actions.innerHTML=`<button type="button" data-message-copy="${escapeHTML(m.id)}"><svg><use href="#i-copy"/></svg>${t('copy')}</button>`;
    if(m.role==='assistant'&&m===state.chat.messages.at(-1)&&!state.busy) actions.innerHTML+=`<button type="button" data-regenerate><svg><use href="#i-retry"/></svg>${t('regenerate')}</button>`;
    if(m.metrics) {const metric=document.createElement('span');metric.textContent=`${m.metrics.tokens??'—'} tokens · ${m.metrics.seconds.toFixed(1)} s`;actions.append(metric);}
    article.append(actions);
    if(m.status&&['stopped','failed'].includes(m.status)){const status=document.createElement('div');status.className='message-status';status.textContent=t(m.status);article.append(status);}
    $('messages').append(article);
  }
  if(nearBottom)scroll.scrollTop=scroll.scrollHeight;
}
function scheduleRender() {
  if(state.renderTimer)return;
  state.renderTimer=setTimeout(()=>{state.renderTimer=null;renderMessages();},85);
}
function renderModelInfo() {
  const selection=state.selected;$('modelInfo').hidden=!selection;
  if(!selection)return;
  const meta=state.model?.meta||selection.info.meta,arch=meta['general.architecture']||'—';
  $('modelInfo').innerHTML=`<strong>${escapeHTML(meta['general.name']||selection.originals[0].name)}</strong><div>${escapeHTML(arch)}${meta['general.size_label']?' · '+escapeHTML(meta['general.size_label']):''} · ${formatBytes(selection.totalBytes)}</div><div>GGUF v${selection.info.version} · ${selection.files.length} ${lang==='zh'?'个文件':'file(s)'}</div>`;
}
function errorMessage(error) {
  const raw=String(error?.message||error||'Unknown error');
  let hint='';
  if(/SHARDS|NO_FILES/.test(raw))hint=t('shardsHelp');
  else if(/PROJECTOR_ONLY/.test(raw))hint=t('projector');
  else if(/GGUF_/.test(raw))hint=t('badModel');
  else if(/context|kv.cache|n_ctx|too long|prompt.*token|exceeds.*token/i.test(raw))hint=t('contextHelp');
  else if(/memory|allocat|buffer.size|buffer.*limit|out of bounds|OOM/i.test(raw))hint=t('memoryHelp');
  else if(/architecture|tensor.*type|unknown model|unsupported model|quantiz|tensor.*shape/i.test(raw))hint=t('modelHelp');
  else if(/wasm|webassembly|JSPI|SIMD|exception|compileerror/i.test(raw))hint=t('compatHelp');
  else if(/fetch|network|module.*import/i.test(raw))hint=t('engineOffline');
  else if(/file|read/i.test(raw))hint=t('fileReload');
  return [hint,raw].filter(Boolean).join('\n');
}
async function selectFiles(files) {
  if(state.busy||state.model)return;
  state.inspecting=true;state.selected=null;notice('');$('fileList').hidden=true;$('modelInfo').hidden=true;$('loadStage').textContent=t('inspecting');setControls();
  try {
    state.selected=await inspectFiles(Array.from(files));
    $('fileList').replaceChildren();
    for(const f of state.selected.originals){const div=document.createElement('div');div.className='file-item';div.innerHTML=`<span title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</span><small>${formatBytes(f.size)}</small>`;$('fileList').append(div);}
    $('fileList').hidden=false;renderModelInfo();
    toast(t('retained')+' · '+formatBytes(state.selected.totalBytes));
    openSidebar();
  } catch(error){notice(errorMessage(error));log(error.message);}
  finally{state.inspecting=false;setControls();$('modelFiles').value='';}
}
function parseLoadOptions() {
  try {
    return {
      n_ctx:numeric($('context').value,t('context'),{min:1,integer:true}),
      n_threads:numeric($('threads').value,t('threads'),{min:1,integer:true}),
      n_gpu_layers:numeric($('gpuLayers').value,t('gpuLayers'),{min:-1,integer:true}),
      n_batch:numeric($('batch').value,'Batch',{min:1,integer:true}),
      n_ubatch:numeric($('microBatch').value,'Micro batch',{min:1,integer:true}),
      n_parallel:1,ctx_shift:false,log_level:2,
      ...($('chatTemplate').value?{chat_template:$('chatTemplate').value}:{})
    };
  }catch(error){throw new Error(t('invalidParam')+error.message);}
}
function parseGenerationOptions() {
  try {
    const maxTokens=numeric($('maxTokens').value,t('maxTokens'),{min:-1,integer:true});
    if(maxTokens===0)throw new Error(t('maxTokens'));
    const seed=numeric($('seed').value,t('seed'),{min:-1,integer:true});
    return { temperature:numeric($('temperature').value,'Temperature',{min:0}),top_p:numeric($('topP').value,'Top P',{min:0,max:1}),top_k:numeric($('topK').value,'Top K',{min:0,integer:true}),min_p:numeric($('minP').value,'Min P',{min:0,max:1}),penalty_repeat:numeric($('repeatPenalty').value,t('repeatPenalty'),{min:0}),max_tokens:maxTokens,...(seed>=0?{seed}:{}),response_format:{type:$('outputFormat').value==='json_object'?'json_object':'text'},chat_template_kwargs:{enable_thinking:$('thinking').checked},timings_per_token:true,return_progress:true,cache_prompt:true };
  }catch(error){throw new Error(t('invalidParam')+error.message);}
}
async function cleanupEngine() {
  if(state.engine){try{await state.engine.exit();}catch(error){log('Cleanup:',error.message);}state.engine=null;}
  state.model=null;state.threadCount=0;state.loadedContext=0;
}
async function loadModel() {
  if(state.busy||!state.selected||state.model)return;
  let options;try{options=parseLoadOptions();}catch(error){notice(error.message);return;}
  state.loading=true;state.logs=[];notice('');setStatus('loading');setControls();$('loadStage').textContent=t('starting');
  persistPreferences();
  try {
    await (window.monoIsolationReady||Promise.resolve());
    const {Wllama}=await import(`${ENGINE_BASE}/esm/index.js`);
    const wantGPU=$('backend').value!=='cpu'&&!!state.gpu&&options.n_gpu_layers!==0;
    if($('backend').value==='gpu'&&!state.gpu)throw new Error(t('noGpu'));
    if($('backend').value==='auto'&&!state.gpu)log(t('noGpu'));
    const attempt=async(useGPU)=>{
      state.runtime={gpuLayers:null,buffers:{}};state.requestedGPU=useGPU;
      state.engine=new Wllama({default:`${ENGINE_BASE}/esm/wasm/wllama.wasm`},{logger:{debug:log,log,warn:log,error:log},suppressNativeLog:false});
      state.engine.setCompat('default','firefox_safari');
      $('loadStage').textContent=`${t('loading')} · ${useGPU?'WebGPU':'WebAssembly'}\n${t('engineDownload')}`;
      await state.engine.loadModel(state.selected.files,{...options,n_threads:crossOriginIsolated?options.n_threads:1,n_gpu_layers:useGPU?(options.n_gpu_layers===-1?99999:options.n_gpu_layers):0});
    };
    try { await attempt(wantGPU); }
    catch(error) {
      log('Load attempt failed:',error.message);
      if($('backend').value==='auto'&&wantGPU&&/gpu|buffer|device|memory|allocat|adapter|webgpu|shader/i.test(error.message)){
        notice(t('fallback'));await cleanupEngine();await attempt(false);
      } else throw error;
    }
    state.model=state.engine.getModelMetadata();state.threadCount=state.engine.getNumThreads();state.loadedContext=options.n_ctx;
    setStatus('ready');renderModelInfo();toast(t('loadedNotice'));closeSidebar();
  } catch(error){notice(errorMessage(error));log(error.message);await cleanupEngine();setStatus('loadFailed');}
  finally{state.loading=false;setControls();renderHardware();}
}
async function unloadModel() {
  if(state.busy)return;state.loading=true;setControls();
  try{await cleanupEngine();state.runtime={gpuLayers:null,buffers:{}};state.requestedGPU=false;setStatus('waiting');}
  finally{state.loading=false;setControls();renderHardware();renderModelInfo();}
}
async function holdAwake() { try{if(navigator.wakeLock)wakeLock=await navigator.wakeLock.request('screen');}catch{} }
async function releaseAwake() { try{await wakeLock?.release();}catch{}wakeLock=null; }
async function generate(regenerate=false) {
  if(!state.model){notice(t('selectFirst'));openSidebar();return;}
  if(state.busy)return;
  const text=$('prompt').value.trim();if(!regenerate&&!text)return;
  let parameters;try{parameters=parseGenerationOptions();}catch(error){notice(error.message);return;}
  if(regenerate){if(state.chat.messages.at(-1)?.role==='assistant')state.chat.messages.pop();}
  else {
    state.chat.messages.push({id:crypto.randomUUID(),role:'user',content:text,status:'done'});
    if(!state.chat.title)state.chat.title=text.slice(0,48);
    $('prompt').value='';$('prompt').style.height='auto';
  }
  const messages=state.chat.messages.filter(m=>m.content&&(m.role!=='assistant'||m.status!=='failed')).map(m=>({role:m.role,content:m.content}));
  if($('systemPrompt').value.trim())messages.unshift({role:'system',content:$('systemPrompt').value.trim()});
  const answer={id:crypto.randomUUID(),role:'assistant',content:'',reasoning:'',status:'generating'};
  state.chat.messages.push(answer);state.generating=true;state.abort=new AbortController();state.firstToken=null;state.tokenCount=null;state.speed=null;state.elapsed=0;notice('');setStatus('prefill');setControls();renderMessages();
  const started=performance.now();let finishReason=null;
  $('chatScroll').scrollTop=$('chatScroll').scrollHeight;persistPreferences();await holdAwake();
  const timer=setInterval(()=>{state.elapsed=(performance.now()-started)/1000;renderMetrics();},250);
  try {
    await state.engine.createChatCompletion({...parameters,messages,stream:true,abortSignal:state.abort.signal,onData:chunk=>{
      const choice=chunk.choices?.[0],delta=choice?.delta||{};
      const content=delta.content||'',reasoning=delta.reasoning_content||delta.reasoning||'';
      if(content||reasoning){if(state.firstToken===null)state.firstToken=(performance.now()-started)/1000;setStatus('generating');answer.content+=content;answer.reasoning+=reasoning;}
      if(chunk.timings){if(Number.isFinite(chunk.timings.predicted_n))state.tokenCount=chunk.timings.predicted_n;if(Number.isFinite(chunk.timings.predicted_per_second))state.speed=chunk.timings.predicted_per_second;}
      if(chunk.usage?.completion_tokens!=null)state.tokenCount=chunk.usage.completion_tokens;
      if(choice?.finish_reason)finishReason=choice.finish_reason;
      if(chunk.prompt_progress&&!content&&!reasoning&&state.firstToken===null){const p=chunk.prompt_progress;$('runState').textContent=`${t('prefill')} · ${p.processed} / ${p.total}`;}
      scheduleRender();renderMetrics();
    }});
    answer.status=state.abort.signal.aborted?'stopped':'done';
    if(finishReason==='length')notice(t('limited'));
    if(!answer.content&&!answer.reasoning&&answer.status==='done')notice(t('noOutput'));
    setStatus(answer.status);
  }catch(error){
    if(state.abort.signal.aborted||error.name==='WllamaAbortError'||/abort/i.test(error.name)){answer.status='stopped';setStatus('stopped');}
    else{answer.status='failed';notice(errorMessage(error));log(error.message);setStatus('failed');}
  }finally{
    clearInterval(timer);await releaseAwake();state.elapsed=(performance.now()-started)/1000;
    answer.metrics={tokens:state.tokenCount,seconds:state.elapsed,firstToken:state.firstToken,speed:state.speed};
    state.generating=false;state.abort=null;clearTimeout(state.renderTimer);state.renderTimer=null;
    setControls();renderMessages();renderMetrics();saveChat();renderHardware();
  }
}
function renderMetrics() {
  $('speedMetric').textContent=`${state.speed==null?'—':state.speed.toFixed(1)} tok/s`;
  $('tokenMetric').textContent=state.tokenCount==null?'— tokens':`${state.tokenCount} tokens`;
  $('timeMetric').textContent=state.elapsed?`${state.elapsed.toFixed(1)} s`:'— s';
}
function actualBackend() {
  if(!state.model)return '—';
  if(!state.requestedGPU||state.runtime.gpuLayers===0)return 'CPU · WASM';
  if(state.runtime.gpuLayers>0)return `WebGPU · ${state.runtime.gpuLayers} ${t('layer')}`;
  if(Object.values(state.runtime.buffers).some(b=>/webgpu/i.test(b.device)&&b.bytes>0))return 'WebGPU';
  return t('gpuPending');
}
async function detectHardware() {
  try{
    if(navigator.gpu){state.gpu=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});const info=state.gpu?.info;state.gpuName=info?[info.description,info.vendor,info.architecture].filter(Boolean).join(' · '):'';}
  }catch(error){log('WebGPU detection:',error.message);}
  renderHardware();
}
function cell(label,value,note='') {return `<div class="hardware-cell"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(note)}</small></div>`;}
function renderHardware() {
  const gpu=state.gpu;
  $('gpuName').textContent=state.gpuName||(gpu?t('available'):t('unavailable'));
  $('gpuStatus').textContent=`WebGPU ${t(gpu?'available':'unavailable')} · ${t('backend')}: ${actualBackend()}`;
  $('miniBackend').textContent=state.model?actualBackend():(gpu?'WebGPU '+t('available'):'CPU · WebAssembly');
  $('miniHardware').textContent=`${navigator.hardwareConcurrency||'—'} ${t('logicalCores')} · ${crossOriginIsolated?'WASM MT':'WASM ST'}`;
  $('hardwareGrid').innerHTML=[
    cell(t('logicalCores'),navigator.hardwareConcurrency||t('unknown'),t('reported')),
    cell(t('memoryApprox'),navigator.deviceMemory?`~ ${navigator.deviceMemory} GiB`:t('unknown'),t('memoryApproxNote')),
    cell(t('gpuBuffer'),gpu?formatBytes(gpu.limits.maxBufferSize):t('unknown'),t('notVRAM')),
    cell(t('isolation'),t(crossOriginIsolated?'yes':'no'),t('threadHint')),
    cell(t('jsHeap'),performance.memory?formatBytes(performance.memory.usedJSHeapSize):t('unknown'),t('heapHint')),
    cell(t('loopLag'),`${state.lag.toFixed(0)} ms`,t('loopHint'))
  ].join('');
  const gpuBuffers=Object.values(state.runtime.buffers).filter(b=>/webgpu/i.test(b.device));
  $('inferenceGrid').innerHTML=[
    cell(t('actualBackend'),actualBackend(),`wllama ${ENGINE_VERSION}`),
    cell(t('threadsActive'),state.model?state.threadCount:'—',state.model?(state.engine.isMultithread()?'Multithread':'Single thread'):''),
    cell(t('fileBytes'),state.selected?formatBytes(state.selected.totalBytes):'—',t('notRAM')),
    cell(t('gpuAllocated'),gpuBuffers.length?formatBytes(gpuBuffers.reduce((n,b)=>n+b.bytes,0)):t('unknown'),t('allocationHint')),
    cell(t('firstToken'),state.firstToken==null?'—':`${state.firstToken.toFixed(2)} s`),
    cell(t('outputSpeed'),state.speed==null?'—':`${state.speed.toFixed(1)} tok/s`,t('tokenSource')),
    cell(t('tokens'),state.tokenCount??'—'),cell(t('configuredContext'),state.loadedContext||'—')
  ].join('');
  $('engineLogs').textContent=state.logs.join('\n')||'—';
}
function renderHistory() {
  $('historyList').replaceChildren();
  if(!state.sessions.length){const p=document.createElement('p');p.className='micro';p.style.marginTop='20px';p.textContent=t('noHistory');$('historyList').append(p);return;}
  for(const s of state.sessions){const item=document.createElement('div');item.className='history-item';item.innerHTML=`<button data-open-chat="${escapeHTML(s.id)}"><strong>${escapeHTML(s.title||t('untitled'))}</strong><small>${new Date(s.updated||0).toLocaleString(lang==='zh'?'zh-CN':'en-US')} · ${s.messages.length}</small></button><button class="icon-btn" data-delete-chat="${escapeHTML(s.id)}" aria-label="${t('delete')}">×</button>`;$('historyList').append(item);}
}
function openSidebar(){if(matchMedia('(max-width:760px)').matches){$('sidebar').classList.add('open');$('sidebarShade').hidden=false;}}
function closeSidebar(){$('sidebar').classList.remove('open');$('sidebarShade').hidden=true;}
function download(text,name,type='text/plain;charset=utf-8') { const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }
async function copy(text){try{await navigator.clipboard.writeText(text);toast(t('copied'));}catch{toast(t('copyFailed'));}}
function startNewChat(){if(state.busy)return;saveChat();state.chat=freshChat();notice('');state.elapsed=0;state.speed=null;state.tokenCount=null;state.firstToken=null;renderMessages();renderMetrics();setStatus(state.model?'ready':'waiting');$('prompt').focus();closeSidebar();}

restore();applyLanguage();renderMetrics();
const hardwareReady=detectHardware();
$('modelFiles').addEventListener('change',e=>selectFiles(e.target.files));
for(const id of ['dropzone','heroChooseBtn'])$(id).addEventListener('click',async()=>{await (window.monoIsolationReady||Promise.resolve());$('modelFiles').click();});
for(const event of ['dragenter','dragover'])$('dropzone').addEventListener(event,e=>{e.preventDefault();if(!state.busy&&!state.model)$('dropzone').classList.add('dragging');});
for(const event of ['dragleave','drop'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.remove('dragging');});
$('dropzone').addEventListener('drop',async e=>{const files=Array.from(e.dataTransfer.files);await(window.monoIsolationReady||Promise.resolve());selectFiles(files);});
document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());
$('loadBtn').addEventListener('click',async()=>{await hardwareReady;loadModel();});$('unloadBtn').addEventListener('click',unloadModel);
$('composer').addEventListener('submit',e=>{e.preventDefault();generate();});
$('stopBtn').addEventListener('click',()=>{state.abort?.abort();setStatus('stopping');});
$('prompt').addEventListener('input',()=>{$('prompt').style.height='auto';$('prompt').style.height=Math.min(180,$('prompt').scrollHeight)+'px';setControls();});
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&matchMedia('(pointer:fine)').matches){e.preventDefault();generate();}});
$('languageBtn').addEventListener('click',()=>{lang=lang==='zh'?'en':'zh';try{localStorage.setItem('mono.gguf.language',lang);}catch{}applyLanguage();});
$('themeBtn').addEventListener('click',()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]').content=theme==='dark'?'#141414':'#f8f8f8';try{localStorage.setItem('mono.gguf.theme',theme);}catch{}});
for(const [button,dialog] of [['hardwareBtn','hardwareDialog'],['helpBtn','helpDialog'],['historyBtn','historyDialog']])$(button).addEventListener('click',()=>{if(dialog==='historyDialog')renderHistory();if(dialog==='hardwareDialog')renderHardware();$(dialog).showModal();});
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)dialog.close();}}));
$('sidebarBtn').addEventListener('click',openSidebar);$('closeSidebar').addEventListener('click',closeSidebar);$('sidebarShade').addEventListener('click',closeSidebar);
$('dismissNotice').addEventListener('click',()=>notice(''));$('newChatBtn').addEventListener('click',startNewChat);
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();startNewChat();}if(e.key==='Escape')closeSidebar();});
preferenceIds.forEach(id=>$(id).addEventListener('change',persistPreferences));$('thinking').addEventListener('change',persistPreferences);
$('saveHistory').addEventListener('change',()=>{persistPreferences();if(state.save)saveChat();else toast(t('saveOff'));});
$('messages').addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-regenerate'))return generate(true);
  if(button.dataset.messageCopy){const m=state.chat.messages.find(m=>m.id===button.dataset.messageCopy);if(m)copy(m.content);return;}
  const block=button.closest('.code-block');if(!block)return;
  const code=block.querySelector('code').textContent;
  if(button.hasAttribute('data-code-copy'))copy(code);
  if(button.hasAttribute('data-code-download')){const ext=({javascript:'js',typescript:'ts',python:'py',html:'html',xml:'xml',css:'css',json:'json',bash:'sh',shell:'sh',sql:'sql',markdown:'md',cpp:'cpp',java:'java'})[block.dataset.language]||'txt';download(code,`code.${ext}`);}
});
$('copyLogs').addEventListener('click',()=>copy(state.logs.join('\n')));
$('historyList').addEventListener('click',e=>{
  if(state.busy)return;const button=e.target.closest('button');if(!button)return;
  if(button.dataset.openChat){saveChat();const s=state.sessions.find(s=>s.id===button.dataset.openChat);if(s){state.chat=structuredClone(s);renderMessages();$('historyDialog').close();closeSidebar();}}
  if(button.dataset.deleteChat&&confirm(t('confirmDelete'))){state.sessions=state.sessions.filter(s=>s.id!==button.dataset.deleteChat);storeJSON(HISTORY_KEY,state.sessions);if(state.chat.id===button.dataset.deleteChat)state.chat=freshChat();renderMessages();renderHistory();$('historyCount').textContent=String(state.sessions.length);}
});
$('clearHistoryBtn').addEventListener('click',()=>{if(state.busy||!confirm(t('confirmClear')))return;state.sessions=[];state.chat=freshChat();storeJSON(HISTORY_KEY,[]);renderHistory();renderMessages();$('historyCount').textContent='0';});
$('importBtn').addEventListener('click',()=>$('importFile').click());
$('importFile').addEventListener('change',async e=>{try{const file=e.target.files[0];if(!file)return;const next=normalizeImport(JSON.parse(await file.text()));saveChat();state.chat=next;saveChat();renderMessages();renderHistory();$('historyDialog').close();}catch{notice(t('importInvalid'));}finally{$('importFile').value='';}});
$('exportBtn').addEventListener('click',()=>{
  if(!state.chat.messages.length){toast(t('emptyExport'));return;}
  // Two explicit export choices; no network or automatic publication.
  $('helpContent').replaceChildren();
  const row=document.createElement('div');row.className='row-actions';
  for(const format of ['md','json']){const btn=document.createElement('button');btn.className='subtle';btn.textContent=t(format==='md'?'exportMD':'exportJSON');btn.addEventListener('click',()=>{const name=`mono-chat-${new Date().toISOString().slice(0,10)}.${format}`;const content=format==='json'?JSON.stringify({version:1,title:state.chat.title,messages:state.chat.messages},null,2):`# ${state.chat.title||'MONO Chat'}\n\n`+state.chat.messages.map(m=>`## ${m.role}\n\n${m.reasoning?'[Thinking]\n'+m.reasoning+'\n\n':''}${m.content}`).join('\n\n---\n\n');download(content,name,format==='json'?'application/json':'text/markdown;charset=utf-8');$('helpDialog').close();});row.append(btn);}
  $('helpContent').append(row);$('helpDialog').showModal();
});
$('helpBtn').addEventListener('click',()=>{$('helpContent').innerHTML=helpHTML(lang);});
let tick=performance.now();
setInterval(()=>{const now=performance.now();state.lag=document.hidden?0:Math.max(0,now-tick-1000);tick=now;if($('hardwareDialog').open)renderHardware();},1000);
window.addEventListener('pagehide',()=>{saveChat();state.abort?.abort();});
document.addEventListener('visibilitychange',()=>{tick=performance.now();if(!document.hidden&&state.generating)holdAwake();});
