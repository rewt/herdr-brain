// Original-request continuation only. No native reads/effects or lock recovery.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const implementation=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
const plain=file=>{const s=fs.lstatSync(file);if(!s.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error('redirected original preflight evidence');return fs.readFileSync(file,'utf8');};
export function preflightContinuation({journal,repo,org,common,root=implementation,events=[]}) {
  if(!journal||path.dirname(path.resolve(journal))!==path.join(org,'dispatch'))return null;
  const bytes=plain(journal),job=JSON.parse(bytes);
  if(job.repo!==repo||job.org!==org||job.common!==common||job.release?.root!==root||
      ![job.phase1_protocol,job.reviewQueueProtocol].includes(1)||!['open','start'].includes(job.stage)||job.run||job.worker||job.launchProcess||job.sessionBinding||job.native_launch_attempted===true)return null;
  if(/EPERM|EACCES|native refusal|foreign|identity|reserved|HOLD|STOP|unknown|uncertain/i.test(job.error??'')||!job.error)return null;
  if(events.some(e=>e.type==='run.started'&&(e.meta?.dispatch_attempt===job.token||e.meta?.dispatch_journal===journal)))return null;
  let terminal=null;try{terminal=JSON.parse(plain(journal+'.driver/results.jsonl').trim().split('\n').at(-1));}catch(e){if(e.code!=='ENOENT')throw e;}
  const terminalZero=terminal?.journal===journal&&terminal.stage===job.stage&&!terminal.run&&Number.isInteger(terminal.exit_code)&&terminal.exit_code!==0&&terminal.error===job.error&&terminal.native_launch_attempted===false;
  if(job.native_launch_attempted!==false&&!terminalZero)return null;
  const files=['dispatch/dispatch.mjs','dispatch/preflight.mjs','dispatch/foreground-command.mjs','dispatch/outcome.mjs','dispatch/not-started.mjs','dispatch/request-lock.mjs','line-service/review-queue.mjs','line-service/review-group.mjs','dispatch/session-cap.mjs','dispatch/unlanded-cap.mjs'];
  const capability=hash(JSON.stringify(files.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])));
  if(job.preflightContinuations?.some(p=>p.capability===capability))return null;
  return{journal,token:job.token,job,request_sha256:hash(bytes),terminal_sha256:terminal?hash(JSON.stringify(terminal)):null,capability,native_launch_attempted:false};
}
