import { PublicKey } from '@solana/web3.js';
import { PROGRAM, configPda } from './cycle.mjs';
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** Read authority fields from the deployed program, never from operator notes. */
export async function programPermanence(connection){
  const result={immutable:null,adminRenounced:null,paused:null};
  const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const info=await connection.getAccountInfo(PROGRAM);
  if(!info?.executable)return result;
  if(info.owner.equals(loader)&&info.data.length>=36&&info.data.readUInt32LE(0)===2){
    const data=await connection.getAccountInfo(new PublicKey(info.data.subarray(4,36)));
    if(data?.owner.equals(loader)&&data.data.length>=13&&data.data.readUInt32LE(0)===3)result.immutable=data.data[12]===0;
  }
  const config=await connection.getAccountInfo(configPda());
  if(config?.owner.equals(PROGRAM)&&config.data.length>=42){
    result.adminRenounced=config.data.subarray(8,40).equals(Buffer.alloc(32));
    result.paused=config.data[40]!==0;
  }
  return result;
}
