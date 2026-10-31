import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {rotatePassJournal} from '../line-service/pass-journal.mjs';
import {measureLinePasses} from '../measurement/line-passes.mjs';

test('streamed measurement separates interleaved owners and keeps historical unknown counts explicit',async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pass-measure-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'passes.jsonl'),from='2026-10-30T23:30:00Z',cutoff='2026-10-31T00:30:00Z';
  fs.writeFileSync(file,[{action:'pass-start',pid:1},{action:'pass-start',pid:2},{action:'hold',pid:1},{action:'queue-order',pid:2,candidates:[{item:'ENG-1'},{item:'ENG-2'}]},{action:'admission-eligible',pid:2},
    {action:'hold'},{action:'pass-complete',pid:2,timing:{duration_ms:2000}},{action:'pass-complete',pid:1,timing:{duration_ms:3000}},
    {action:'pass-complete',timing:{duration_ms:4000}}].map(row=>JSON.stringify({at:from,...row})).join('\n')+'\n');
  const result=await measureLinePasses({file,from,cutoff});assert.deepEqual(result.totals,{hold:2,'admission-eligible':1});
  assert.deepEqual(result.unattributed,{hold:1,'admission-eligible':0});
  assert.deepEqual(result.passes.map(p=>[p.pid,p.hold,p['admission-eligible']]),[[2,0,1],[1,1,0],[null,null,null]]);
  assert.equal(result.passes[0].backlog,2);assert.equal(result.duration.median_ms,3000);assert.deepEqual(await measureLinePasses({file,from,cutoff}),result);
  rotatePassJournal(file,{maxBytes:1});assert.deepEqual(await measureLinePasses({file,from,cutoff}),result,'the B4 reader includes rotated history');
  fs.appendFileSync(file,'broken\n');await assert.rejects(measureLinePasses({file,from,cutoff}));
});
