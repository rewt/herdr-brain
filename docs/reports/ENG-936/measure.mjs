// Read-only bounded record measurement. No native observations or mutations.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fold,itemStatus} from '../../../lib/state.mjs';

const [org,throughText]=process.argv.slice(2),through=Number(throughText);
if(!path.isAbsolute(org??'')||!Number.isSafeInteger(through)||through<1)
  throw Error('usage: node docs/reports/ENG-936/measure.mjs ABSOLUTE_ORG THROUGH_SEQ');
const lines=fs.readFileSync(path.join(org,'events.jsonl'),'utf8').trimEnd().split('\n');
const selected=lines.filter(line=>JSON.parse(line).seq<=through),events=selected.map(JSON.parse);
if(events.at(-1)?.seq!==through)throw Error('requested immutable cutoff missing');
const state=fold(events),count=rows=>rows.reduce((out,key)=>(out[key]=(out[key]??0)+1,out),{});
const classify=i=>i.meta.uncertain_outcome?.check?.key?.split(':')[0]??(i.meta.decision_request?'typed-blocked':'owner-selected');
const items=[...state.items.values()].filter(i=>i.role==='decision');
const rows=items.map(i=>({id:i.id,class:classify(i),created:i.created.seq,status:itemStatus(state,i.id),
  runs:i.runs.map(id=>{const run=state.runs.get(id);return{id,started:run.started.at,reported:run.report?.at??null,
    outcome:run.report?.outcome??null,report_seq:run.report?.seq??null,
    action:run.report?.extra?.decision?.action??null};})}));
const backlog=[...state.items.values()].filter(i=>i.meta.backlog_batch!==undefined).map(i=>({id:i.id,batch:i.meta.backlog_batch,status:itemStatus(state,i.id),runs:i.runs}));
console.log(JSON.stringify({verifier:'R-1258 / lane-decision-chur-c7a295-bce45a',org,through,at:events.at(-1).at,
  event_prefix_sha256:createHash('sha256').update(selected.join('\n')+'\n').digest('hex'),
  decisions:{total:rows.length,classes:count(rows.map(r=>r.class)),statuses:count(rows.map(r=>r.status)),
    started_runs:rows.flatMap(r=>r.runs).length,reported_runs:rows.flatMap(r=>r.runs).filter(r=>r.outcome).length,rows},
  typed_events:events.filter(e=>/^decision\.(applied|stale|consequence)$/.test(e.type)).map(e=>({seq:e.seq,type:e.type,id:e.id,action:e.action,result:e.result,success:e.success})),
  backlog:{items:backlog.length,started_runs:backlog.flatMap(r=>r.runs).length,statuses:count(backlog.map(r=>r.status)),rows:backlog},
  limits:['Reported or closed diagnostic work is not resolved original work.','No causal time-saving or token/cost estimate is available.','Historic native ownership and current live acceptance are not re-probed.']},null,2));
