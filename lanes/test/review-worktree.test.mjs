import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {renameSync,writeFileSync} from 'node:fs';
import {makeFixture,ignoreLaneState,openLane,writeFakeHerdr,lane,git} from './lane-fixture.mjs';

function setup(t,topic='review-own'){
  const f=makeFixture({main:'main',validate:'true',routes:{'review-codex':{kind:'codex',model:'fixture'}}});t.after(()=>f.cleanup());ignoreLaneState(f);
  const path=openLane(f,topic),head=git(path,['rev-parse','HEAD']);const fake=writeFakeHerdr(f,{lanePath:path,branch:`lane/${topic}`});
  f.env.FAKE_HERDR_CHAT_PARENT='1';f.env.FAKE_HERDR_NULL_SOURCE='1';f.env.FAKE_HERDR_NULL_OPEN_ID='1';
  const dispatch=()=>lane(f,['dispatch',topic,'--route','review-codex','--expected-head',head,'--json']);
  return {f,path,head,fake,dispatch};
}

test('review worktree opens its own captured source with null chat anchor and unopened workspace metadata',t=>{
  const {f,path,fake,dispatch}=setup(t);const result=dispatch();assert.equal(result.status,0,result.stderr);const worker=JSON.parse(result.stdout);
  assert.equal(worker.cwd,path);assert.equal(worker.workspaceId,'w-lane');assert.notEqual(worker.workspaceId,'w3PD');
  const calls=fake.calls(),open=calls.find(a=>a[0]==='worktree'&&a[1]==='open');
  assert.equal(open[open.indexOf('--cwd')+1],f.repo);assert.equal(open[open.indexOf('--path')+1],path);assert.equal(open.includes('--workspace'),false);
  const tab=calls.find(a=>a[0]==='tab'&&a[1]==='create');assert.equal(tab[tab.indexOf('--cwd')+1],path);
  assert.equal(calls.filter(a=>a[0]==='agent'&&a[1]==='start').length,1);assert.equal(calls.some(a=>a[1]==='prompt'),false);
});

test('review worktree refuses captured HEAD drift before a native launch',t=>{
  const {path,fake,dispatch}=setup(t,'review-head');writeFileSync(join(path,'changed'),'new source');git(path,['add','changed']);git(path,['commit','-qm','Changed after capture']);
  const result=dispatch();assert.equal(result.status,1);assert.match(result.stderr,/captured HEAD changed/);assert.equal(fake.calls().some(a=>a[0]==='agent'&&a[1]==='start'),false);
});

test('review worktree refuses a foreign repository replacing the registered path even at a matching label',t=>{
  const {f,path,fake,dispatch}=setup(t,'review-foreign');renameSync(path,path+'-retained');git(f.repo,['init','-q','-b','main',path]);
  const result=dispatch();assert.equal(result.status,1);assert.match(result.stderr,/does not belong to canonical git common directory/);assert.equal(fake.calls().some(a=>a[0]==='tab'&&a[1]==='create'),false);
});

test('review worktree never accepts the canonical chat pane as its target workspace',t=>{
  const {f,fake,dispatch}=setup(t,'review-chat');f.env.FAKE_HERDR_TARGET_CHAT='1';
  const result=dispatch();assert.equal(result.status,1);assert.match(result.stderr,/workspace w3PD.*identity mismatch/);assert.equal(fake.calls().some(a=>a[0]==='tab'&&a[1]==='create'),false);
});

test('review worktree retains explicit foreign and stale native target binding refusal with nullable source metadata',t=>{
  const {f,path,dispatch}=setup(t,'review-stale');const fake=writeFakeHerdr(f,{lanePath:path,branch:'lane/review-stale',staleId:'w-stale',foreignRepoKey:join(f.root,'foreign.git'),noRepair:true});
  f.env.FAKE_HERDR_CHAT_PARENT='1';f.env.FAKE_HERDR_NULL_SOURCE='1';f.env.FAKE_HERDR_NULL_OPEN_ID='1';
  const result=dispatch();assert.equal(result.status,1);assert.match(result.stderr,/workspace w-stale.*identity mismatch/);assert.equal(fake.calls().some(a=>a[0]==='agent'&&a[1]==='start'),false);
});
