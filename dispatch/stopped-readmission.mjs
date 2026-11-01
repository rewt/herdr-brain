// A stopped request is never replayed. Its own terminal and completion may
// authorize one fresh intent; missing native progress is not zero-effect proof.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const reasons=new Set(['Supervisor STOP appeared before dispatch; no new worker launched','service STOP appeared before detached effect']);
const plain=file=>{
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error('stopped dispatch evidence is redirected');
  return fs.readFileSync(file);
};
export function stoppedDispatchReadmission({journal,repo,org,common,item,brief,input,events}) {
  if(!journal||path.dirname(path.resolve(journal))!==path.join(org,'dispatch'))return null;
  let bytes,job,terminal;
  try{
    bytes=plain(journal);job=JSON.parse(bytes);
    const result=plain(journal+'.driver/results.jsonl').toString('utf8');
    if(!result.endsWith('\n'))return null;
    terminal=JSON.parse(result.trim().split('\n').at(-1));
  }catch{return null;}
  if(job.repo!==repo||job.org!==org||job.common!==common||job.item!==item||job.brief!==brief||job.lineInput!==input||
      path.basename(journal)!==`${job.token}.json`||job.completion_protocol!==1||!job.detached||!job.detached_refused||
      !['open','start'].includes(job.stage)||job.run||job.worker||job.launchProcess||job.sessionBinding||job.native_launch_attempted!==false||
      job.failure?.code!=='DISPATCH_STOPPED'||job.failure.kind!=='fence'||job.failure.stage!==job.stage||job.failure.native_launch_attempted!==false||
      !reasons.has(job.error)||terminal.journal!==journal||terminal.stage!==job.stage||terminal.run||
      terminal.code!=='DISPATCH_STOPPED'||terminal.error!==job.error||terminal.native_launch_attempted!==false||
      !Number.isInteger(terminal.exit_code))return null;
  const request_sha256=hash(bytes);
  const completion=events.findLast(e=>e.type==='dispatch.completed'&&(e.journal===journal||e.attempt===job.token));
  if(!completion||completion.project!==common||completion.journal!==journal||completion.attempt!==job.token||completion.item!==item||
      completion.run||completion.stage!==job.stage||completion.exit_code!==terminal.exit_code||completion.native_launch_attempted!==false||
      completion.request_sha256!==request_sha256||JSON.stringify(completion.failure)!==JSON.stringify(job.failure)||
      events.some(e=>e.type==='run.started'&&(e.meta?.dispatch_journal===journal||e.meta?.dispatch_attempt===job.token||e.item===item&&e.seq>completion.seq)))return null;
  // The terminal row precedes request-lock cleanup. Never probe, reclaim or
  // replace a still-owned driver, even after it has published its completion.
  try{fs.lstatSync(journal+'.lock');return null;}catch(e){if(e.code!=='ENOENT')return null;}
  try{if(fs.readdirSync(journal+'.locks').length)return null;}catch(e){if(e.code!=='ENOENT')return null;}
  if(!plain(journal).equals(bytes))return null;
  return {schema:'dispatch-readmission/v1',kind:'stopped-before-native-launch',journal,attempt:job.token,
    completion_seq:completion.seq,request_sha256,terminal_sha256:hash(JSON.stringify(terminal)),native_launch_attempted:false};
}
