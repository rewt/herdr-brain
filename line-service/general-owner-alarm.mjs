// Diagnostic ownership only. Never release a general slot or replay its effect.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {writeFileAtomic} from '../lib/store.mjs';

export function observeGeneralOwners({directory,identity,org,blocked,at}) {
  let release;
  try{release=noticeLock(path.join(directory,'general-owner-alarm.lock'));}
  catch(error){if(error.message.startsWith('locked:'))return;throw error;}
  try{
    const file=path.join(directory,'general-owner-alarm.json');
    const prior=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
    if(prior&&(prior.schema!=='line-general-owner-alarm/v1'||prior.identity!==identity||prior.org!==org))throw Error('general owner alarm binding changed');
    const owners=blocked?[0,1].map(slot=>{
      let owner=null,sha256=null;
      try{
        const bytes=fs.readFileSync(path.join(directory,`general-${slot}.lock`,'owner.json'));
        sha256=createHash('sha256').update(bytes).digest('hex');owner=JSON.parse(bytes);
      }catch{/* Missing or malformed owner remains UNKNOWN; no recovery authority. */}
      return{slot,owner,sha256,age_ms:Number.isFinite(Date.parse(owner?.at))?Math.max(0,Date.parse(at)-Date.parse(owner.at)):null};
    }):[];
    const signature=blocked?JSON.stringify(owners.map(({slot,sha256})=>({slot,sha256}))):null;
    const state={schema:'line-general-owner-alarm/v1',identity,org,signature,owners,
      turns:blocked?(prior?.signature===signature?prior.turns+1:1):0,
      first_seen:blocked&&prior?.signature===signature?prior.first_seen:at,observed_at:at};
    state.alarmed=blocked&&(state.turns>=3||owners.some(owner=>owner.age_ms>=1800000));
    if(state.alarmed?(!prior?.alarmed||prior.signature!==signature):prior?.alarmed){
      fs.appendFileSync(path.join(directory,'closeout.log'),JSON.stringify({
        action:'closeout-supervisor-alarm',boundary:'general-owner-held',at,owner:'project-supervisor',
        count:state.alarmed?owners.length:0,oldest:state.alarmed?owners.map(row=>row.owner?.at).filter(value=>Number.isFinite(Date.parse(value))).sort()[0]??state.first_seen:null,
        scopes:state.alarmed?owners.map(owner=>({key:`general-${owner.slot}`,kind:'general-owner-held',...owner,first_seen:state.first_seen})):[],
        authority:'visibility only; original holds and effects retained'})+'\n',{mode:0o600});
    }
    writeFileAtomic(file,JSON.stringify(state)+'\n',0o600);
    return state;
  }finally{release();}
}
