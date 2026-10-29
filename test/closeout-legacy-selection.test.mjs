import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';

for(const kind of ['legacy-binding','unknown-git'])test(`finite selection retains ${kind} without spending an effect step on an empty drain`,t=>{
  const f=setup(t,{bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  if(kind==='legacy-binding'){
    const original=events(f);original.find(e=>e.seq===entry.source.seq).closeout_targets[0].schema='closeout-entry/v1';
    fs.writeFileSync(f.eventFile,original.map(e=>JSON.stringify(e)+'\n').join(''));
    const file=path.join(f.common,'closeout/entries',entry.key+'.json'),saved=JSON.parse(fs.readFileSync(file));
    saved.schema='closeout-entry/v1';fs.writeFileSync(file,JSON.stringify(saved)+'\n');
  }else f.append([{type:'closeout.effect',identity:f.common,key:entry.key,source:entry.source,effect:'original-git',
    outcome:{action:'git-removal-started',attempt:'original',operation:'worktree',cwd:entry.cwd,branch:entry.branch,tip:entry.head}}]);
  f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,run:entry.run,item:entry.item,
    revision:entry.source.seq,completed:false,reason:'retirement deadline reached; request remains pending'}]);
  let drains=0;
  const result=runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:1,
    cli:(_file,args)=>{if(args[0]==='drain')drains++;return '{}';}});
  assert.equal(result.steps,0);assert.equal(drains,0);assert.deepEqual(result.errors,[]);
  assert.deepEqual(f.read().actions,[]);assert.equal(fs.existsSync(f.lane),true);
});
