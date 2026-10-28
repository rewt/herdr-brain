import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,isolatedEnv} from './helpers/retire-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {bindCloseoutSources,currentCloseoutEntries} from '../lib/closeout.mjs';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';

test('failed UNKNOWN cleanup stays individually owned and independent READY admission precedes the batch',t=>{
  const f=fixture(t,{occupied:false});isolatedEnv(t,f);
  fs.symlinkSync(f.org,path.join(f.repo,'.org'));
  fs.appendFileSync(path.join(f.common,'info/exclude'),'\n.org\n.lane/\n');
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({retirement:{closeout_queue:true},routes:{engineer:{kind:'codex'}},dispatch:{max_sessions:2}}));
  fs.writeFileSync(f.eventFile,loadEvents(f.org).events.filter(e=>!['item.closed','report.ingested'].includes(e.type)).map(e=>JSON.stringify(e)+'\n').join(''));
  transact(f.org,events=>bindCloseoutSources({cwd:f.repo,org:f.org,events,env:f.env,mutation:{add:[
    {type:'line-service.cutover',id:'boundary',project:f.common,repo:f.repo,org:f.org,source:sourceRoot,main:'main',canonical_head:f.head},
    {type:'line-service.phase0',id:'boundary',project:f.common,repo:f.repo,org:f.org,source:sourceRoot,main:'main',canonical_head:f.head},
    {type:'report.ingested',run:'R-1',sha256:'fixture',report:{outcome:'blocked',summary:'Stopped work'}},
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Independent ready work'},
  ]}}));
  const [target]=currentCloseoutEntries(f.common,f.org,loadEvents(f.org).events);assert.ok(target);
  const calls=[];let clock=0;
  const service=createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,haltAfter:100,workClock:()=>clock,passBudgetMs:10,
    capacity:()=>({cap:2,count:0}),recordNotice:()=>({state:'recorded'}),command:(_exe,args)=>{
      calls.push(args);
      if(args[0].endsWith('dispatch/dispatch.mjs'))return{status:0,stdout:'{"run":"R-2"}'};
      assert.ok(args[0].endsWith('supervisor/closeout.mjs'),args.join(' '));
      assert.ok(calls.some(a=>a[0].endsWith('dispatch/dispatch.mjs')),'admission must run before cleanup can block');
      assert.ok(args.includes('--parallel'));assert.deepEqual(JSON.parse(args[args.indexOf('--keys')+1]),[target.key]);
      clock=100;
      return{status:0,stdout:JSON.stringify({evaluated:[{key:target.key,run:'R-1',completed:false,reason:'original native outcome UNKNOWN',failure:{kind:'unknown'}}]})};
    }});
  service.pass();service.pass();
  assert.equal(calls.filter(a=>a[0].endsWith('dispatch/dispatch.mjs')).length,1);
  assert.equal(calls.filter(a=>a[0].endsWith('supervisor/closeout.mjs')).length,1,'original UNKNOWN command is not replaced or replayed');
  const actions=JSON.parse(fs.readFileSync(path.join(service.directory,'effects.json'))).actions;
  const cleanup=Object.values(actions).find(a=>a.subject.startsWith('closeout:'));
  assert.equal(cleanup.state,'held');assert.equal(cleanup.result.evaluated[0].key,target.key);
  assert.ok(fs.existsSync(f.lane));assert.equal(f.read().actions.length,0);
});
