/** Real creator fees -> 50/50 -> buybacks, before and after graduation. Local validator only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, Transaction, TransactionMessage, VersionedTransaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { requireLocalValidator } from './lib/test-cluster.mjs';
import { PROGRAM, WSOL, LEGACY_TOKEN, readCounter, vaultPda, holderPda, ataFor, tokenBalance, isGraduated } from './lib/cycle.mjs';
import { feeState, sharingConfigPda } from './lib/fees.mjs';
import { correctFrozenSplit } from './lib/fee-split.mjs';
import { ensureLookupTable, instructionTableAddresses } from './lib/alt.mjs';
const require=createRequire(import.meta.url),pump=require('@pump-fun/pump-sdk'),amm=require('@pump-fun/pump-swap-sdk'),spl=require('@solana/spl-token'),BN=require('bn.js');
const RPC=process.env.RPC_URL??'http://127.0.0.1:8899';requireLocalValidator(RPC);
const connection=new Connection(RPC,'confirmed');
const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_WALLET_PATH??path.join(os.homedir(),'.config/solana/id.json'),'utf8'))));
const runDir=path.resolve('state',`auto-test-${Date.now()}`);fs.mkdirSync(runDir,{recursive:true});
const launchState=path.join(runDir,'launch.json');
const keeper=Keypair.generate(),keeperFile=path.join(runDir,'test-keeper.json');
fs.writeFileSync(keeperFile,JSON.stringify(Array.from(keeper.secretKey)),{mode:0o600});
const receiptFile=path.join(runDir,'receipts.jsonl');
let passed=0;const checks=[];
function ok(condition,name){assert(condition,name);passed++;checks.push(name);console.log(`  PASS  ${name}`);}
function run(script,args=[],env={}){return execFileSync('node',[`scripts/${script}`,...args],{encoding:'utf8',timeout:180000,env:{...process.env,RPC_URL:RPC,LAUNCH_STATE:launchState,KEEPER_WALLET_PATH:keeperFile,KEEPER_RECEIPTS_PATH:receiptFile,...env},stdio:['ignore','pipe','pipe']});}
async function trade(instructions,lookup=[]){
  if(!lookup.length)return sendAndConfirmTransaction(connection,new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:650000}),...instructions),[payer]);
  const latest=await connection.getLatestBlockhash();
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:650000}),...instructions]}).compileToV0Message(lookup));
  tx.sign([payer]);
  const sig=await connection.sendRawTransaction(tx.serialize());
  const res=await connection.confirmTransaction({signature:sig,...latest},'confirmed');
  assert.equal(res.value.err,null,JSON.stringify(res.value.err));return sig;
}
const sdk=new pump.PumpSdk(),online=new pump.OnlinePumpSdk(connection);
console.log('== atomic launch and pre-graduation fee routing ==');
try { console.log(run('launch.mjs',['--execute','--uri','https://example.invalid/lockedin-rehearsal.json']).split('\n').filter(l=>/confirmed|created,|verified:|already/.test(l)).join('\n')); }
catch(e){console.error((e.stderr?.toString()??'').split('\n').filter(l=>/Error|Message:|Anchor|failed/.test(l)).slice(0,12).join('\n'));throw new Error('Atomic launch rehearsal failed; see diagnostics above');}
const state=JSON.parse(fs.readFileSync(launchState,'utf8'));
const mint=new PublicKey(state.steps.mint.address),vault=vaultPda(mint);
const tokenProgram=(await connection.getAccountInfo(mint)).owner;
const mintInfo=await spl.getMint(connection,mint,'confirmed',tokenProgram);
ok(mintInfo.mintAuthority===null && mintInfo.freezeAuthority===null,'Mint and freeze authorities are revoked');
ok(correctFrozenSplit(await feeState(connection,mint,payer.publicKey,{check:false}),vault,payer.publicKey),'Frozen 50/50 split exists before graduation');
ok(!await isGraduated(connection,mint),'New token starts on the bonding curve');
ok(state.steps.create.atomicFeeRouting===true,'Creation, frozen fee shares and 2 SOL dev buy were atomic');
const counter0=await readCounter(connection,mint);
ok(counter0.totalHolders===0,'Registration starts with no invented holders');
run('launch.mjs',['--execute','--uri','https://example.invalid/lockedin-rehearsal.json']);
ok((await readCounter(connection,mint)).nextIndex===0,'Re-running launch preserves the mint and counter');
const gasEvents=run('keeper.mjs',['--once','--execute','--mint',mint.toBase58()]).split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
ok(gasEvents.some(e=>e.kind==='insufficient-gas'),'An empty keeper wallet reports insufficient gas explicitly');
try { run('launch.mjs',['--plan'],{DEPLOYER_WALLET_PATH:keeperFile});assert.fail('Wrong creator was accepted'); }
catch(e){ok((e.stderr?.toString()??'').includes('another creator wallet'),'Launch refuses a different creator wallet on resume');}
const wrongNetwork=path.join(runDir,'wrong-network.json');
fs.writeFileSync(wrongNetwork,JSON.stringify({...state,genesis:'another-test-network'}),{mode:0o600});
try { run('launch.mjs',['--plan'],{LAUNCH_STATE:wrongNetwork});assert.fail('Wrong network was accepted'); }
catch(e){ok((e.stderr?.toString()??'').includes('another Solana network'),'Launch refuses a different network on resume');}
await trade([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:keeper.publicKey,lamports:500_000_000})]);
const global=await online.fetchGlobal(),feeConfig=await online.fetchFeeConfig();
async function curveBuy(sol,complete=false){
  const s=await online.fetchBuyState(mint,payer.publicKey),supply=new BN((await connection.getTokenSupply(mint)).value.amount);
  let solAmount=new BN(Math.round(sol*1e9));
  const amount=complete?s.bondingCurve.realTokenReserves:pump.getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:supply,bondingCurve:s.bondingCurve,amount:solAmount,quoteMint:WSOL}).muln(90).divn(100);
  if(complete)solAmount=pump.getBuySolAmountFromTokenAmount({global,feeConfig,mintSupply:supply,bondingCurve:s.bondingCurve,amount,quoteMint:WSOL}).muln(110).divn(100);
  return trade(await sdk.buyInstructions({global,bondingCurveAccountInfo:s.bondingCurveAccountInfo,bondingCurve:s.bondingCurve,associatedUserAccountInfo:s.associatedUserAccountInfo,mint,user:payer.publicKey,amount,solAmount,slippage:10,tokenProgram}));
}
for(let n=0;n<4;n++)await curveBuy(10);
const curveFees=await feeState(connection,mint,keeper.publicKey);
ok(curveFees.canDistribute && curveFees.distributableLamports>0n,'Real bonding-curve trades produced distributable creator fees');
async function keeperCycle(market){
  const before=await readCounter(connection,mint);
  const out=run('keeper.mjs',['--once','--execute','--mint',mint.toBase58()]);
  console.log(out.trim());
  const events=out.split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
  const claim=events.find(e=>e.kind==='fees-distributed'),locked=events.find(e=>e.kind==='locked');
  ok(Boolean(claim),`${market}: keeper distributes creator fees without the creator signing`);
  const claimTx=await connection.getTransaction(claim.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
  const keys=claimTx.transaction.message.accountKeys??claimTx.transaction.message.staticAccountKeys;
  const index=keys.findIndex(k=>k.equals(vault));
  assert(index>=0);
  const received=BigInt(claimTx.meta.postBalances[index]-claimTx.meta.preBalances[index]);
  ok(received===BigInt(claim.lamports)/2n,`${market}: vault received exactly half the distributable fees`);
  ok(Boolean(locked)&&locked.market===market,`${market}: keeper bought and recorded a verified lock`);
  const after=await readCounter(connection,mint);
  ok(after.nextIndex===before.nextIndex+1&&after.totalHolders===before.totalHolders+1,`${market}: holder count increased by exactly one`);
  const holder=holderPda(mint,before.nextIndex),balance=await tokenBalance(connection,ataFor(holder,tokenProgram,mint));
  ok(!PublicKey.isOnCurve(holder.toBytes())&&balance>0n,`${market}: new address is keyless and actually funded`);
  ok(after.totalLocked-before.totalLocked===balance,`${market}: counter equals the new holder balance`);
  ok(await tokenBalance(connection,ataFor(vault,tokenProgram,mint))===0n,`${market}: purchased tokens all left the buyback vault`);
  return locked;
}
await keeperCycle('bonding-curve');
console.log('== graduate the same token and migrate its liquidity ==');
await curveBuy(0,true);
ok(await isGraduated(connection,mint),'Real buying completed the bonding curve');
const migration=await sdk.migrateV2Instruction({withdrawAuthority:global.withdrawAuthority,mint,user:payer.publicKey,quoteMint:WSOL,baseTokenProgram:tokenProgram,quoteTokenProgram:LEGACY_TOKEN});
// Separate table: do not warm or extend the keeper's launch table in the test.
const {table:migrationTable}=await ensureLookupTable(connection,payer,Keypair.generate().publicKey,instructionTableAddresses([migration],[payer.publicKey]));
const migrated=await trade([migration],[migrationTable]);
console.log(`  migration ${migrated}`);
const pool=amm.canonicalPumpPoolPda(mint,WSOL);
ok(Boolean(await connection.getAccountInfo(pool)),'Pump created a real canonical PumpSwap pool');
const ammOnline=new amm.OnlinePumpAmmSdk(connection);
const poolState=await ammOnline.swapSolanaState(pool,payer.publicKey);
ok(poolState.pool.coinCreator.equals(sharingConfigPda(mint)),'Graduation preserved the frozen creator-fee routing');
async function ammBuy(){
  const s=await ammOnline.swapSolanaState(pool,payer.publicKey);
  const ixs=await amm.PUMP_AMM_SDK.buyQuoteInput(s,new BN(10_000_000_000),10);
  const {table}=await ensureLookupTable(connection,payer,Keypair.generate().publicKey,instructionTableAddresses(ixs,[payer.publicKey]));
  await trade(ixs,[table]);
}
for(let n=0;n<4;n++)await ammBuy();
const ammFees=await feeState(connection,mint,keeper.publicKey);
ok(ammFees.graduated&&ammFees.canDistribute&&ammFees.distributableLamports>0n,'Real PumpSwap trades produced distributable creator fees');
await keeperCycle('pumpswap');
// A repeat PumpSwap cycle, once every one-time account exists, must cost the
// keeper only transaction fees. It used to pre-create the vault's wrapped-SOL
// account on every cycle -- about 0.002 SOL each, closed into the vault -- which
// would have emptied a 0.1 SOL keeper after about 44 cycles.
for(let n=0;n<2;n++)await ammBuy();
const keeperBefore=await connection.getBalance(keeper.publicKey);
const repeat=run('keeper.mjs',['--once','--execute','--mint',mint.toBase58()]);
const repeatLocked=repeat.split('\n').some(l=>{try{return JSON.parse(l).kind==='locked';}catch{return false;}});
const keeperCost=keeperBefore-await connection.getBalance(keeper.publicKey);
ok(repeatLocked&&keeperCost<500_000,`pumpswap: a repeat cycle costs the keeper only transaction fees (${keeperCost} lamports)`);
console.log('== unattended keeper follows new trading activity ==');
const baseline=await readCounter(connection,mint);
const logFile=path.join(runDir,'unattended.log'),logFd=fs.openSync(logFile,'w',0o600);
const loop=spawn('node',['scripts/keeper.mjs','--execute','--mint',mint.toBase58()],{env:{...process.env,RPC_URL:RPC,KEEPER_WALLET_PATH:keeperFile,KEEPER_RECEIPTS_PATH:receiptFile,KEEPER_INTERVAL_MS:'15000'},stdio:['ignore',logFd,logFd]});
try {
  await ammBuy();await ammBuy();
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){
    const events=fs.readFileSync(logFile,'utf8').split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
    if(events.some(e=>e.kind==='locked'&&e.index>=baseline.nextIndex))break;
    if(loop.exitCode!==null)throw new Error(`Unattended keeper exited ${loop.exitCode}`);
    await new Promise(r=>setTimeout(r,1000));
  }
  const events=fs.readFileSync(logFile,'utf8').split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
  ok(events.some(e=>e.kind==='locked'&&e.index>=baseline.nextIndex&&e.market==='pumpswap'),'Running keeper reacts to new trading activity without a manual trigger');
  const after=await readCounter(connection,mint);
  ok(after.totalHolders>baseline.totalHolders,'Unattended execution increases the on-chain holder count');
  for(let i=baseline.nextIndex;i<after.nextIndex;i++){
    const holder=holderPda(mint,i);
    assert(!PublicKey.isOnCurve(holder.toBytes())&&await tokenBalance(connection,ataFor(holder,tokenProgram,mint))>0n);
  }
  ok(true,'Every unattended cycle created a funded keyless holder');
} finally {
  const stopped=new Promise(resolve=>loop.once('exit',resolve));
  loop.kill('SIGTERM');
  if(loop.exitCode===null)await stopped;
  fs.closeSync(logFd);
}
ok(!(await connection.getAccountInfo(ataFor(vault,LEGACY_TOKEN,WSOL))),'Cycle closes the vault wrapped-SOL account and recovers its rent');
const end=await readCounter(connection,mint);
let sum=0n;
for(let i=0;i<end.nextIndex;i++)sum+=await tokenBalance(connection,ataFor(holderPda(mint,i),tokenProgram,mint));
ok(sum===end.totalLocked,'Every holder balance sums to the on-chain total');
fs.mkdirSync('data',{recursive:true});
fs.writeFileSync('data/auto-flow-results.json',JSON.stringify({at:new Date().toISOString(),passed,checks,mint:mint.toBase58(),program:PROGRAM.toBase58(),rpc:RPC,totalHolders:end.totalHolders,totalLocked:end.totalLocked.toString()},null,2));
console.log(`  ${passed} passed, 0 failed`);
