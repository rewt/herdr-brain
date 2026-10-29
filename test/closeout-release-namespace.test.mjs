import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {copyProduct} from '../lib/product-files.mjs';
import {initOrg} from '../lib/store.mjs';
import {setup,events} from './helpers/closeout-fixture.mjs';

for(const kind of ['report','abandoned','foreign-record','foreign-project','arbitrary-cwd'])
test(`release namespace ${kind} uses only the original project and recorded session binding`,t=>{
  const f=setup(t,{direct:true,bound:true}),bundle=path.join(f.scratch,'release'),plain=path.join(f.scratch,'non-project');
  copyProduct(process.cwd(),bundle);fs.writeFileSync(path.join(bundle,'.release-commit'),'1'.repeat(40)+'\n');fs.mkdirSync(plain);
  // The saved worker launch SID is null, as in the sanitized BCH journal.
  // The independent original session-bind fact is the authoritative projection.
  const journal=path.join(f.org,'dispatch/attempt.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  fs.writeFileSync(journal,JSON.stringify({worker:{agentSessionId:null},sessionBinding:{status:'bound'}}));
  let org=f.org;
  if(kind==='foreign-record'){org=path.join(f.scratch,'foreign-record');initOrg(org);}
  if(kind==='foreign-project'){
    const rows=events(f);for(const e of rows)if(e.meta?.dispatch_project)e.meta.dispatch_project=path.join(f.scratch,'foreign.git');
    fs.writeFileSync(f.eventFile,rows.map(e=>JSON.stringify(e)+'\n').join(''));
  }
  const add=kind==='abandoned'?{type:'run.abandoned',id:'R-1'}:{type:'report.ingested',run:'R-1',sha256:'fixture',report:{outcome:'done'}};
  const script=`import {bindCloseoutSources,publishCloseoutEvents} from ${JSON.stringify(pathToFileURL(path.join(bundle,'lib/closeout.mjs')).href)};
import {loadEvents,transact} from ${JSON.stringify(pathToFileURL(path.join(bundle,'lib/store.mjs')).href)};
const org=${JSON.stringify(org)},original=loadEvents(${JSON.stringify(f.org)}).events;
const mutation=bindCloseoutSources({org,events:original,mutation:{add:[${JSON.stringify(add)}]}});
let published=[];
if(mutation.add[0].closeout_targets?.length){
 const result=transact(org,()=>mutation);published=publishCloseoutEvents({org,added:result.added,start:false});
}
console.log(JSON.stringify({source:mutation.add[0],published}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    cwd:kind==='arbitrary-cwd'?plain:bundle,env:{...f.env,ORG_DIR:org},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr+result.stdout);const {source,published}=JSON.parse(result.stdout);
  if(['report','abandoned'].includes(kind)){
    assert.equal(source.closeout_binding_errors,undefined,JSON.stringify(source));
    assert.equal(source.closeout_targets[0].common,f.common);assert.equal(source.closeout_targets[0].project,f.repo);
    assert.equal(source.closeout_targets[0].panes[0].session,'session');
    assert.equal(published[0].panes[0].session,'session');
  }else{
    assert.equal(source.closeout_targets,undefined);assert.equal(source.closeout_binding_errors[0].code,'NO_PROJECT_ALLOCATION');
    assert.deepEqual(published,[]);
  }
  assert.deepEqual(f.read().actions,[]);assert.equal(JSON.parse(fs.readFileSync(journal)).worker.agentSessionId,null);
});
