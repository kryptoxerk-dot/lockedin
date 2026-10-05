/** Exercise the actual dashboard API against the disposable rehearsal chain. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, getPermanentDelegate, getAccount } from '@solana/spl-token';
import { requireLocalValidator } from './lib/test-cluster.mjs';
import { readCounter } from './lib/cycle.mjs';
const rpc=process.env.RPC_URL??'http://127.0.0.1:8899';requireLocalValidator(rpc);
const proof=JSON.parse(fs.readFileSync('data/auto-flow-results.json','utf8'));
const connection=new Connection(rpc,'confirmed'),mint=new PublicKey(proof.mint);
const tokenProgram=(await connection.getAccountInfo(mint)).owner;
const folders=fs.readdirSync('state').filter(n=>n.startsWith('auto-test-')).sort();
const launchDir=folders.findLast(n=>JSON.parse(fs.readFileSync(path.join('state',n,'launch.json'),'utf8')).steps.mint.address===proof.mint);
const receipts=path.resolve('state',launchDir,'receipts.jsonl');
fs.appendFileSync(receipts,JSON.stringify({at:new Date().toISOString(),kind:'locked',mint:PublicKey.default.toBase58(),index:0,signature:'wrong-mint-transaction'})+'\n');
let passed=0;const checks=[];
function ok(condition,name){assert(condition,name);passed++;checks.push(name);console.log(`  PASS  ${name}`);}
async function withServer(port,cluster,work){
  const child=spawn('node',['site/server.mjs'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SOLANA_CLUSTER:cluster,RPC_URL:rpc,LOCKEDIN_MINT:proof.mint,KEEPER_RECEIPTS_PATH:receipts},stdio:'ignore'});
  try {
    const base=`http://127.0.0.1:${port}`;
    let ready=false;
    for(let i=0;i<40;i++){try{const r=await fetch(base+'/healthz');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
    assert(ready,'Test dashboard did not start');
    await work(base);
  }finally{
    const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');if(child.exitCode===null)await stopped;
  }
}
await withServer(8791,'localnet',async base=>{
  const state=await(await fetch(base+'/api/state')).json(),counter=await readCounter(connection,mint);
  ok(state.ready&&state.mint===proof.mint&&state.holders===counter.totalHolders&&state.totalLocked===counter.totalLocked.toString(),'Dashboard figures match the real on-chain counter');
  ok(state.permanence.immutable&&state.permanence.adminRenounced&&state.permanence.paused===false,'Dashboard verifies actual immutable deployment and renounced pause admin');
  ok(state.split.vaultBps===5000&&state.split.editable===false,'Dashboard verifies the actual frozen 50% fee route');
  ok(state.market==='pumpswap','Dashboard detects actual graduation');
  const list=await(await fetch(base+'/api/holders?from=0&count=200')).json();
  ok(list.holders.length===counter.totalHolders&&list.holders.every(h=>h.offCurve&&BigInt(h.amount)>0n),'Dashboard lists every actually funded keyless holder');
  ok(list.holders.reduce((sum,h)=>sum+BigInt(h.amount),0n)===counter.totalLocked,'Dashboard holder balances sum to the real locked total');
  const mintInfo=await getMint(connection,mint,'confirmed',tokenProgram);
  assert(!mintInfo.mintAuthority&&!mintInfo.freezeAuthority&&!getPermanentDelegate(mintInfo));
  for(const holder of list.holders){
    const account=await getAccount(connection,new PublicKey(holder.tokenAccount),'confirmed',tokenProgram);
    assert(account.owner.equals(new PublicKey(holder.address))&&!account.delegate&&!account.closeAuthority);
  }
  ok(true,'Mint and holder accounts have no mint, freeze, permanent-delegate, delegate or close authority that could bypass the lock');
  ok(list.holders[0].signature!=='wrong-mint-transaction'&&state.keeper.lastKind==='locked','Receipts for another mint cannot replace this token’s transaction or activity');
});
await withServer(8793,'mainnet-beta',async base=>{
  const state=await(await fetch(base+'/api/state')).json();
  ok(!state.ready&&state.phase==='unavailable','A test RPC cannot appear as a ready mainnet token');
  ok((await fetch(base+'/api/holders')).status===502,'Holder API also rejects a wrongly configured network');
});
fs.writeFileSync('data/site-chain-results.json',JSON.stringify({at:new Date().toISOString(),passed,checks},null,2));
console.log(`  ${passed} passed, 0 failed`);
