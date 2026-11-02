// A shared observer is not a resident of each watched run. Only the original
// completed duty and its final callback can separate that host from closeout.
import path from 'node:path';
import {readPlainFile} from './files.mjs';
import {canonical} from './retire-local.mjs';
import {sameOwner} from './run-owner-guard.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {readInbox} from '../messages/inbox-read.mjs';

const optional = file => {
  try { return JSON.parse(readPlainFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};

// null means per-run mode; false keeps every unknown/pending shared binding.
export function sharedWatcherDischarged({run,state,events,scope,org,common,project,diagnostics}) {
  if(!org)return null;
  const reject = reason => {
    diagnostics?.push({run:run.id,reason:`shared watcher discharge rejected: ${reason}`});
    return false;
  };
  let stage='shared registration';
  try {
    const duty=optional(path.join(org,'watch/shared',`${run.id}.json`));
    if(duty===undefined)return null;
    const record=canonical(org),sameRecord=value=>typeof value==='string'&&path.isAbsolute(value)&&canonical(value)===record;
    if(scope?.run!==run.id||scope.cwd!==run.workspace||!run.report?.seq||
        run.owner?.legacy!==false||!run.owner_generation||run.meta?.dispatch_project!==common||!sameRecord(run.meta?.dispatch_record))
      return reject('run scope, report, claim or dispatch binding does not match');
    const owns = binding => sameOwner(binding?.owner,run.owner)&&binding.generation===run.owner_generation;
    const worker=effectiveWorkerIdentity(run,state),native=duty.native;
    if(duty.schema!=='brain.shared-watch/v1'||duty.run!==run.id||!sameRecord(duty.org)||duty.project!==common||duty.repo!==project||
        ![project,run.workspace].includes(duty.cwd)||duty.source!==run.owner.release?.root||!owns(duty.ownership)||
        duty.consumer!=='watch/watch.mjs --step'||!Array.isArray(duty.argv)||worker.identity_conflict||
        !native||[['agent','agent'],['pane','pane'],['workspace','worker_workspace'],['terminal','terminal_id']]
          .some(([key,field])=>typeof native[key]!=='string'||!native[key]||native[key]!==worker[field])||native.cwd!==run.workspace||
        typeof worker.agent_session_id!=='string'||!worker.agent_session_id||
        native.session!=null&&native.session!==''&&native.session!==worker.agent_session_id)
      return reject('shared registration or original native worker binding does not match');
    stage='observer host and finite step';
    const host=optional(path.join(org,'watch/observer/owner.json')),
      step=optional(path.join(org,'watch/steps',`${run.id}.json`));
    const recordedHost=run.meta.watcher_shared?JSON.parse(run.meta.watcher_host):{pid:Number(run.meta.watcher_pid),identity:run.meta.watcher_identity};
    if(run.meta.watcher_shared&&canonical(run.meta.watcher_shared)!==canonical(path.join(org,'watch/shared',`${run.id}.json`)))return reject('shared duty reference does not match');
    if(host?.schema!=='brain.run-observer-owner/v1'||!sameRecord(host.org)||host.project!==common||host.repo!==project||host.source!==duty.source||
        host.pid!==recordedHost.pid||host.identity!==recordedHost.identity)
      return reject('observer host binding does not match');
    if(step?.schema!=='brain.watch-step/v1'||step.run!==run.id||!owns(step.ownership))return reject('finite step binding does not match');
    if(step.phase!=='complete')return reject(`finite step phase is ${step.phase}`);
    if(!/^[a-f\d]{64}$/.test(step.signature??'')||step.next_at!==null||step.error)return reject('finite step completion evidence is invalid');
    if(optional(path.join(org,'watch/observer/held',`${run.id}.json`))!==undefined)return reject('observer duty is held');
    stage='callback receipt';
    const receipt=optional(path.join(org,'watch',`${run.id}.json`)),id=`watch:${run.id}:final`,inbox=path.join(org,'supervisor/inbox.log');
    // Record-only duties need no inbox file. Retirement's canonical identity
    // resolves existing ancestors while retaining the absent suffix.
    if(!receipt||!owns(receipt.ownership)||typeof receipt.inbox!=='string'||!path.isAbsolute(receipt.inbox)||canonical(receipt.inbox)!==canonical(inbox)||!Array.isArray(receipt.deliveries)||
        receipt.deliveries.some(value=>typeof value!=='string')||!receipt.deliveries.includes(id))
      return reject(`callback receipt binding or deliveries are invalid; required final notice ${id}`);
    if(duty.argv.includes('--record-only')) {
      // The finite watcher writes this claim-bound fact before completing. A
      // checkpoint alone must not invent a final notice or erase an intent.
      if(receipt.intent)return reject(`record-only callback has remaining intent ${receipt.intent}`);
      return receipt.deliveries.every(delivery=>events?.some(e=>e.type==='note.added'&&e.id===run.id&&
        e.watch_notice_id===delivery&&owns(e.watch_ownership))||reject(`record-only callback ${delivery} lacks its claim-bound note`));
    }
    if(![undefined,'delivery'].includes(receipt.intent))return reject(`callback has unsupported intent ${receipt.intent}`);
    stage='callback inbox';
    readPlainFile(inbox);
    const notices=readInbox(inbox);
    return receipt.deliveries.every(delivery=>{
      const notice=notices.find(n=>n.id===delivery);
      if(!notice)return reject(`callback ${delivery} is missing from the inbox`);
      if(!['pending','sent','handled'].includes(notice.state))return reject(`callback ${delivery} state is ${notice.state}`);
      if(notice.undeliverable)return reject(`callback ${delivery} is undeliverable: ${notice.undeliverable.reason??'no reason recorded'}`);
      if(!(notice.owner==='supervisor-inbox'&&Number.isSafeInteger(notice.owner_pid)&&notice.owner_pid>0&&
        notice.project?.repo===project&&notice.project.identity===common&&sameRecord(notice.project.org)&&
        notice.correlation?.run===run.id&&notice.correlation.project===common&&sameRecord(notice.correlation.record)&&
        typeof notice.to==='string'&&notice.to))return reject(`callback ${delivery} owner, project, correlation or recipient binding does not match`);
      if(notice.state==='pending'&&[worker.agent,worker.pane,worker.terminal_id].includes(notice.to))
        return reject(`callback ${delivery} is pending for worker ${notice.to}`);
      return true;
    });
  } catch (error) { return reject(`${stage} evidence unreadable: ${error.message}`); } // Unknown evidence keeps its owner.
}
