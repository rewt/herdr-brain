// Canonical non-session service producer into the EXISTING record inbox.
import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { transact } from '../lib/store.mjs';
import { validateEvent,canonical } from '../messages/schema.mjs';
import { recordMessages } from '../messages/operator-inbox.mjs';
import { validateOperatorText } from '../messages/operator-text.mjs';
import {ownerIdentity} from '../lib/process-owner.mjs';
import { identityRootAt } from '../messages/journal.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
import { installedContext,regularJSON } from './cutoff.mjs';

const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
export function canonicalFailure(reason) {
  return String(reason??'UNKNOWN').split(/\r?\n/).filter(line=>!/^\s*(?:at\s|node:|file:\/\/)/.test(line)).join(' ').trim().replace(/\s+/g,' ')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?\b/g,'<time>')
    .replace(/\b(pid|process)[ :=#]+\d+\b/gi,(_match,label)=>`${label.toLowerCase()}=<pid>`).slice(0,1024);
}
export function serviceRecordBinding({repo,org,env=process.env,owner='pass'}) {
  const c=installedContext(repo,org);
  if(env.HERDR_ENV==='1'||env.HERDR_PANE_ID)throw Error('service inbox never borrows a native session context');
  if(!['pass','closeout-turn'].includes(owner))throw Error('unknown service record owner');
  const lock=regularJSON(path.join(c.directory,`${owner}.lock`,'owner.json'));
  if(lock?.pid!==process.pid||owner==='closeout-turn'&&(!lock.identity||lock.identity!==ownerIdentity(process.pid)))
    throw Error(`service inbox requires its actual owned ${owner} lock`);
  const root=identityRootAt(c.identity);if(!root)throw Error('service identity root is UNKNOWN');
  // Fresh accepted-release installs have no wall-clock `at` field. Keep that
  // absence explicit without changing the epoch of older dated installations.
  return {...c,identityName:path.basename(root),epoch:digest({identity:c.identity,org:c.org,installed_at:c.installation.at??null,source:c.installation.source,node:c.installation.node,target:c.installation.target})};
}
export function recordLineNotice({repo,org,id,boundary,reason,scope={},first_at,audit,counts,env=process.env,kind='question',question}) {
  // Routine notices and error counts already have a durable diagnostic delta.
  // Only an actual named reserved decision belongs in this record inbox path.
  if(kind!=='question'||!question)throw Error('routine line notices belong in diagnostics; name an actual pending reserved decision');
  const binding=serviceRecordBinding({repo,org,env});
  const saved=transact(org,(events,state)=>{
    serviceRecordBinding({repo,org,env});
    const messages=recordMessages(events),prior=messages.find(e=>e.envelope.eventId===id)?.envelope;
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
    return protectRecordMutation({org,events,state,command:'messages',mutation:{add:prior?[]:[{type:'session.message.v1',envelope}],result:prior??envelope}});
  },{actor:'line-service',strictTail:true,lockOptions:{recover:false}});
  return {id:saved.result.eventId,recorded:true,state:'record-only',envelope:saved.result,binding};
}
