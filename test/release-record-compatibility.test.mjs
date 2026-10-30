import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';
import {runRelease} from '../lib/releases.mjs';
import {transact} from '../lib/store.mjs';

test('release admission refuses the historical stale acceptance fold before executing a command',t=>{
  const f=configFixture(t,{custom:true});
  const events=[{type:'item.added',id:'ENG-1',accept:['Original'],seq:1},
    {type:'item.acceptance-amended',id:'ENG-1',accept:['Current'],seq:2}];
  assert.equal(requireRecordCompatibility(f.bundle,events).through,2);
  const historical=spawnSync('git',['show','a96eaa9c47:lib/state.mjs'],{encoding:'utf8'});
  assert.equal(historical.status,0,historical.stderr);
  fs.writeFileSync(path.join(f.bundle,'lib/state.mjs'),historical.stdout);
  assert.throws(()=>requireRecordCompatibility(f.bundle,events),/record-incompatible:.*item.acceptance-amended/);
  // This is a synthetic, newly sealed fixture; no installed bundle is edited.
  const manifest=spawnSync(process.execPath,[path.resolve('herdr/releases.mjs'),'manifest',f.bundle,path.join(f.bundle,'.release-acceptance.json')],{env:f.env,encoding:'utf8'});
  assert.equal(manifest.status,0,manifest.stderr);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');
  f.git('add','.herdr-release.json');f.git('commit','-qm','Select historical fold fixture');
  transact(f.env.ORG_DIR,()=>({add:events.map(({seq,...event})=>event)}));
  assert.throws(()=>runRelease('bin/org.mjs',['show','ENG-1'],{cwd:f.cwd,home:f.installationHome}),/record-incompatible:.*item.acceptance-amended/);
});

test('unrecognized core events and fold layouts refuse while opaque subsystem receipts remain readable',t=>{
  const f=configFixture(t,{custom:true});
  assert.throws(()=>requireRecordCompatibility(f.bundle,[{type:'item.future-contract',seq:3}]),/record-incompatible/);
  assert.deepEqual(requireRecordCompatibility(f.bundle,[{type:'line-service.runtime-upgraded',seq:4}]).required_types,[]);
  fs.writeFileSync(path.join(f.bundle,'lib/state.mjs'),'export const fold = () => ({});\n');
  assert.throws(()=>requireRecordCompatibility(f.bundle,[]),/unknown fold contract/);
});

test('session hook selects installed resolvers ahead of a development canary',t=>{
  const f=configFixture(t,{custom:true}),installed=path.join(f.home,'.local/bin'),canary=path.join(f.home,'.local/share/herdr-monitor/canary/bin');
  fs.mkdirSync(installed,{recursive:true});fs.mkdirSync(canary,{recursive:true});
  for(const [dir,label] of [[installed,'installed'],[canary,'development']])
    fs.writeFileSync(path.join(dir,'record'),`#!/bin/sh\nprintf '${label}\\n'\n`,{mode:0o755});
  const file=path.join(f.scratch,'session-env');
  const hook=spawnSync('/bin/sh',[path.resolve('herdr/canary-env.sh')],{env:{...f.env,CLAUDE_ENV_FILE:file},encoding:'utf8'});
  assert.equal(hook.status,0,hook.stderr);
  const result=spawnSync('/bin/sh',['-c','. "$1"; record','session',file],{env:{...f.env,PATH:canary+':/usr/bin:/bin'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'installed');
});
