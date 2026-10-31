import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {appendPassJournal,rotatePassJournal,readPassJournal,passJournalSize,PASS_JOURNAL_LIMIT} from '../line-service/pass-journal.mjs';
import {replayNoticeAudit} from '../line-service/line-service.mjs';
import {morningDigest} from '../line-service/phase1.mjs';
import {measureLifecycle} from '../measurement/lifecycle.mjs';
import {canonical} from '../messages/schema.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pass-journal-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'passes.jsonl');}
const bytes=rows=>rows.map(r=>JSON.stringify(r)+'\n').join('');
const hash=b=>createHash('sha256').update(b).digest('hex');
function rows(){
  const boundary='dispatch:REV-1',reason='retained failure',scope={item:'REV-1'},key=hash(canonical([boundary,reason,scope]));
  return [1,2,3].flatMap(count=>[
    {at:`2026-10-30T01:00:0${count}Z`,action:'hold',notice_record:{key,entry:{id:`line-record-${key}`,boundary,reason,scope,review:true,count,first_at:'2026-10-30T01:00:01Z'}}},
    {at:`2026-10-30T01:00:0${count}Z`,action:'engineering-idle',progress:{project:'project',org:'org',count,pass:`pass-${count}`,signature:'same'}},
    {action:'review-health',health:{project:'project',org:'org',gap_passes:count}}
  ]);
}
const effects=offset=>({identity:'project',org:'org',notice_audit_offset:offset});

test('rotation preserves exact bytes, dated member index, logical replay and digest window across multiple segments',t=>{
  const file=fixture(t),source=rows(),prefix=bytes(source.slice(0,3)),rest=bytes(source.slice(3));
  fs.writeFileSync(file,prefix);const offset=Buffer.byteLength(prefix),expected=effects(offset);
  fs.appendFileSync(file,rest);replayNoticeAudit(file,expected);
  const digest=morningDigest({events:[],diagnostics:source,since:'2026-10-30T01:00:02Z',now:'2026-10-30T02:00:00Z'});
  const size=fs.statSync(file).size,result=rotatePassJournal(file,{maxBytes:1,now:'2026-10-30T02:00:00Z'});
  assert.equal(fs.statSync(file).size,0);assert.equal(result.segment.end,size);assert.match(result.segment.name,/^2026-10-30T/);
  assert.equal(result.segment.sha256,hash(prefix+rest));assert.equal(passJournalSize(file),size);assert.deepEqual([...readPassJournal(file)],source);
  const actual=effects(offset);assert.deepEqual(replayNoticeAudit(file,actual),Object.keys(expected.record_notices));assert.deepEqual(actual,expected);
  assert.deepEqual(morningDigest({events:[],diagnostics:readPassJournal(file),since:digest.since,now:digest.through}),digest);
  appendPassJournal(file,{at:'2026-10-30T03:00:00Z',text:'café 🐈'});const current=passJournalSize(file);
  rotatePassJournal(file,{maxBytes:1});assert.deepEqual([...readPassJournal(file,{offset:size})],[{at:'2026-10-30T03:00:00Z',text:'café 🐈'}]);assert.equal(passJournalSize(file),current);
  assert.deepEqual([...readPassJournal(file,{offset:current})],[]);assert.throws(()=>[...readPassJournal(file,{offset:1})],/boundary/);
  const index=fs.readFileSync(file+'.segments/index.json');assert.equal(rotatePassJournal(file,{maxBytes:1}).rotated,false);assert.deepEqual(fs.readFileSync(file+'.segments/index.json'),index);
});

for(const phase of ['intent','renamed','compressed','indexed'])test(`process death after ${phase} leaves readers and checkpoints exact; recovery is idempotent`,t=>{
  const file=fixture(t),source=rows();fs.writeFileSync(file,bytes(source));
  const offset=Buffer.byteLength(bytes(source.slice(0,3))),expected=effects(offset);replayNoticeAudit(file,expected);
  const code="import {rotatePassJournal} from './line-service/pass-journal.mjs';rotatePassJournal(process.argv[1],{maxBytes:1,fault:phase=>{if(phase===process.argv[2])process.exit(86);}});";
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,file,phase],{cwd:root,encoding:'utf8'});assert.equal(child.status,86,child.stderr);
  assert.deepEqual([...readPassJournal(file)],source);const after=effects(offset);replayNoticeAudit(file,after);assert.deepEqual(after,expected);
  rotatePassJournal(file,{maxBytes:1});assert.equal(fs.statSync(file).size,0);assert.deepEqual([...readPassJournal(file)],source);
  const index=fs.readFileSync(file+'.segments/index.json');assert.equal(JSON.parse(index).segments.length,1);
  assert.equal(rotatePassJournal(file,{maxBytes:1}).rotated,false);assert.deepEqual(fs.readFileSync(file+'.segments/index.json'),index);
});

test('first rotation waits for pre-upgrade finite owners without changing their checkpoint bytes',t=>{
  const file=fixture(t);fs.writeFileSync(file,bytes(rows()));
  const lock=path.join(path.dirname(file),'general-1.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({at:'2020-01-01T00:00:00Z',pid:process.pid}));
  const original=fs.readFileSync(file),result=rotatePassJournal(file,{maxBytes:1});assert.equal(result.rotated,false);assert.match(result.deferred,/pre-upgrade/);assert.deepEqual(fs.readFileSync(file),original);
  fs.rmSync(lock,{recursive:true});assert.equal(rotatePassJournal(file,{maxBytes:1}).rotated,true);assert.deepEqual([...readPassJournal(file)],rows());
});

test('first rotation ignores a proven dead pre-upgrade owner without removing its lock',t=>{
  const file=fixture(t);fs.writeFileSync(file,bytes(rows()));
  const child=spawnSync(process.execPath,['-e','process.exit(0)']);assert.equal(child.status,0);
  const lock=path.join(path.dirname(file),'general-1.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({at:'2020-01-01T00:00:00Z',pid:child.pid}));
  assert.equal(rotatePassJournal(file,{maxBytes:1}).rotated,true);assert.equal(fs.existsSync(lock),true);assert.deepEqual([...readPassJournal(file)],rows());
});

test('normal appends rotate at the limit and readers handle rows and unicode spanning compression members',t=>{
  const file=fixture(t),row={text:'猫'.repeat(400000)},text=bytes([row]);
  fs.writeFileSync(file,text.repeat(Math.ceil(PASS_JOURNAL_LIMIT/Buffer.byteLength(text))));
  const count=Math.ceil(PASS_JOURNAL_LIMIT/Buffer.byteLength(text));
  appendPassJournal(file,{action:'next'});assert.ok(fs.statSync(file).size<PASS_JOURNAL_LIMIT);
  let n=0;for(const r of readPassJournal(file)){if(n<count)assert.deepEqual(r,row);else assert.equal(r.action,'next');n++;}assert.equal(n,count+1);
});

test('concurrent appenders keep each row exactly once while a large journal rotates',async t=>{
  const file=fixture(t),row={text:'x'.repeat(1024)};fs.writeFileSync(file,bytes([row]).repeat(17000));
  const code="import {appendPassJournal} from './line-service/pass-journal.mjs';for(let n=0;n<30;n++)appendPassJournal(process.argv[1],{writer:process.argv[2],n});";
  await Promise.all(['one','two'].map(id=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['--input-type=module','-e',code,file,id],{cwd:root,stdio:['ignore','ignore','pipe']});let stderr='';c.stderr.on('data',b=>stderr+=b);c.on('error',reject);c.on('exit',s=>s===0?resolve():reject(Error(stderr)));})));
  const writes=[...readPassJournal(file)].filter(r=>r.writer);assert.equal(writes.length,60);assert.equal(new Set(writes.map(r=>r.writer+r.n)).size,60);
});

test('incomplete tails, redirected segments and corrupt compressed members fail without changing source bytes',t=>{
  const file=fixture(t);fs.writeFileSync(file,'{"partial":');const original=fs.readFileSync(file);
  assert.throws(()=>appendPassJournal(file,{}),/tail/);assert.throws(()=>rotatePassJournal(file,{maxBytes:1}),/tail/);assert.deepEqual(fs.readFileSync(file),original);
  fs.writeFileSync(file,bytes([{ok:true}]));rotatePassJournal(file,{maxBytes:1});
  const index=JSON.parse(fs.readFileSync(file+'.segments/index.json')),gz=path.join(file+'.segments',index.segments[0].name+'.jsonl.gz');
  const packed=fs.readFileSync(gz);packed[15]^=255;fs.writeFileSync(gz,packed);assert.throws(()=>[...readPassJournal(file)]);
  fs.renameSync(gz,gz+'.original');fs.symlinkSync(gz+'.original',gz);assert.throws(()=>[...readPassJournal(file)],/redirected/);
});

test('B4 lifecycle counts retain their exact event window across pass rotation',t=>{
  const file=fixture(t);fs.writeFileSync(file,bytes(rows()));
  const input={events:[{seq:1,type:'run.started',id:'R-1',item:'ENG-1',at:'2026-10-30T01:00:00Z',by:'line-service',meta:{dispatch_project:'project'}},{seq:2,type:'report.ingested',run:'R-1',at:'2026-10-30T02:00:00Z'}],project:'project',from:'2026-10-30T00:00:00Z',cutoff:'2026-10-30T03:00:00Z'};
  const before=measureLifecycle(input);rotatePassJournal(file,{maxBytes:1});assert.deepEqual(measureLifecycle(input),before);assert.equal(before.counts.starts,1);assert.equal(before.counts.reports_ingested,1);
});

test('real journal copy rotation preserves every byte and checkpoint with a durable receipt',{skip:!process.env.HERDR_TEST_PASS_JOURNAL_WITNESS},t=>{
  const directory=process.env.HERDR_TEST_PASS_JOURNAL_WITNESS,file=path.join(directory,'passes.jsonl'),meta=JSON.parse(fs.readFileSync(path.join(directory,'copy.json'))),checkpoint=JSON.parse(fs.readFileSync(path.join(directory,'effects.json')));
  const before=structuredClone(checkpoint);replayNoticeAudit(file,before);
  const receipt=rotatePassJournal(file),after=structuredClone(checkpoint);replayNoticeAudit(file,after);assert.deepEqual(after,before);
  assert.equal(receipt.segment.sha256,meta.sha256);assert.equal(receipt.segment.end,meta.bytes);assert.equal(fs.statSync(file).size,0);
  let count=0;for(const _row of readPassJournal(file))count++;assert.equal(count,meta.rows);
  assert.equal(rotatePassJournal(file).rotated,false);
  fs.writeFileSync(path.join(directory,'rotation-receipt.json'),JSON.stringify({node:process.version,source:meta,receipt,after_live_bytes:fs.statSync(file).size,rows_verified:count,checkpoint_offset:checkpoint.notice_audit_offset,checkpoint_exact:true,repeat_noop:true},null,2)+'\n');
});
