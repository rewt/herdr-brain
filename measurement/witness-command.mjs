import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gitProject} from '../lib/project.mjs';
import {findOrgDir,UserError} from '../lib/store.mjs';
import {checkFleetRecord} from '../lib/fleet.mjs';
import {measureLinePasses} from './line-passes.mjs';
import {evaluateWitness,pendingWitnesses,resultMutation} from './live-witnesses.mjs';
import {createHash} from 'node:crypto';

// Called by the existing finite line turn or directly through record. Only
// existing note mutations escape this module; it never changes journal bytes.
export async function witnessCommand(argv,{openOrg,mutate,out}){
  const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{item:{type:'string',multiple:true},'dry-run':{type:'boolean'}}});
  if(positionals.length!==1||positionals[0]!=='evaluate')throw new UserError('usage: record witness evaluate [--item ID ...] [--dry-run]');
  const ctx=openOrg(),project=gitProject(),bound=checkFleetRecord(ctx.dir);
  const discovered=bound?.record??findOrgDir({cwd:project.canonical,env:{...process.env,ORG_DIR:''}});
  if(!discovered||fs.realpathSync(discovered)!==fs.realpathSync(ctx.dir)||bound&&(bound.identity!==project.identity||bound.checkout!==project.canonical))throw new UserError('witness record does not belong to the current project');
  if(ctx.tornTail)throw new UserError('incomplete record tail; no witness result written');
  const directory=path.join(ctx.dir,'line-service',createHash('sha256').update(JSON.stringify(project.identity)).digest('hex').slice(0,20));
  const halt=()=>{
    if([path.join(directory,'STOP'),...['STOP','HOLD'].map(name=>path.join(project.canonical,'.lane/supervisor',name))].some(file=>fs.existsSync(file)))throw new UserError('STOP/HOLD prevents witness result writes');
  };
  if(!values['dry-run'])halt();
  const items=values.item?.map(id=>{const item=ctx.state.items.get(id);if(!item)throw new UserError(`unknown witness item ${id}`);return item;})??[...ctx.state.items.values()];
  const results=[],cache=new Map(),now=ctx.now.toISOString();
  const readPasses=options=>{const key=JSON.stringify(options);if(!cache.has(key))cache.set(key,measureLinePasses(options));return cache.get(key);};
  for(const item of items)for(const {spec,note} of pendingWitnesses(item)){
    let result;
    try{
      if(spec.kind==='hold-closeout'&&spec.org!==ctx.dir)throw Error('HOLD witness record binding differs from the owning record');
      result=await evaluateWitness({spec,events:ctx.events,project:project.identity,passes:path.join(directory,'passes.jsonl'),now,readPasses});
    }
    catch(error){
      // A failed reader is unknown, never an empty successful window. Preserve
      // the failure as evidence and allow the next existing finite pass to read.
      const {witnessHash}=await import('./live-witnesses.mjs');
      result={schema:'brain.live-witness-result/v1',id:spec.id,spec_sha256:witnessHash(spec),kind:spec.kind,project:project.identity,
        owner:spec.owner,next:spec.next,status:'UNRUN',reason:`evidence unavailable: ${error.message}`,terminal:false,recorded_at:now,condition_at:null,delay_ms:null,evidence:{spec_note:note.seq}};
    }
    if(values['dry-run'])results.push({item:item.id,recorded:false,result});
    else{
      halt();
      const written=mutate(ctx,state=>{halt();return resultMutation({state,item:item.id,specNote:note.seq,result});});
      results.push({item:item.id,...written.result});
    }
  }
  out(JSON.stringify({schema:'brain.live-witness-evaluation/v1',results})+'\n');
  return 0;
}
