// A validation hint from the existing report watcher, not completion authority.
import fs from './record-observation.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {findOrgDir,planTransaction,writer} from './store.mjs';
import {readReport} from './report.mjs';
import {readOwnedRun,requireController} from './run-owner-guard.mjs';
import {protectRecordMutation} from './record-guard.mjs';
import {gitProject} from './project.mjs';
import {kickCloseout} from './closeout.mjs';
export function reportAvailableCommand(argv){
  const {values:v,positionals}=parseArgs({args:argv,allowPositionals:true,options:{run:{type:'string'},sha256:{type:'string'}}});
  if(positionals.length||!/^R-\d+$/.test(v.run??'')||!/^[a-f0-9]{64}$/.test(v.sha256??''))throw Error('report-available requires --run R-n --sha256 HASH');
  const org=fs.realpathSync(findOrgDir()),who=writer();let project;
  const result=planTransaction(org,(events,state)=>{
    const run=readOwnedRun(org,v.run,events);requireController(run,'brain');
    if(run.report||run.abandoned)return{add:[]};
    if(state.items.get(run.item)?.runs.at(-1)!==run.id)throw Error('availability current run changed');
    const file=path.resolve(run.report_path),s=fs.lstatSync(file);
    if(!s.isFile()||fs.realpathSync(file)!==file)throw Error('availability report is redirected');
    const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex'),parsed=readReport(bytes.toString());
    if(hash!==v.sha256||parsed.errors.length||parsed.report.run!==run.id)throw Error('availability report bytes or identity changed');
    project=gitProject(run.workspace);
    if(run.meta.dispatch_project!==project.identity||run.meta.dispatch_record!==org)throw Error('availability original project binding changed');
    const event={type:'report.available',run:run.id,item:run.item,sha256:hash,file,project:project.identity,
      started_seq:run.started.seq,claim_generation:run.owner_generation,observed_at:new Date().toISOString(),producer:'original-report-watcher'};
    return protectRecordMutation({org,events,state,command:'report-available',mutation:{add:
      events.some(e=>e.type===event.type&&e.run===run.id&&e.sha256===hash&&e.claim_generation===run.owner_generation)?[]:[event]}});
  },{actor:who.actor,unattributed:who.unattributed,replaySafe:true});
  // Source durability precedes every wake and acknowledgement. A failed wake
  // is repaired by the service's finite startup/periodic reconciliation.
  if(project)try{kickCloseout(project,org);}catch(error){process.stderr.write(`report wake retained: ${error.message}\n`);}
  process.stdout.write(JSON.stringify({recorded:result.added.length>0})+'\n');return 0;
}
