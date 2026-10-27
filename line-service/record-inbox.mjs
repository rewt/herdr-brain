// Canonical non-session service producer into the EXISTING record inbox.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { validateEvent,canonical } from '../messages/schema.mjs';
import { recordMessages } from '../messages/operator-inbox.mjs';
import { validateOperatorText } from '../messages/operator-text.mjs';
import { identityRootAt } from '../messages/journal.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
import { installedContext,regularJSON } from './cutoff.mjs';

const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
export function canonicalFailure(reason) {
  return String(reason??'UNKNOWN').split(/\r?\n/).filter(line=>!/^\s*(?:at\s|node:|file:\/\/)/.test(line)).join(' ').trim().replace(/\s+/g,' ')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?\b/g,'<time>')
    .replace(/\b(pid|process)[ :=#]+\d+\b/gi,(_match,label)=>`${label.toLowerCase()}=<pid>`).slice(0,1024);
}
export function serviceRecordBinding({repo,org,env=process.env}) {
  const c=installedContext(repo,org);
  if(env.HERDR_ENV==='1'||env.HERDR_PANE_ID)throw Error('service inbox never borrows a native session context');
  const owner=regularJSON(path.join(c.directory,'pass.lock','owner.json'));
  if(owner?.pid!==process.pid)throw Error('service inbox requires its actual owned pass lock');
  const root=identityRootAt(c.identity);if(!root)throw Error('service identity root is UNKNOWN');
  return {...c,identityName:path.basename(root),epoch:digest({identity:c.identity,org:c.org,installed_at:c.installation.at,source:c.installation.source,node:c.installation.node,target:c.installation.target})};
}
// One typed event per error key at its first occurrence; later repeats are one
// aggregate counts event per batch, never one more event per key per pass.
export function reviewErrorFacts(events,binding,org,rows){
  const known=new Map(),first=new Map(),fresh=[],counts={};
  for(const e of events){
    if(e.type==='line-service.review-error'){if(!first.has(e.key))first.set(e.key,e);known.set(e.key,Math.max(known.get(e.key)??0,Number.isSafeInteger(e.count)?e.count:1));}
    else if(e.type==='line-service.review-error-counts'&&e.counts&&typeof e.counts==='object')for(const [key,count]of Object.entries(e.counts))if(Number.isSafeInteger(count))known.set(key,Math.max(known.get(key)??0,count));
  }
  for(const row of rows){
    const {key,count,boundary,reason,scope}=row;
    if(!Number.isSafeInteger(count)||count<1||key!==digest([boundary,reason,scope]))throw Error('review error counter/source is inconsistent');
    const event={type:'line-service.review-error',id:`${key}:${count}`,project:binding.identity,org,key,count,boundary,reason,scope},prior=first.get(key);
    if(!prior){fresh.push(event);first.set(key,event);known.set(key,count);continue;}
    for(const k of ['type','project','org','key','boundary','reason','scope'])if(canonical(prior[k])!==canonical(event[k]))throw Error('review error counter id has different source/content');
    if(count>(known.get(key)??0)){counts[key]=count;known.set(key,count);}
  }
  const keys=Object.keys(counts).sort(),aggregate=keys.length?[{type:'line-service.review-error-counts',id:digest([binding.identity,org,keys.map(k=>[k,counts[k]])]),project:binding.identity,org,counts:Object.fromEntries(keys.map(k=>[k,counts[k]]))}]:[];
  return [...fresh,...aggregate];
}
export function recordLineNotice({repo,org,id,boundary,reason,scope={},first_at,audit,counts,env=process.env,kind='fyi',question,reviewError}) {
  const binding=serviceRecordBinding({repo,org,env});
  const saved=transact(org,events=>{
    serviceRecordBinding({repo,org,env});
    const state=fold(events),messages=recordMessages(events),prior=messages.find(e=>e.envelope.eventId===id)?.envelope;
    const refs=[];
    if(scope.run&&state.runs.has(scope.run)){const r=state.runs.get(scope.run);refs.push({orgRef:org,run:r.id,item:r.item});}
    else if(scope.item&&state.items.has(scope.item))refs.push({orgRef:org,item:scope.item});
    if(question){const q=state.items.get(question);if(!q||q.role!=='human'||q.meta.operator_reserved!==true||q.closed||q.meta.answer||q.meta.decider!=='brain-chat')throw Error('no actual pending explicitly named reserved decision');refs.push({orgRef:org,item:question});}
    const address={identity:binding.identityName,projectRef:binding.identity};
    const envelope={schema:'brain.log/v1',type:'session.message.v1',eventId:id,producer:{id:'line-service',epoch:binding.epoch,sequence:prior?.producer.sequence??1+Math.max(0,...messages.filter(e=>e.envelope.producer.id==='line-service'&&e.envelope.producer.epoch===binding.epoch).map(e=>e.envelope.producer.sequence))},
      occurredAt:prior?.occurredAt??first_at,level:'info',identity:binding.identityName,project:{commonDir:binding.identity},orgRef:org,source:{kind:'service',ref:binding.installationFile},
      payload:{from:{...address,role:{name:'line-service',bindingRef:binding.installationFile}},to:[{...address,role:{name:'operator',bindingRef:'brain-chat'}}],kind,
        summary:question?'A recorded decision needs attention.':'The service recorded an action for inspection.',
        operator_text:{happened:question?'A pending decision names its decider. Its details remain in the record.':'One action could not proceed. Other eligible work can continue.',action:question?'Your decision is needed.':'The service owner can inspect the details.',details:`${boundary}; ${reason}; audit=${audit}; counts=${counts}`.slice(0,4096)},
        refs,reply_to:null,priority:'normal',reply_by:null,body_ref:null,decision_ref:null,
        service_notice:{boundary,reason,scope,audit,counts}}};
    validateEvent(envelope);validateOperatorText(envelope.payload.summary,envelope.payload.operator_text);
    if(prior&&canonical(prior)!==canonical(envelope))throw Error('service stable message id has different content/source/target');
    const errors=reviewError?reviewErrorFacts(events,binding,org,[reviewError]):[];
    return protectRecordMutation({org,events,state,command:'messages',mutation:{add:[...errors,...(prior?[]:[{type:'session.message.v1',envelope}])],result:prior??envelope}});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
  return {id:saved.result.eventId,recorded:true,state:'record-only',envelope:saved.result,binding,...(reviewError?{review_error_recorded:true}:{})};
}
