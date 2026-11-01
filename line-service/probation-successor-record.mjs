// The effect depends on lifecycle history and its authorities, not worker
// progress. Keep this projection shared by preview/apply and fence clearing.
import {fold} from '../lib/state.mjs';
import {canonical} from '../messages/schema.mjs';
import {successorDigest} from './probation-successor-history.mjs';

const lifecycle=new Set(['line-service.cutover','line-service.phase0',
  'line-service.runtime-migrated','line-service.runtime-upgraded',
  'line-service.recipient-retargeted','line-service.login-registered',
  'line-service.probation-authorized','line-service.probation-withdrawn','line-service.probation-completed',
  'line-service.probation-switched','line-service.probation-successor-authorized','line-service.probation-successor-switched']);

export function successorRecordDigest(events,c,{recoveryAuthority}={}){
  const rows=events.filter(e=>lifecycle.has(e.type)&&e.project===c.identity&&e.org===c.org);
  const authorities=new Set(rows.map(e=>e.authority).filter(Number.isSafeInteger));
  if(Number.isSafeInteger(recoveryAuthority))authorities.add(recoveryAuthority);
  const notes=events.filter(e=>authorities.has(e.seq)),state=fold(events);
  const owners=[...new Set(notes.map(e=>e.id))].sort().map(id=>{
    const run=state.runs.get(id),ancestry=[],seen=new Set();
    for(let subject=run?.item??id;subject;){
      if(seen.has(subject)){ancestry.push({cycle:subject});break;}
      seen.add(subject);const item=state.items.get(subject);
      if(!item){ancestry.push({missing:subject});break;}
      ancestry.push({id:subject,parent:item.parent,human:item.role==='human',
        ...Object.fromEntries(['hold','held','operator_reserved','reserved'].map(key=>[key,Boolean(item.meta[key])]))});
      subject=item.parent;
    }
    // Ordinary report/closure and unrelated metadata do not revoke a trial.
    return{id,run:run?{item:run.item,abandoned:Boolean(run.abandoned)}:null,ancestry};
  });
  return successorDigest(canonical({rows,notes,owners}));
}
