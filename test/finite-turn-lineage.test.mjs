import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {brainOwner} from '../lib/run-owner.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';

test('normal finite closer joins actual report allocation item close and original session/folder effects without HOLD',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);
  f.append([{type:'run.claimed',run:'R-1',project:f.common,record:f.org,owner:brainOwner()}]);
  f.report();f.append([{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]);
  const result=runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},reconcileReports:false,maxSteps:1,measure:()=>{},
    cli:(file,args)=>args[0]==='refresh'?'{}':JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true}))});
  assert.deepEqual(result.errors,[]);assert.equal(fs.existsSync(f.lane),false);
  const proof=result.hold_closeout,subject=proof.subjects.find(s=>s.run==='R-1'),lineage=subject.lineage,all=events(f);
  assert.ok(proof.id);assert.equal(proof.completed,true);
  assert.equal(proof.before.hold,undefined,'normal turns retain joins without a written HOLD');
  const report=all.find(e=>e.seq===subject.source.seq),target=report.closeout_targets.find(t=>t.key===subject.key);
  assert.deepEqual(lineage.allocation,target.allocation);assert.equal(lineage.report.seq,report.seq);
  assert.equal(lineage.report.sha256,report.sha256);
  assert.equal(lineage.item_close.seq,all.find(e=>e.type==='item.closed').seq);
  assert.equal(lineage.item_close_in_turn,false,'source completion preceding physical closeout is not relabelled same-turn');
  const joined=lineage.evaluations.find(e=>e.session_effects.length&&e.folder_effects.length);
  assert.ok(joined,JSON.stringify(proof));assert.ok(joined.report_effects.length);
  for(const ref of [joined.evaluation,...joined.session_effects,...joined.folder_effects,...joined.report_effects]){
    const original=all.find(e=>e.seq===ref.seq);
    assert.equal(original.type,ref.type);assert.ok(ref.seq>proof.before.record.seq&&ref.seq<=proof.after.record.seq);
    assert.equal(original.key,subject.key);assert.deepEqual(original.source,subject.source);
    if(ref.effect)assert.equal(original.effect,ref.effect);
  }
  assert.ok(joined.session_effects.some(r=>all.find(e=>e.seq===r.seq).outcome.action==='closed'));
  assert.ok(joined.folder_effects.some(r=>all.find(e=>e.seq===r.seq).outcome.action==='worktree-removed'));
  t.diagnostic(JSON.stringify({rehearsal:'normal runCloseoutTurn through guarded drainCloseout',proof}));
});
