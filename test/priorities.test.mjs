import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupOrg } from './helpers.mjs';
import { fold } from '../lib/state.mjs';
import { fold as olderFold, itemStatus as olderStatus } from './fixtures/state-v0.mjs';

const human = { env: { ORG_ACTOR: 'human' } };
const agent = { env: { ORG_ACTOR: 'worker' } };
function fixture(t) {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true })); return f;
}

test('operator ranks are separate from item hints and every affected rank retains who and why', t => {
  const f = fixture(t);
  assert.match(f.ok(['priorities']), /No priorities yet/);
  f.ok(['priorities', 'add', 'Useful adoption', '--why=People can use it'], human);
  f.ok(['priorities', 'add', 'Durable continuity', '--why=Context clears cost nothing'], human);
  f.ok(['add', 'Explore', '--role=engineer', '--priority=1000']);
  const before = f.json(['priorities', '--json']);
  f.ok(['priorities', 'rank', 'P-2', '--rank=1', '--why=Continuity comes first', `--expect=${before.revision}`], human);
  const after = f.json(['priorities', '--json']);
  assert.deepEqual(after.priorities.map(p => p.id), ['P-2', 'P-1']);
  assert.deepEqual(after.priorities.map(p => p.rank), [1, 2]);
  assert.equal(after.priorities[0].history[0].rank, 2);
  for (const p of after.priorities) {
    assert.equal(p.history.at(-1).by, 'human'); assert.equal(p.history.at(-1).why, 'Continuity comes first');
  }
  const bytes = fs.readFileSync(path.join(f.dir, 'events.jsonl'), 'utf8');
  for (const args of [
    ['rank', 'P-1', '--rank=1', '--why=stale', `--expect=${before.revision}`],
    ['rank', 'P-1', '--rank=0', '--why=invalid'], ['rank', 'P-1', '--rank=3', '--why=invalid'],
    ['rank', 'P-404', '--rank=1', '--why=unknown'], ['rank', 'P-1', '--rank=1'], ['add', 'More'],
  ]) f.fail(['priorities', ...args], human);
  f.ok(['priorities', 'rank', 'P-2', '--rank=1', '--why=unchanged'], human);
  assert.equal(fs.readFileSync(path.join(f.dir, 'events.jsonl'), 'utf8'), bytes);
  const old = olderFold(f.events()), current = fold(f.events());
  assert.equal(old.items.size, current.items.size);
  assert.equal(olderStatus(old, 'ENG-1'), 'ready');
  assert.equal(current.items.get('ENG-1').priority, 1000);
  assert.match(f.ok(['status']), /Unaligned · 1 open work/);
  assert.match(f.ok(['today']), /Continuity comes first/);
});

test('runs validate alignment, inherit declared item outcomes and allow explicitly unaligned work', t => {
  const f = fixture(t);
  f.ok(['priorities', 'add', 'Adoption', '--why=Useful to people'], human);
  f.ok(['add', 'Adopt', '--goal', '--meta=serves=P-1']);
  f.ok(['add', 'Build', '--role=engineer', '--parent=G-1']);
  f.ok(['add', 'Explore freely', '--role=engineer']);
  f.fail(['start', 'ENG-1', '--serves=P-99'], agent);
  f.fail(['add', 'Bad link', '--meta=serves=P-99'], agent);
  assert.match(f.ok(['start', 'ENG-1'], agent), /serves  P-1/);
  const run = f.json(['show', 'R-1', '--json']);
  assert.equal(run.meta.serves, 'P-1');
  assert.match(fs.readFileSync(run.brief_path, 'utf8'), /serves operator priority 1: \*\*P-1\*\* Adoption/);
  assert.match(f.ok(['start', 'ENG-2'], agent), /Unaligned/);
  const doc = f.json(['status', '--json']).priorities;
  assert.deepEqual(doc.priorities[0].work.map(i => i.id), ['ENG-1']);
  assert.deepEqual(doc.unaligned.work.map(i => i.id), ['ENG-2']);
  assert.deepEqual(doc.priorities[0].runs.map(r => r.id), ['R-1']);
  assert.deepEqual(doc.unaligned.runs.map(r => r.id), ['R-2']);
  f.ok(['abandon', 'R-1']);
  f.ok(['start', 'ENG-1', '--serves='], agent);
  assert.equal(f.json(['show', 'R-3', '--json']).meta.serves, null);
  f.fail(['set', 'R-3', 'serves=P-99'], agent);
  f.fail(['set', 'ENG-1', 'meta.serves=P-99'], agent);
  f.ok(['set', 'R-3', 'meta.serves=P-1'], agent);
  f.ok(['set', 'ENG-2', 'meta.serves=P-1'], agent);
  assert.equal(f.json(['priorities', '--json']).unaligned.work.length, 1, 'explicit unaligned active run remains visible');
});

test('agents propose waiting questions even with auto policy and cannot rank or answer for the operator', t => {
  const f = fixture(t);
  f.ok(['add', 'Direction', '--goal']);
  f.ok(['priorities', 'add', 'Adoption', '--why=People first'], human);
  const config = path.join(f.dir, 'config.json');
  const raw = JSON.parse(fs.readFileSync(config, 'utf8'));
  raw.approvals = { default: 'auto', categories: { priorities: 'auto' } };
  fs.writeFileSync(config, JSON.stringify(raw));
  assert.match(f.fail(['priorities', 'rank', 'P-1', '--rank=1', '--why=Agent choice'], agent), /only the operator/);
  assert.match(f.fail(['priorities', 'add', 'Agent outcome', '--why=Agent choice'], agent), /only the operator/);
  const q = f.ok(['priorities', 'propose', 'Put continuity first?', '--parent=G-1', '--recommend=yes', '--why=Preserve context across sessions'], agent).trim();
  assert.equal(f.json(['show', q, '--json']).closed, null);
  assert.equal(f.json(['today', '--json']).waiting[0].category, 'priorities');
  assert.equal(f.json(['today', '--json']).waiting[0].recommend, 'yes');
  assert.equal(f.json(['show', q, '--json']).created.by, 'worker');
  f.fail(['answer', q, 'yes'], agent);
  f.ok(['answer', q, 'yes'], human);
  assert.equal(f.json(['priorities', '--json']).priorities.length, 1, 'answer does not execute a proposed priority change');
});
