// A final report notice belongs to the durable transport, not the worker's
// allocation. This proves only that separation; it never settles delivery.
import path from 'node:path';
import {readPlainFile} from './files.mjs';
import {sameOwner} from './run-owner-guard.mjs';
import {effectiveWorkerIdentity} from './worker-identity.mjs';
import {readInbox} from '../messages/inbox-read.mjs';

export function reportWatcherHandedOff({run,state,scope,org,common,project}) {
  if(!org||scope?.run!==run.id||scope.cwd!==run.workspace||!run.report?.seq||
      run.owner?.legacy!==false||!run.owner_generation||run.meta?.dispatch_project!==common||run.meta?.dispatch_record!==org)return false;
  try {
    const receipt=JSON.parse(readPlainFile(path.join(org,'watch',`${run.id}.json`))),id=`watch:${run.id}:final`,
      inbox=path.join(org,'supervisor/inbox.log');
    if(!sameOwner(receipt.ownership?.owner,run.owner)||receipt.ownership.generation!==run.owner_generation||
        ![undefined,'delivery'].includes(receipt.intent)||receipt.inbox!==inbox||!Array.isArray(receipt.deliveries)||
        receipt.deliveries.some(value=>typeof value!=='string')||!receipt.deliveries.includes(id))return false;
    // Validate the ordinary no-redirect read before projecting the inbox. Torn,
    // missing or uncertain original attempts stay held and are never replaced.
    readPlainFile(inbox);
    const notice=readInbox(inbox).find(e=>e.id===id),worker=effectiveWorkerIdentity(run,state);
    return Boolean(notice&&['pending','sent','handled'].includes(notice.state)&&!notice.undeliverable&&
      notice.owner==='supervisor-inbox'&&Number.isSafeInteger(notice.owner_pid)&&notice.owner_pid>0&&
      notice.project?.repo===project&&notice.project.identity===common&&notice.project.org===org&&
      notice.correlation?.run===run.id&&notice.correlation.project===common&&notice.correlation.record===org&&
      !worker.identity_conflict&&typeof notice.to==='string'&&notice.to&&
      ![worker.agent,worker.pane,worker.terminal_id].includes(notice.to));
  } catch { return false; } // Unknown transport evidence retains the ordinary hold.
}
