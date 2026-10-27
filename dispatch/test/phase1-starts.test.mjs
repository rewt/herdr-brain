import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './dispatch-fixture.mjs';

async function driverResult(journal){
  const file=`${journal}.driver/results.jsonl`,until=Date.now()+60000;
  while(!fs.existsSync(file)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(fs.existsSync(file),true,'owned detached fixture reaches a durable terminal receipt');
  return JSON.parse(fs.readFileSync(file,'utf8').trim());
}

test('phase1 detached native start keeps one original prompt and its record-only watcher while a fresh STOP prevents input',async t=>{
  for(const stopped of [false,true]){
    const f=fixture(t);
    if(stopped){const file=path.join(f.root,'bin/watch');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace("} else if(type==='watch') {", "} else if(type==='watch') {\n fs.mkdirSync(path.join(process.cwd(),'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(process.cwd(),'.lane/supervisor/STOP'),'fixture STOP after launch, before prompt');"));}
    const started=f.start(['--detach']);assert.equal(started.status,0,started.stderr);const receipt=JSON.parse(started.stdout),result=await driverResult(receipt.journal);
    const prompts=f.calls().filter(c=>c.type==='herdr'&&c.a[0]==='agent'&&c.a[1]==='prompt');
    assert.equal(prompts.length,stopped?0:1);
    if(stopped)assert.match(result.error,/STOP/);else{assert.equal(result.exit_code,0,JSON.stringify(result));assert.equal(result.stage,'complete');}
    assert.ok(f.calls().find(c=>c.type==='watch').a.includes('--record-only'));
  }
});

test('phase1 dispatch memory admission pauses only for proving and does not wait on low-memory ordering',t=>{
  const f=fixture(t),memory=path.join(f.root,'memory.json');fs.writeFileSync(memory,JSON.stringify({available:0,swap_used:1024**3}));f.fail('prepare');
  const result=f.start([],{env:{...f.env,TEST_MEMORY_FILE:memory}});assert.equal(result.status,1);assert.match(result.stderr,/injected prepare/);assert.doesNotMatch(result.stderr,/waiting; memory pressure/);
  assert.ok(f.calls().some(c=>c.type==='lane'&&c.a[0]==='open'));
});

test('phase1 detached start saves the original journal receipt before returning and does not replay on retry',async t=>{
  const f=fixture(t);f.fail('prepare');
  const result=f.start(['--detach']);assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.result,'detached');assert.ok(receipt.journal);const saved=JSON.parse(fs.readFileSync(receipt.journal));assert.equal(saved.item,f.item);assert.equal(saved.detached,true);
  // The saved job owns recovery. The request is not submitted again by the line.
  assert.equal(fs.existsSync(receipt.journal),true);assert.equal(f.jobs().length,1);
  const resultFile=`${receipt.journal}.driver/results.jsonl`,until=Date.now()+20000;
  while(!fs.existsSync(resultFile)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(fs.existsSync(resultFile),true,'owned detached fixture writes its terminal receipt before cleanup');
  const finished=JSON.parse(fs.readFileSync(resultFile,'utf8').trim());assert.equal(finished.exit_code,1);assert.equal(finished.native_launch_attempted,false);
});
