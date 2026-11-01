// One additive installation effect, with immutable before/after evidence.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {plainDirectory,readPlainFile} from '../lib/files.mjs';
import {canonical} from '../messages/schema.mjs';
import {loginRegistration} from './login-registration.mjs';
const same=(a,b)=>canonical(a)===canonical(b);
const hash=v=>createHash('sha256').update(v).digest('hex');
export function loginChanges(events,{repo,org,identity,directory}){
  const rows=events.filter(e=>e.type==='line-service.login-registered'&&e.project===identity&&e.org===org);
  const folder=path.join(directory,'login-registrations');
  if(fs.existsSync(folder)){
    plainDirectory(folder,{create:false});
    if(!same(fs.readdirSync(folder).sort(),rows.map(e=>e.id+'.json').sort()))throw Error('existing/UNKNOWN login registration retained; no replay or replacement');
  }else if(rows.length)throw Error('login registration archive missing');
  if(rows.length>1)throw Error('login registration already recorded; no replacement');
  return rows.map(event=>{
    if(event.schema!=='line-login-registration/v1'||!Number.isSafeInteger(event.seq)||!Number.isSafeInteger(event.previous_seq)||event.seq<=event.previous_seq||
        !/^[a-f0-9]{64}$/.test(event.id??'')||event.repo!==repo||event.archive?.file!==path.join(folder,event.id+'.json'))throw Error('login registration binding differs');
    const bytes=readPlainFile(event.archive.file),archive=JSON.parse(bytes);
    if(hash(bytes)!==event.archive.sha256||(fs.statSync(event.archive.file).mode&0o222)||archive.schema!==event.schema||archive.id!==event.id||
        archive.repo!==repo||archive.org!==org||archive.identity!==identity||archive.previous_seq!==event.previous_seq||!same(archive.owner,event.native_caller))throw Error('login registration archive changed');
    const before=JSON.parse(archive.before.installation),after=JSON.parse(archive.after.installation);
    if(before.login||!same(after,{...before,login:loginRegistration(`dev.herdr.line.${path.basename(directory)}`,path.join(directory,'service.plist'),archive.user_home)})||
        archive.after.plist!==archive.before.plist)throw Error('login registration changes more than the login entry');
    return {event,archive};
  });
}
export function applyLoginChange({event,archive},{installation,plist,last}){
  if(event.previous_seq!==last.seq||!same(JSON.parse(archive.before.installation),installation)||archive.before.plist!==plist)throw Error('login registration history differs');
  return {installation:JSON.parse(archive.after.installation),plist,last:event};
}
