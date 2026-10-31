// Streaming historical pass measurement. PID distinguishes interleaved owners;
// old rows without a PID remain explicitly unattributed, never guessed.
import {readPassJournal} from '../line-service/pass-journal.mjs';
import {createHash} from 'node:crypto';
import {distribution} from './lifecycle.mjs';

export async function measureLinePasses({file,from,cutoff}){
  const time=value=>{if(!/(?:Z|[+-]\d\d:\d\d)$/.test(value??'')||!Number.isFinite(Date.parse(value)))throw Error('pass measurement requires timestamps with timezone');return Date.parse(value);};
  const start=time(from),end=time(cutoff);if(end<start)throw Error('pass measurement window is reversed');
  const active=new Map(),passes=[],hash=createHash('sha256'),unattributed={hold:0,'admission-eligible':0},totals={hold:0,'admission-eligible':0};
  let selected=0,throughLine=0;
  for(const row of readPassJournal(file)){
    throughLine++;const line=JSON.stringify(row),at=Date.parse(row.at);
    if(!Number.isFinite(at))throw Error(`pass row ${throughLine} has no valid timestamp`);
    if(at>end)continue;
    const owner=Number.isSafeInteger(row.pid)?row.pid:null;
    if(row.action==='pass-start'){
      if(owner!==null)active.set(owner,{pid:owner,started_at:row.at,source_head:row.source_head??null,hold:0,'admission-eligible':0});
    }
    if(at>=start){hash.update(line+'\n');selected++;if(Object.hasOwn(totals,row.action)){totals[row.action]++;if(owner===null)unattributed[row.action]++;}}
    const pass=active.get(owner);
    if(pass&&row.action==='queue-order'&&Array.isArray(row.candidates))pass.backlog=row.candidates.length;
    if(pass&&Object.hasOwn(totals,row.action))pass[row.action]++;
    if(row.action==='pass-complete'){
      if(at>=start)passes.push({...pass,pid:owner,completed_at:row.at,counts_known:Boolean(pass),
        ...(pass?{}:{hold:null,'admission-eligible':null}),duration_ms:row.timing?.duration_ms??null,backlog:row.backlog??pass?.backlog??null,evaluations:row.evaluations??null});
      active.delete(owner);
    }
  }
  return{schema:'brain.line-pass-measurement/v1',source:{file,from,cutoff,through_line:throughLine,selected_rows:selected,sha256:hash.digest('hex')},
    totals,unattributed,passes,duration:distribution(passes.map(p=>p.duration_ms)),
    qualification:'Counts use PID-bound start/completion rows. Older interleaved rows without PID have unknown per-pass counts. Duration excludes the separately recorded closeout turn; compare backlog and coverage before claiming improvement.'};
}
