// Read the ORIGINAL request only. No native calls, process probes, retries,
// journal edits or missing-run => zero-native inference.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
function plain(file){const s=fs.lstatSync(file);if(!s.isFile()||fs.realpathSync(file)!==path.resolve(file))throw Error('original dispatch outcome evidence is redirected');return fs.readFileSync(file);}
export function originalDispatchOutcome({repo,org,common,item,brief,journal,events=[]}){
  const directory=path.join(org,'dispatch');
  const candidates=journal?[journal]:fs.existsSync(directory)?fs.readdirSync(directory).filter(n=>n.endsWith('.json')&&!n.endsWith('.routes.json')).map(n=>path.join(directory,n)):[];
  const found=[];
  for(const file of candidates){
    if(path.dirname(path.resolve(file))!==directory)throw Error('original dispatch journal is outside its owning record');
    const bytes=plain(file);let job;try{job=JSON.parse(bytes);}catch{if(journal)throw Error('original dispatch journal is unreadable');continue;}
    if(!journal&&(job.item!==item||job.brief!==brief))continue;
    if(job.item!==item||job.brief!==brief||job.repo!==repo||job.org!==org||job.common!==common||path.basename(file)!==`${job.token}.json`)throw Error('original dispatch request binding differs; retain its owner');
    found.push({file,bytes,job});
  }
  if(found.length!==1)return{status:'unknown',reason:found.length?'multiple original request matches; no replacement':'original request outcome unavailable; no replacement',native_launch_attempted:null,run:null};
  const {file,bytes,job}=found[0],starts=events.filter(e=>e.type==='run.started'&&e.item===item&&e.meta?.dispatch_journal===file&&e.meta?.dispatch_attempt===job.token&&e.meta?.dispatch_project===common);
  if(starts.length>1||job.run&&(!starts.length||starts[0].id!==job.run||starts[0].workspace!==job.workspace))throw Error('original dispatch record attribution is ambiguous/different; retain owner');
  const run=starts[0]?.id??null;
  return{status:job.stage==='complete'&&run&&job.worker?'dispatch-complete':run?'recorded-run':'retained',journal:file,request_sha256:hash(bytes),stage:job.stage,run,
    native_launch_attempted:typeof job.native_launch_attempted==='boolean'?job.native_launch_attempted:null,error:job.error??null,
    qualification:'Original durable request/record readback only; not a fresh native launch, session or delivery observation.'};
}
