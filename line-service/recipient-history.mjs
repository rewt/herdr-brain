// Recipient changes are part of the same saved-installation history as runtime
// handoffs. An unmatched intent fences startup; it never authorizes a retry.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPlainFile,plainDirectory} from '../lib/files.mjs';
import {canonical} from '../messages/schema.mjs';

export const recipientName=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);

// The complete plist schema is checked by savedPlist before mutation. Replace
// just the recipient's string contents, preserving every other saved byte.
export function recipientPlist(bytes,oldRecipient,newRecipient){
  if(!recipientName(oldRecipient)||!recipientName(newRecipient))throw Error('invalid service recipient');
  let arrays=0;
  const next=bytes.replace(/(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(<\/array>)/g,(_,start,body,end)=>{
    arrays++;let index=0;
    const replacement=body.replace(/<string>([\s\S]*?)<\/string>/g,(string,value)=>{
      if(index++!==8)return string;
      if(value!==oldRecipient)throw Error('saved plist recipient differs');
      return `<string>${newRecipient}</string>`;
    });
    if(index!==11)throw Error('saved plist arguments differ');
    return start+replacement+end;
  });
  if(arrays!==1)throw Error('saved plist arguments missing/ambiguous');
  return next;
}

export function recipientChanges(events,{repo,org,identity,directory}){
  const rows=events.filter(e=>e.type==='line-service.recipient-retargeted'&&e.project===identity&&e.org===org);
  const folder=path.join(directory,'retargets');
  if(fs.existsSync(folder)){
    plainDirectory(folder,{create:false});
    if(!same(fs.readdirSync(folder).sort(),rows.map(e=>e.id+'.json').sort()))throw Error('existing/UNKNOWN recipient retarget is retained; no replay or replacement');
  }else if(rows.length)throw Error('recipient retarget archive is missing');
  const ids=new Set();
  return rows.map(event=>{
    if(event.schema!=='line-recipient-retarget/v1'||!Number.isSafeInteger(event.seq)||!Number.isSafeInteger(event.previous_seq)||event.seq<=event.previous_seq||
        !/^[a-f0-9]{64}$/.test(event.id??'')||ids.has(event.id)||event.repo!==repo||event.archive?.file!==path.join(folder,event.id+'.json')||
        !recipientName(event.old_recipient)||!recipientName(event.new_recipient)||event.old_recipient===event.new_recipient)throw Error('recipient retarget binding differs');
    ids.add(event.id);
    const bytes=readPlainFile(event.archive.file),archive=JSON.parse(bytes);
    if(hash(bytes)!==event.archive.sha256||archive.schema!==event.schema||archive.id!==event.id||archive.repo!==repo||archive.org!==org||archive.identity!==identity||
        archive.previous_seq!==event.previous_seq||archive.old_recipient!==event.old_recipient||archive.new_recipient!==event.new_recipient)throw Error('recipient retarget archive changed');
    const before=JSON.parse(archive.before.installation),after=JSON.parse(archive.after.installation);
    if(before.recipient!==undefined&&before.recipient!==event.old_recipient||!same(after,{...before,recipient:event.new_recipient})||
        archive.after.plist!==recipientPlist(archive.before.plist,event.old_recipient,event.new_recipient))throw Error('recipient retarget changes more than the recipient');
    return {event,archive};
  });
}
export function applyRecipientChange({event,archive},{installation,plist,last}){
  if(event.previous_seq!==last.seq||!same(JSON.parse(archive.before.installation),installation)||archive.before.plist!==plist)throw Error('recipient retarget history differs');
  return {installation:JSON.parse(archive.after.installation),plist:archive.after.plist,last:event};
}
export function legacyRecipientHistory(changes,{installation,plist,cutover}){
  if(!changes.length)return;
  let state={installation:JSON.parse(changes[0].archive.before.installation),plist:changes[0].archive.before.plist,last:cutover};
  for(const change of changes)state=applyRecipientChange(change,state);
  if(!same(state.installation,installation)||state.plist!==plist)throw Error('retargeted installation/plist drifted');
}
