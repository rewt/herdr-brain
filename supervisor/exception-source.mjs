// Capture evidence at the original sender. Inbox transport remains unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadRecord} from '../lib/store.mjs';
import {ancestors} from '../lib/state.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {dispatchSourceBinding} from '../lib/source-provenance.mjs';
import {policyLocation} from '../lib/config-home.mjs';

export const exceptionDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const exceptionMessage = message => /^\[worker-(exception|question)\] run=(R-\d+) item=([A-Z]+-\d+) worker=([a-zA-Z0-9_-]+) (\S[\s\S]*)$/.exec(message ?? '');
export function exceptionIntent({state,events}, run) {
  const item=state.items.get(run.item),lineage=[item,...ancestors(state,item.id)],ids=new Set(lineage.map(i=>i.id));
  return {items:lineage.map(i=>({id:i.id,title:i.title,accept:i.accept,parent:i.parent,meta:i.meta,closed:i.closed})),
    decisions:events.filter(e=>e.type==='note.added'&&e.decision&&ids.has(e.id)),
    current_run:item.runs.at(-1),report:run.report??null,abandoned:run.abandoned??null};
}
export function exceptionSource(workspace) {
  const git=args=>execFileSync('git',['--no-optional-locks','-C',workspace,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  // Untracked bytes have no immutable source witness. Retain such exceptions
  // with the custodian rather than claiming a complete capture from filenames.
  if(git(['ls-files','--others','--exclude-standard']))throw Error('untracked source needs its original owner');
  return {head:git(['rev-parse','HEAD']),diff:exceptionDigest(git(['diff','HEAD','--binary']))};
}
export function exceptionPolicy(repo,org,env=process.env) {
  return [...['lane','promote'].map(kind=>policyLocation(repo,kind,env).file),path.join(org,'config.json')].map(file=>{
    return {file,digest:fs.existsSync(file)?exceptionDigest(fs.readFileSync(file,'utf8')):null};
  });
}
export function captureWorkerException({message,project,correlation,cwd,env=process.env,call}) {
  if(!/^\[worker-(exception|question)\]/.test(message??''))return undefined;
  try{
    const parsed=exceptionMessage(message);
    if(!parsed||!project||!correlation||parsed[2]!==correlation.run)throw Error('malformed or uncorrelated worker exception');
    const binding=nativeSender(project.org,{cwd,env,...(call?{call}:{})});
    if(binding.project.identity!==project.identity||binding.project.canonical!==project.repo||correlation.record!==project.org||correlation.project!==project.identity)throw Error('exception project/record changed');
    const record=loadRecord(project.org),run=record.state.runs.get(parsed[2]);
    if(record.tornTail||!run||run.item!==parsed[3]||run.report||run.abandoned)throw Error('exception needs its current unfinished run');
    const w=effectiveWorkerIdentity(run,record.state),n=binding.native;
    if(w.identity_conflict||w.agent!==parsed[4]||w.agent!==n.name||w.pane!==n.pane_id||w.worker_workspace!==n.workspace_id||w.terminal_id!==n.terminal_id||w.agent_session_id!==n.agent_session.value||run.workspace!==binding.project.checkout)throw Error('exception native worker differs from original run');
    const source=dispatchSourceBinding({run,events:record.events,identity:project.identity,org:project.org});
    return {schema:'brain.worker-exception/v1',kind:parsed[1],source,worker:{agent:w.agent,pane:w.pane,workspace:w.worker_workspace,terminal:w.terminal_id,session:w.agent_session_id},
      intent:exceptionIntent(record,run),code:exceptionSource(run.workspace),policy:exceptionPolicy(project.repo,project.org,env),observed_seq:record.events.at(-1)?.seq??0};
  }catch(error){return {schema:'brain.worker-exception/v1',unproven:error.message};}
}
