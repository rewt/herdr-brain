import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './dispatch-fixture.mjs';

test('phase1 dispatch memory admission pauses only for proving and does not wait on low-memory ordering',t=>{
  const f=fixture(t),memory=path.join(f.root,'memory.json');fs.writeFileSync(memory,JSON.stringify({available:0,swap_used:1024**3}));f.fail('prepare');
  const result=f.start([],{env:{...f.env,TEST_MEMORY_FILE:memory}});assert.equal(result.status,1);assert.match(result.stderr,/injected prepare/);assert.doesNotMatch(result.stderr,/waiting; memory pressure/);
  assert.ok(f.calls().some(c=>c.type==='lane'&&c.a[0]==='open'));
});

test('phase1 detached start saves the original journal receipt before returning and does not replay on retry',t=>{
  const f=fixture(t);f.fail('prepare');
  const result=f.start(['--detach']);assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.result,'detached');assert.ok(receipt.journal);const saved=JSON.parse(fs.readFileSync(receipt.journal));assert.equal(saved.item,f.item);assert.equal(saved.detached,true);
  // The saved job owns recovery. The request is not submitted again by the line.
  assert.equal(fs.existsSync(receipt.journal),true);assert.equal(f.jobs().length,1);
});
