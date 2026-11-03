// A release predating pass-journal.mjs reads notice_audit_offset as a position in
// the live file, and never rotates. Later releases read it across retired segments.
// The stopped handoff between them converts that one number, in either direction,
// and its archive binds the exact change. Retired history stays in its segments.
import fs from 'node:fs';
import path from 'node:path';
import {readPlainFile,writeFileAtomic} from '../lib/files.mjs';
import {digest} from './runtime.mjs';
import {activeJournalWriters,passJournalExtent,rotatePassJournal,withPassJournal} from './pass-journal.mjs';
import {replayNoticeAudit} from './line-service.mjs';

const rotates=root=>fs.existsSync(path.join(root,'line-service/pass-journal.mjs'));
const files=directory=>({effects:path.join(directory,'effects.json'),audit:path.join(directory,'passes.jsonl')});
const readable=(audit,offset)=>withPassJournal(audit,view=>{for(const _row of view.rows(offset));});

export function planJournalHandoff({directory,fromRoot,targetRoot}){
  const leaving=rotates(fromRoot);if(leaving===rotates(targetRoot))return null;
  const {effects:file,audit}=files(directory);
  // A closeout turn can outlive its stopped job, and could still rotate past this plan.
  const writers=leaving?activeJournalWriters(audit):[];
  if(writers.length)throw Error(`pass journal has an active writer (${writers.join(', ')}); let it finish, then plan again`);
  if(!fs.existsSync(file))return null;
  const bytes=readPlainFile(file),effects=JSON.parse(bytes),before=effects.notice_audit_offset,{retired,size}=passJournalExtent(audit);
  if(before===undefined||!retired)return null;
  if(!Number.isSafeInteger(before)||before<0||before>(leaving?size:size-retired))throw Error('notice audit checkpoint is outside the pass journal; preserve it and plan nothing');
  let after,folded=[];
  if(!leaving){after=before+retired;readable(audit,after);}
  else if(before>=retired){after=before-retired;readable(audit,before);}
  // A rotation since the last checkpoint left unread rows out of the target's sight.
  // Replay them now, as the current release's next pass would.
  else{folded=replayNoticeAudit(audit,effects);after=size-retired;}
  effects.notice_audit_offset=after;
  const next=JSON.stringify(effects,null,2)+'\n';
  return {bytes:next,receipt:{basis:leaving?'live-file':'whole-journal',retired_bytes:retired,journal_bytes:size,offset_before:before,offset_after:after,
    notices_folded:folded,effects_before_sha256:digest(bytes),effects_after_sha256:digest(next)}};
}

export function applyJournalHandoff({directory,fromRoot,targetRoot,expected}){
  // Finishes only an interrupted rotation, whose bytes the plan already counted as retired.
  rotatePassJournal(files(directory).audit,{maxBytes:Number.MAX_SAFE_INTEGER});
  const plan=planJournalHandoff({directory,fromRoot,targetRoot});
  if(JSON.stringify(plan?.receipt)!==JSON.stringify(expected))throw Error('pass journal changed since its handoff plan; plan again');
  writeFileAtomic(files(directory).effects,plan.bytes,0o600);
}
