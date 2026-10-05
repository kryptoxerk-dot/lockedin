/* Render chain readings safely; an old reading must never look live. */
const $ = (id) => document.getElementById(id);
const fill = (name, value) => document.querySelectorAll(`[data-fill="${name}"]`).forEach(el => { el.textContent = value; });
const short = (s) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const key = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const signature = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s);
function amount(raw, decimals) {
  if (raw == null) return 'Unavailable';
  const n = BigInt(raw), unit = 10n ** BigInt(decimals ?? 6), whole = n / unit;
  for (const [size, label] of [[1_000_000_000n,'B'],[1_000_000n,'M'],[1000n,'K']]) {
    if (whole >= size) return `${(Number(whole) / Number(size)).toFixed(2)}${label}`;
  }
  if (whole === 0n && n > 0n) return '<1';
  return whole.toLocaleString();
}
const ago = (ms) => ms < 60_000 ? `${Math.max(0,Math.floor(ms/1000))}s ago` : ms < 3_600_000 ? `${Math.floor(ms/60_000)}m ago` : `${Math.floor(ms/3_600_000)}h ago`;
function value(id, text) { const el=$(id); if(el.textContent!==text){ el.textContent=text; el.classList.remove('changed'); void el.offsetWidth; el.classList.add('changed'); } }
function check(id,text,verified){const el=$(id);el.textContent=text;el.className=verified?'verified':'unverified';}
function empty(text){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.className='empty';td.textContent=text;tr.append(td);$('rows').replaceChildren(tr);$('prev').disabled=true;$('next').disabled=true;$('range').textContent='';}
const PAGE=12;
/* The wall: one padlock per locked holder. Past the cap only the latest are drawn. */
const WALL_CAP=360,GHOSTS=120;
let wallCount=null;
function renderWall(count,prelaunch){
  const key=count===null?(prelaunch?'pre':'none'):count;
  if(key===wallCount)return;
  const previous=typeof wallCount==='number'?wallCount:null;wallCount=key;
  const frag=document.createDocumentFragment();
  if(!count){
    for(let i=0;i<GHOSTS;i++){const s=document.createElement('span');s.className=i===0?'lk ghost next':'lk ghost';frag.append(s);}
    $('wall-caption').textContent=prelaunch?'The first lock goes up with the first buyback after launch.':count===0?'No locks yet. The first one goes up when the vault can cover a buyback.':'Lock readings are unavailable right now.';
  }else{
    // A phone shows ten rows, not forty.
    const shown=Math.min(count,matchMedia('(max-width: 680px)').matches?90:WALL_CAP);
    for(let i=0;i<shown;i++){const s=document.createElement('span');s.className='lk';if(i===shown-1){s.classList.add('latest');if(previous!==null&&count>previous)s.classList.add('newest');}frag.append(s);}
    $('wall-caption').textContent=`${count.toLocaleString()} lock${count===1?'':'s'} on the wall${count>shown?`, showing the latest ${shown}`:''}. Each is a funded address with no private key.`;
  }
  $('wall').classList.toggle('is-empty',!count);$('wall').replaceChildren(frag);
}
let state=null,received=0,offline=false,loading=false,decimals=6,from=null,total=0,lastCount=null,mintAddress=null,tableRequest=0;
function status(){
  if(!state)return;
  const elapsed=Date.now()-received,age=(state.ageMs??0)+elapsed;
  if(offline){$('status').className='status broken';$('status').textContent=`Cannot reach the server. ${state.ready?`Last chain reading ${ago(age)}.`:'Production data is unavailable.'}`;$('launch-badge').textContent='DATA OFFLINE';$('launch-badge').dataset.state='bad';return;}
  if(!state.ready&&state.phase==='unregistered'){
    $('status').className='status pending';$('status').textContent='Launched. The buyback keeper is starting: live lock readings appear here within minutes.';
    $('launch-badge').textContent='LIVE · STARTING';$('launch-badge').dataset.state='pre';$('footer-phase').textContent='Launched';return;
  }
  if(!state.ready){
    const prelaunch=state.phase==='prelaunch';$('status').className=prelaunch?'status pending':'status broken';
    $('status').textContent=prelaunch?'Pre-launch. No production mint is configured. Live readings will appear after launch.':state.error??'Production data is not ready.';
    $('launch-badge').textContent=prelaunch?'PRE-LAUNCH':'NOT VERIFIED';$('launch-badge').dataset.state=prelaunch?'pre':'bad';$('footer-phase').textContent=prelaunch?'Pre-launch':'Data unavailable';return;
  }
  const stale=age>state.refreshMs*3;
  const market=state.market==='pumpswap'?'PumpSwap':state.market==='bonding-curve'?'Bonding curve':'Market unknown';
  $('status').className=stale?'status stale':'status';$('status').textContent=`${market} · chain reading ${ago(age)}${stale?' · STALE: refresh delayed':''}`;
  $('launch-badge').textContent=stale?'READING STALE':state.cluster==='mainnet-beta'?'ON SOLANA':'TEST NETWORK';$('launch-badge').dataset.state=stale?'pre':state.cluster==='mainnet-beta'?'live':'pre';
  $('footer-phase').textContent=stale?'Stale reading':state.cluster==='mainnet-beta'?'Production readings':'Test network';
  const k=state.keeper;
  const kAge=k?Math.max(0,k.ageMs+elapsed):null;
  if(!k)check('keeper-check','No keeper receipts available on this server',false);
  else check('keeper-check',`${k.lastKind} · ${ago(kAge)}${k.reason?` · ${k.reason}`:''}`,kAge<180_000&&!/error|pending|insufficient/.test(k.lastKind));
}
async function loadState(){
  if(loading)return;loading=true;
  try{
    const res=await fetch('/api/state',{cache:'no-store'});if(!res.ok)throw new Error('state request failed');
    state=await res.json();received=Date.now();offline=false;
    if(state.program)fill('program',state.program);
    mintAddress=key(state.mint)?state.mint:null;$('copy-mint').disabled=!mintAddress;
    fill('mint',mintAddress??'Awaiting launch — no production mint configured');
    $('buy').hidden=!((state.ready||state.phase==='unregistered')&&mintAddress&&state.cluster==='mainnet-beta');
    $('hud-ca').textContent=mintAddress??'Published at launch';
    $('hud-market').textContent=!state.ready?(state.phase==='prelaunch'?'Opens at launch':'Unavailable'):state.market==='pumpswap'?'PumpSwap':state.market==='bonding-curve'?'Bonding curve':'Unknown';
    if(!$('buy').hidden)$('buy').href=`https://pump.fun/coin/${mintAddress}`;
    if(!state.ready){
      ['holders','locked','percent','pending'].forEach(id=>value(id,'—'));
      renderWall(null,state.phase==='prelaunch'||state.phase==='unregistered');
      empty(state.phase==='prelaunch'?'No production cycles yet. The ledger opens after launch.':state.phase==='unregistered'?'Launched. The first lock appears here once the keeper runs its first buyback.':'Chain data is unavailable. Please check again shortly.');lastCount=null;
      check('split-check','Awaiting on-chain verification',false);check('program-check','Awaiting on-chain verification',false);check('keeper-check','No production reading yet',false);
      $('freshness').textContent='No production readings are displayed until the mint is configured and registered.';
      status();return;
    }
    decimals=state.decimals;['vault','counter'].forEach(name=>state[name]&&fill(name,state[name]));
    value('holders',state.holders.toLocaleString());renderWall(state.holders,false);value('locked',amount(state.totalLocked,decimals));value('percent',`${state.lockedPercent.toFixed(3)}%`);value('pending',(state.vaultLamports/1e9).toFixed(4));
    const s=state.split;
    const splitVerified=s?.vaultBps===5000&&s.editable===false;
    check('split-check',splitVerified?'50% to the buyback vault · share configuration frozen':s?.exists?`${(s.vaultBps??0)/100}% to vault · ${s.editable===true?'configuration can still change':'configuration not fully verified'}`:'Fee sharing is not configured for this mint',splitVerified);
    const f=state.forwarding;
    if(!f?.active)$('forward-note').hidden=true;
    if(f?.active){
      $('hero-desc').textContent='Every creator fee buys $LOCKEDIN and locks it in a wallet nobody holds a key to. Every buyback adds one more locked holder.';
      $('hud-fees').textContent='100% locks';
      $('forward-note').hidden=false;$('forward-total').textContent=`${(f.forwardedLamports/1e9).toFixed(4)} SOL`;
      $('forward-wallet').href=`https://solscan.io/account/${f.creator}`;
      $('loop-fees').textContent=`pump.fun charges a creator fee on every trade. The on-chain split is frozen at half to the buyback vault, half to the creator, and since ${f.since.slice(0,10)} the creator wallet sends its half on to the vault automatically.`;
    }
    check('forward-check',f?.active?`Creator's 50% forwarded to the vault · ${(f.forwardedLamports/1e9).toFixed(4)} SOL since ${f.since.slice(0,10)}`:'The creator keeps its 50%',Boolean(f?.active));
    const p=state.permanence;
    check('program-check',p?.immutable===true?`Upgrade authority revoked${p.paused?' · CYCLES PAUSED':p.adminRenounced?' · pause authority renounced':' · pause authority remains'}`:p?.immutable===false?'Program remains upgradeable · permanent lock guarantee not established':'Program upgrade authority could not be verified',p?.immutable===true&&p.adminRenounced===true&&!p.paused);
    $('freshness').textContent=`Chain readings refresh every ${Math.round(state.refreshMs/1000)}s. Balances are read per address; missing readings are marked unavailable.`;
    if(lastCount!==state.nextIndex){lastCount=state.nextIndex;total=state.nextIndex;if(from===null)from=Math.max(0,total-PAGE);await loadHolders();}
    status();
  }catch{offline=true;if(!state){$('status').className='status broken';$('status').textContent='Cannot reach the server. Production readings are unavailable.';$('launch-badge').textContent='DATA OFFLINE';$('launch-badge').dataset.state='bad';}else status();}
  finally{loading=false;}
}
function link(kind,address,label){const a=document.createElement('a');a.href=`https://explorer.solana.com/${kind}/${address}${state?.cluster==='devnet'?'?cluster=devnet':''}`;a.textContent=label;a.target='_blank';a.rel='noopener noreferrer';return a;}
async function loadHolders(){
  const request=++tableRequest;
  try{
    const res=await fetch(`/api/holders?from=${from??0}&count=${PAGE}`,{cache:'no-store'});const data=await res.json();if(!res.ok||data.error)throw new Error(data.error??'Could not load the ledger.');if(request!==tableRequest)return;
    total=data.total;
    if(!data.holders.length){empty('No cycles yet. A cycle runs when the vault can cover a buyback and account costs.');return;}
    const fragment=document.createDocumentFragment();
    for(const h of data.holders.slice().reverse()){
      const tr=document.createElement('tr'),cells=Array.from({length:5},()=>document.createElement('td'));
      cells[0].textContent=String(h.index);cells[1].className='addr';
      if(key(h.address)&&key(h.tokenAccount)){const proof=link('address',h.tokenAccount,h.address);proof.title='View the token account owned by this keyless holder';cells[1].append(proof);}else cells[1].textContent='Invalid holder or token account';
      cells[2].className='num';cells[2].textContent=amount(h.amount,decimals);
      cells[3].className=h.offCurve?'keyless':'oncurve';cells[3].textContent=h.offCurve?'No key':'ON CURVE';
      cells[4].append(signature(h.signature)?link('tx',h.signature,short(h.signature)):document.createTextNode('No receipt recorded'));
      tr.append(...cells);fragment.append(tr);
    }
    $('rows').replaceChildren(fragment);
    const last=Math.min((from??0)+PAGE,total);$('range').textContent=`${from??0}–${last-1} of ${total}`;$('prev').disabled=last>=total;$('next').disabled=(from??0)<=0;
  }catch(e){if(request===tableRequest)empty(e.message);}
}
$('next').onclick=()=>{from=Math.max(0,(from??0)-PAGE);loadHolders();};
$('prev').onclick=()=>{from=Math.min(Math.max(0,total-PAGE),(from??0)+PAGE);loadHolders();};
$('copy-mint').onclick=async()=>{try{await navigator.clipboard.writeText(mintAddress);$('copy-feedback').textContent='Mint address copied.';}catch{$('copy-feedback').textContent='Copy unavailable. Select the mint address above to copy it.';}};
loadState();setInterval(loadState,15_000);setInterval(status,1000);
window.addEventListener('focus',loadState);document.addEventListener('visibilitychange',()=>{if(!document.hidden){status();loadState();}});
