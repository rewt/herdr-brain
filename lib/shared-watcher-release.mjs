// A shared observer is not a resident of each watched run. Only the original
// completed duty and its final callback can separate that host from closeout.
import path from 'node:path';
import {readPlainFile} from './files.mjs';
import {sameOwner} from './run-owner-guard.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {readInbox} from '../messages/inbox-read.mjs';

const optional = file => {
  try { return JSON.parse(readPlainFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};

// null means per-run mode; false keeps every unknown/pending shared binding.
export function sharedWatcherDischarged({run,state,events,scope,org,common,project}) {
  if(!org)return null;
  try {
    const duty=optional(path.join(org,'watch/shared',`${run.id}.json`));
    if(duty===undefined)return null;
    if(scope?.run!==run.id||scope.cwd!==run.workspace||!run.report?.seq||
        run.owner?.legacy!==false||!run.owner_generation||run.meta?.dispatch_project!==common||run.meta?.dispatch_record!==org)return false;
    const owns = binding => sameOwner(binding?.owner,run.owner)&&binding.generation===run.owner_generation;
    const worker=effectiveWorkerIdentity(run,state),native=duty.native;
    if(duty.schema!=='brain.shared-watch/v1'||duty.run!==run.id||duty.org!==org||duty.project!==common||duty.repo!==project||
        ![project,run.workspace].includes(duty.cwd)||duty.source!==run.owner.release?.root||!owns(duty.ownership)||
        duty.consumer!=='watch/watch.mjs --step'||!Array.isArray(duty.argv)||worker.identity_conflict||
        !native||[['agent','agent'],['pane','pane'],['workspace','worker_workspace'],['terminal','terminal_id'],['session','agent_session_id']]
          .some(([key,field])=>typeof native[key]!=='string'||!native[key]||native[key]!==worker[field])||native.cwd!==run.workspace)return false;
    const host=optional(path.join(org,'watch/observer/owner.json')),
      step=optional(path.join(org,'watch/steps',`${run.id}.json`));
    if(host?.schema!=='brain.run-observer-owner/v1'||host.org!==org||host.project!==common||host.repo!==project||host.source!==duty.source||
        host.pid!==Number(run.meta.watcher_pid)||host.identity!==run.meta.watcher_identity||
        step?.schema!=='brain.watch-step/v1'||step.run!==run.id||!owns(step.ownership)||step.phase!=='complete'||
        !/^[a-f\d]{64}$/.test(step.signature??'')||step.next_at!==null||step.error||
        optional(path.join(org,'watch/observer/held',`${run.id}.json`))!==undefined)return false;
    const receipt=optional(path.join(org,'watch',`${run.id}.json`)),id=`watch:${run.id}:final`,inbox=path.join(org,'supervisor/inbox.log');
    if(!receipt||!owns(receipt.ownership)||receipt.inbox!==inbox||!Array.isArray(receipt.deliveries)||
        receipt.deliveries.some(value=>typeof value!=='string')||!receipt.deliveries.includes(id))return false;
    if(duty.argv.includes('--record-only')) {
      // The finite watcher writes this claim-bound fact before completing. A
      // checkpoint alone must not invent a final notice or erase an intent.
      return !receipt.intent&&receipt.deliveries.every(delivery=>events?.some(e=>e.type==='note.added'&&e.id===run.id&&
        e.watch_notice_id===delivery&&owns(e.watch_ownership)));
    }
    if(![undefined,'delivery'].includes(receipt.intent))return false;
    readPlainFile(inbox);
    const notices=readInbox(inbox);
    return receipt.deliveries.every(delivery=>{
      const notice=notices.find(n=>n.id===delivery);
      return Boolean(notice&&['pending','sent','handled'].includes(notice.state)&&!notice.undeliverable&&
        notice.owner==='supervisor-inbox'&&Number.isSafeInteger(notice.owner_pid)&&notice.owner_pid>0&&
        notice.project?.repo===project&&notice.project.identity===common&&notice.project.org===org&&
        notice.correlation?.run===run.id&&notice.correlation.project===common&&notice.correlation.record===org&&
        typeof notice.to==='string'&&notice.to&&
        (notice.state!=='pending'||![worker.agent,worker.pane,worker.terminal_id].includes(notice.to)));
    });
  } catch { return false; } // Unknown duty/transport evidence keeps its owner.
}
