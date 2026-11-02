import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {evaluationCacheFile,readSchedulingJournal,writeEffectJournal,writeEvaluationCache} from '../line-service/journal.mjs';
import {readServiceJournal} from '../line-service/review.mjs';
import {refreshJournal} from '../line-service/scheduling.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'line-journal-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'effects.json');
  const effects={identity:'/own/.git',org:'/own/.org',actions:{original:{state:'started',attempt:'original',commands:[{receipt:'original-result'}]}},
    negative_evaluations:{schema:'line-negative-evaluation/v3',identity:'/own/.git',org:'/own/.org',entries:{'source:R-1':{negative:true,signature:'old',reason:'held'}}}};
  return{directory,file,effects,cache:evaluationCacheFile(file)};
}

test('legacy cache migration retains the exact original intent and keeps it out of later effect checkpoints',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify(f.effects));
  const legacy=readSchedulingJournal(f.file);assert.deepEqual(legacy,f.effects);
  // A crash after the core checkpoint loses only acceleration, never the intent.
  const core=writeEffectJournal(f.file,legacy);
  assert.deepEqual(readSchedulingJournal(f.file).actions,f.effects.actions);
  assert.equal(readSchedulingJournal(f.file).negative_evaluations,undefined);
  const saved=writeEvaluationCache(f.file,legacy),inode=fs.statSync(f.cache).ino;
  for(let n=0;n<5;n++)writeEffectJournal(f.file,legacy);
  assert.equal(fs.statSync(f.cache).ino,inode,'ordinary effect checkpoints never rewrite the cache');
  assert.equal(core.bytes,fs.statSync(f.file).size);assert.equal(saved.bytes,fs.statSync(f.cache).size);
  assert.ok(core.serialize_ms>=0&&core.write_ms>=0);
  assert.equal(Object.hasOwn(readServiceJournal(f.file),'negative_evaluations'),false);
  assert.deepEqual(readSchedulingJournal(f.file),f.effects);
  assert.equal(fs.statSync(f.file).mode&0o777,0o600);assert.equal(fs.statSync(f.cache).mode&0o777,0o600);
});

test('damaged, foreign and redirected caches are cold while the strict original journal remains authoritative',t=>{
  const f=fixture(t);writeEffectJournal(f.file,f.effects);
  for(const value of ['{bad',JSON.stringify({...f.effects.negative_evaluations,identity:'/foreign/.git'}),JSON.stringify({schema:'unknown',entries:{}})]){
    fs.writeFileSync(f.cache,value);
    assert.equal(readSchedulingJournal(f.file).negative_evaluations,undefined);
    assert.deepEqual(readSchedulingJournal(f.file).actions,f.effects.actions);
  }
  const foreign=path.join(f.directory,'foreign');fs.writeFileSync(foreign,'preserve');fs.unlinkSync(f.cache);fs.symlinkSync(foreign,f.cache);
  assert.equal(readSchedulingJournal(f.file).negative_evaluations,undefined);
  assert.throws(()=>writeEvaluationCache(f.file,f.effects),/redirected/);
  assert.equal(fs.readFileSync(foreign,'utf8'),'preserve');
  fs.writeFileSync(f.file,'{}');assert.throws(()=>readSchedulingJournal(f.file),/absence UNKNOWN/);
});

test('a yielded scheduler inherits another writer cache and action result without replacing the original action object',t=>{
  const f=fixture(t),local=structuredClone(f.effects),original=local.actions.original;
  writeEffectJournal(f.file,f.effects);writeEvaluationCache(f.file,f.effects);
  const other=readSchedulingJournal(f.file);other.actions.original.state='complete';other.actions.original.result={receipt:'original-result'};
  delete other.negative_evaluations.entries['source:R-1'];other.negative_evaluations.entries['source:R-2']={negative:true,signature:'new'};
  writeEffectJournal(f.file,other);writeEvaluationCache(f.file,other);
  refreshJournal(local,readSchedulingJournal(f.file));
  assert.equal(local.actions.original,original);assert.deepEqual(original,other.actions.original);
  assert.deepEqual(local.negative_evaluations,other.negative_evaluations);
  assert.equal(local.actions.original.attempt,'original');
});
