import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {brainOwner} from '../lib/run-owner.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {beginHoldCloseout,finishHoldCloseout,evidenceHash} from '../line-service/hold-evidence.mjs';
import {recordCloseoutTurn,readCloseoutMeasurement} from '../line-service/closeout-measurement.mjs';
import {appendPassJournal,rotatePassJournal} from '../line-service/pass-journal.mjs';
import {evaluateHoldCloseout,measureHoldCloseouts} from '../measurement/hold-closeout.mjs';
import {evaluateWitness} from '../measurement/live-witnesses.mjs';

function fixture(t){
  const f=setup(t,{direct:true,bound:true,merged:true}),binding=selectCurrentCleanup(f),project=gitProject(f.repo);
  f.append([{type:'run.claimed',run:'R-1',project:f.common,record:f.org,owner:brainOwner()}]);
  f.report();
  const hold=path.join(f.repo,'.lane/supervisor/HOLD');fs.mkdirSync(path.dirname(hold),{recursive:true});fs.writeFileSync(hold,'Written scratch HOLD for closeout proof\n');
  const options={project,org:f.org,env:f.env},holdSha256=evidenceHash(fs.readFileSync(hold));
  const measure=context=>recordCloseoutTurn({...context,source:{commit:f.head,module_sha256:'c'.repeat(64)},historical:[],
    collect:()=>({coverage:{native:true,git:true,process:true},errors:[],agents:[],panes:[],folders:[],worktrees:[],branches:[],processes:[]})});
  const args={...options,guard:()=>{},reconcileReports:false,maxSteps:1,measure,cli:(file,argv)=>{
    if(argv[0]==='refresh')return '{}';
    assert.equal(argv[0],'drain','HOLD suppresses allocations and decision work');
    return JSON.stringify(f.drain({keys:JSON.parse(argv[argv.indexOf('--keys')+1]),retrySafe:true}));
  }};
  const evaluate=proof=>evaluateHoldCloseout({proof,events:events(f),project:f.common,org:f.org,run:'R-1',holdSha256});
  return{...f,...binding,project,options,args,hold,holdSha256,evaluate};
}

test('actual guarded turn joins written HOLD and original session/folder effects through census and rotated journal',async t=>{
  const f=fixture(t),result=runCloseoutTurn(f.args),proof=result.hold_closeout;
  assert.deepEqual(result.errors,[]);assert.equal(fs.existsSync(f.lane),false);
  const verdict=f.evaluate(proof);assert.equal(verdict.status,'MET',JSON.stringify({verdict,proof,events:events(f)}));
  assert.ok(proof.subjects[0].evaluations[0].seq,'journal names the committed evaluation');
  const doc=readCloseoutMeasurement(path.join(f.directory,'closeout-measurement.json'));
  assert.deepEqual(doc.hold_closeout,proof);assert.equal(doc.hold_closeout_results[0].status,'MET');
  const file=path.join(f.directory,'passes.jsonl'),from=new Date(Date.parse(proof.before.at)-1000).toISOString(),cutoff=new Date(Date.parse(proof.after.at)+1000).toISOString();
  rotatePassJournal(file,{maxBytes:1});
  const measured=measureHoldCloseouts({file,events:events(f),project:f.common,org:f.org,run:'R-1',holdSha256:f.holdSha256,from,cutoff});
  assert.equal(measured.observations[0].status,'MET');
  const spec={schema:'brain.live-witness/v1',id:'held-turn',kind:'hold-closeout',project:f.common,org:f.org,owner:'original-owner',next:'consume on owning item',from,cutoff,run:'R-1',hold_sha256:f.holdSha256};
  assert.equal((await evaluateWitness({spec,events:events(f),project:f.common,passes:file,now:cutoff})).status,'MET');
  for(const mutate of [p=>{p.project='foreign';},p=>{p.org='foreign';},p=>{p.before.record.sha256='changed';},
    p=>{p.after.hold.ino='replaced';},p=>{p.subjects[0].source.seq++;},p=>{p.subjects[0].evaluations[0].seq++;},
    p=>{p.after.main.log.ino='rewritten';},p=>{p.after.main.ref.ctimeNs='unlogged change';}]){
    const changed=structuredClone(proof);mutate(changed);assert.equal(f.evaluate(changed).status,'UNRUN');
  }
  // An old session effect must not be combined with this turn's folder effect.
  const old=structuredClone(proof),session=events(f).find(e=>e.type==='closeout.effect'&&e.outcome.action==='closed');
  old.before.record={seq:session.seq,sha256:evidenceHash(JSON.stringify(events(f).slice(0,session.seq)))};
  old.after.record.prefix_sha256=old.before.record.sha256;
  assert.equal(f.evaluate(old).status,'UNRUN');
});

test('reflog exposes main move-and-restore; absent or rewritten history never becomes stationary proof',t=>{
  const f=fixture(t),before=beginHoldCloseout(f.options),tip=f.git(['rev-parse','main']),parent=f.git(['rev-parse','main^']);
  f.git(['update-ref','refs/heads/main',parent,tip]);f.git(['update-ref','refs/heads/main',tip,parent]);
  const proof=finishHoldCloseout(f.options,before,{turn:1,completed:true});
  assert.equal(proof.before.main.head,proof.after.main.head);assert.match(f.evaluate(proof).reason,/restored/);assert.equal(f.evaluate(proof).status,'NOT MET');
  const missing=structuredClone(proof);delete missing.after.main;assert.equal(f.evaluate(missing).status,'UNRUN');
  const truncated=structuredClone(proof);truncated.after.main.prefix_sha256='changed';assert.equal(f.evaluate(truncated).status,'UNRUN');
  const original=fs.readFileSync(path.join(f.common,'logs/refs/heads/main'));
  fs.unlinkSync(path.join(f.common,'logs/refs/heads/main'));
  const absent=finishHoldCloseout(f.options,beginHoldCloseout(f.options),{turn:2,completed:true});assert.equal(f.evaluate(absent).status,'UNRUN');
  fs.writeFileSync(path.join(f.common,'logs/refs/heads/main'),original);
});

test('a recorded project start or landing fails even with stationary main; later proof cannot overwrite the first turn',async t=>{
  const f=fixture(t),before=beginHoldCloseout(f.options);
  f.append([{type:'run.started',id:'R-2',item:'ENG-1',meta:{dispatch_project:f.common}}]);
  const failed=finishHoldCloseout(f.options,before,{turn:1,completed:true,subjects:[{run:'R-1'}]});
  assert.equal(f.evaluate(failed).status,'NOT MET');
  // Failure and a fresh successful turn survive as separate durable rows.
  const file=path.join(f.directory,'passes.jsonl');appendPassJournal(file,{at:failed.after.at,action:'closeout-measurement',hold_closeout:failed});
  const good=runCloseoutTurn(f.args).hold_closeout;assert.equal(f.evaluate(good).status,'MET');
  const from=new Date(Date.parse(before.at)-1000).toISOString(),cutoff=new Date(Date.parse(good.after.at)+1000).toISOString(),
    spec={schema:'brain.live-witness/v1',id:'first-turn',kind:'hold-closeout',project:f.common,org:f.org,owner:'owner',next:'consume',from,cutoff,run:'R-1',hold_sha256:f.holdSha256};
  const evaluate=s=>evaluateWitness({spec:s,events:events(f),project:f.common,passes:file,now:cutoff});
  assert.equal((await evaluate(spec)).status,'NOT MET');
  assert.equal((await evaluate({...spec,id:'fresh-observation',from:good.before.at})).status,'MET');
  const again=beginHoldCloseout(f.options);f.append([{type:'change.landed',item:'ENG-1',run:'R-1',project:f.common,head:f.head}]);
  assert.equal(f.evaluate(finishHoldCloseout(f.options,again,{turn:3,completed:true})).status,'NOT MET');
});

test('missing HOLD, changed marker, malformed record and unknown historical proof remain UNRUN',t=>{
  const f=fixture(t);assert.equal(f.evaluate(null).status,'UNRUN');
  const before=beginHoldCloseout(f.options);fs.writeFileSync(f.hold,'changed');
  assert.equal(f.evaluate(finishHoldCloseout(f.options,before,{turn:1,completed:true})).status,'UNRUN');
  fs.unlinkSync(f.hold);const absent=beginHoldCloseout(f.options);
  assert.equal(f.evaluate(finishHoldCloseout(f.options,absent,{turn:2,completed:true})).status,'UNRUN');
  const bytes=fs.readFileSync(f.eventFile);fs.appendFileSync(f.eventFile,'{"type":');
  assert.ok(beginHoldCloseout(f.options).errors.some(e=>/record/.test(e)));assert.equal(fs.readFileSync(f.eventFile).length,bytes.length+8);
});
