// Suppression/visibility only, in the existing closer worker log. Completion,
// native refusals and effect intent/outcome remain in the authoritative record.
import fs from 'node:fs';
import path from 'node:path';

export function routineCloseoutObservation(row) {
  if(row.completed!==false||row.sessions_retired||row.resolved_by)return false;
  const reason=row.reason??'';
  // Unknown or safety-sensitive outcomes must never be downgraded to a log.
  if(/EPERM|EACCES|native|identity|unknown|HOLD|STOP|reserved|source|binding|head|generation|preserv|archive|unsafe|claim|ownership|replaced|refus|failed/i.test(reason))return false;
  return /reference|callback.*live|open run|chain|continuation|successor|follow.up|report.*ingested|focus|this tab|^locked:|retirement deadline reached|bound session remains|no bound session target|^landed or parked request owns/i.test(reason);
}

const diagnosticFile=common=>path.join(common,'closeout/worker.log');
function plainLog(file) {
  const directory=path.dirname(file),parent=fs.lstatSync(directory,{throwIfNoEntry:false});
  if(parent&&(!parent.isDirectory()||fs.realpathSync(directory)!==directory))throw Error('closeout diagnostic directory is redirected; keep');
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(stat&&(!stat.isFile()||fs.realpathSync(file)!==file))throw Error('closeout diagnostic log is redirected; keep');
  return stat;
}
export function appendCloseoutObservation(common,org,row,events) {
  if(!routineCloseoutObservation(row))throw Error('durable closeout outcome cannot be diagnostic');
  const file=diagnosticFile(common);plainLog(file);
  const prior=readCloseoutObservations(common,org,events).findLast(e=>e.key===row.key);
  if(prior&&['source','revision','reason','resources'].every(k=>JSON.stringify(prior[k])===JSON.stringify(row[k])))return;
  const fd=fs.openSync(file,fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,JSON.stringify({schema:'closeout-diagnostic/v1',org,at:new Date().toISOString(),observed_seq:events.at(-1)?.seq??0,evaluation:row})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
}

export function readCloseoutObservations(common,org,events) {
  const file=diagnosticFile(common);if(!plainLog(file))return[];
  const raw=fs.readFileSync(file,'utf8');if(raw&&!raw.endsWith('\n'))throw Error('incomplete closeout diagnostic tail; keep original bytes');
  const rows=[];
  for(const line of raw.split('\n')){
    // worker.log also contains the existing command's stdout/stderr.
    if(!line.startsWith('{"schema":"closeout-diagnostic/v1",'))continue;
    const saved=JSON.parse(line),row=saved.evaluation;
    if(saved.org!==org)continue;
    if(!row||row.identity!==common||!routineCloseoutObservation(row)||!Number.isSafeInteger(saved.observed_seq)||saved.observed_seq>(events.at(-1)?.seq??0)||!Number.isSafeInteger(row.revision)||row.revision>saved.observed_seq)throw Error('invalid closeout diagnostic; keep');
    const source=events.find(e=>e.seq===row.source?.seq&&e.type===row.source?.type),target=source?.closeout_targets?.find(t=>t.key===row.key);
    if(!target||target.common!==common||target.org!==org||target.run!==row.run||target.item!==row.item||row.revision<source.seq)throw Error('closeout diagnostic source changed; keep');
    rows.push({...row,diagnostic:true,observed_seq:saved.observed_seq});
  }
  return rows;
}
