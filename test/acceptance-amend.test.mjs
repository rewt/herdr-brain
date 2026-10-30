import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupOrg } from './helpers.mjs';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { fold, itemStatus } from '../lib/state.mjs';
import { transact } from '../lib/store.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { queueFor, enqueue } from '../promote/promote.mjs';

function fixture(t) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fixtureFleet(t, f.root);
  return f;
}

test('acceptance amendments append attributed revisions, preserving operator words and all other item/run facts', t => {
  const f = fixture(t), human = { env: { ORG_ACTOR: 'human' } };
  const original = ['  Operator words: "keep this" — ' + 'full original text '.repeat(35) + '  ', 'A second original criterion'];
  const parent = f.ok(['add', 'Parent', '--goal']).trim();
  const blocker = f.ok(['add', 'Dependency']).trim();
  const id = f.ok(['add', 'Owned slice', '--role', 'engineer', '--parent', parent, '--priority', '23',
    '--accept', original[0], '--accept', original[1], '--meta', 'queue_selected=true'], human).trim();
  f.ok(['block', id, '--by', blocker]);
  f.ok(['start', id]);
  f.ok(['set', id, 'meta.hold=true', 'meta.accept=metadata is not acceptance']);
  f.ok(['note', id, 'A note also does not replace acceptance']);
  const beforeEvents = f.events(), before = fold(beforeEvents), beforeItem = structuredClone(before.items.get(id));
  assert.equal(beforeItem.accept.length, 1);
  assert.ok(beforeItem.accept[0].endsWith(original.join('\n')), 'creation preserves the operator words verbatim inside the dispatch prompt');
  const log = path.join(f.dir, 'events.jsonl'), oldBytes = fs.readFileSync(log);
  const intermediate = ['Interim acceptance with  two spaces', 'Keep the full middle revision '.repeat(30)];
  f.ok(['amend-accept', id, '--accept', intermediate[0], '--accept', intermediate[1], '--why', 'Apply the first rewrite'],
    { env: { ORG_ACTOR: 'first-amender' }, now: '2026-09-15T10:00:00Z' });
  const latest = ['Final acceptance', 'How we will know it works: observable result'];
  f.ok(['amend-accept', id, '--accept', latest[0], '--accept', latest[1], '--why', 'Apply the final rewrite'],
    { env: { ORG_ACTOR: 'second-amender' }, now: '2026-09-15T11:00:00Z' });
  const events = f.events(), frozen = JSON.stringify(events), after = fold(events), item = after.items.get(id);
  assert.deepEqual(fs.readFileSync(log).subarray(0, oldBytes.length), oldBytes, 'existing log bytes are unchanged');
  assert.deepEqual(events.slice(beforeEvents.length).map(e => e.type), ['item.acceptance-amended', 'item.acceptance-amended']);
  assert.deepEqual(item.accept, latest);
  assert.deepEqual(item.accept_history.map(r => [r.accept, r.by, r.at, r.why]), [
    [beforeItem.accept, 'human', '2026-09-15T09:00:00.000Z', null],
    [intermediate, 'first-amender', '2026-09-15T10:00:00.000Z', 'Apply the first rewrite'],
    [latest, 'second-amender', '2026-09-15T11:00:00.000Z', 'Apply the final rewrite'],
  ]);
  assert.deepEqual(item.accept_history.map(r => r.seq), [beforeItem.created.seq, events.at(-2).seq, events.at(-1).seq]);
  const { accept, accept_history, ...otherFacts } = item;
  const { accept: ignored, ...oldFacts } = beforeItem;
  assert.deepEqual(otherFacts, oldFacts);
  assert.deepEqual(after.runs, before.runs);
  assert.deepEqual(after.links, before.links);
  assert.equal(itemStatus(after, id), itemStatus(before, id));
  assert.equal(JSON.stringify(events), frozen, 'fold does not rewrite source events');
  const shown = f.ok(['show', id]);
  for (const text of [...original, ...intermediate, ...latest]) assert.ok(shown.includes(text), 'history retains complete text');
  assert.match(shown, /original: .* by human \(event \d+\)/);
  assert.match(shown, /amendment 2 \(current\): .* by second-amender/);
  assert.deepEqual(f.json(['show', id, '--json']).accept_history, item.accept_history);
  const old = olderFold(events), oldBefore = olderFold(beforeEvents);
  assert.deepEqual(old.items, oldBefore.items, 'older fold ignores amendment events');
  assert.deepEqual(old.runs, oldBefore.runs);
  assert.deepEqual(old.links, oldBefore.links);
});

test('file amendment preserves prompt bytes, new briefs use it, and saved briefs remain immutable', t => {
  const f = fixture(t), id = f.ok(['add', 'Rewrite slice', '--accept', 'Superseded acceptance']).trim();
  f.ok(['start', id]);
  const saved = path.join(f.dir, 'runs/R-1/brief.md'), savedBytes = fs.readFileSync(saved);
  const prompt = 'Why: preserve  spaces and “quotes”.\nWhat: one slice.\nEdges: bounded.\nOwner: worker.\nEvidence: durable.\n\nHow we will know it works\nThe observable result.  \n';
  const file = path.join(f.root, 'rewritten-prompt.md');
  fs.writeFileSync(file, prompt);
  f.ok(['amend-accept', id, '--file', file, '--why', 'Apply the revised slice prompt']);
  assert.deepEqual(f.json(['show', id, '--json']).accept, [prompt]);
  assert.deepEqual(f.events().at(-1).accept, [prompt]);
  assert.equal(f.ok(['brief', 'R-1']), savedBytes.toString());
  assert.deepEqual(fs.readFileSync(saved), savedBytes);
  f.ok(['start', id]);
  const fresh = f.ok(['brief', 'R-2']);
  assert.ok(fresh.includes(prompt));
  assert.doesNotMatch(fresh, /Superseded acceptance|acceptance history/);
  fs.unlinkSync(saved);
  const regenerated = f.ok(['brief', 'R-1']);
  assert.ok(regenerated.includes(prompt));
  assert.doesNotMatch(regenerated, /Superseded acceptance/);
});

test('closed done items accept amendments while retaining closure and original acceptance history', t => {
  const f = fixture(t), original = 'Acceptance when completed';
  const id = f.ok(['add', 'Completed slice', '--accept', original]).trim();
  f.ok(['close', id, '--note', 'Completed against the original acceptance']);
  const beforeEvents = f.events(), before = fold(beforeEvents), beforeItem = structuredClone(before.items.get(id));
  assert.equal(itemStatus(before, id), 'done');
  f.ok(['amend-accept', id, '--accept', 'Current acceptance for later consumers', '--why', 'Clarify the completed slice']);
  const events = f.events(), after = fold(events), item = after.items.get(id);
  assert.deepEqual(events.slice(0, beforeEvents.length), beforeEvents);
  assert.deepEqual(events.slice(beforeEvents.length).map(e => e.type), ['item.acceptance-amended']);
  assert.deepEqual(item.accept, ['Current acceptance for later consumers']);
  assert.ok(beforeItem.accept[0].endsWith(original));
  assert.deepEqual(item.accept_history.map(r => r.accept), [beforeItem.accept, item.accept]);
  const { accept, accept_history, ...otherFacts } = item;
  const { accept: ignored, ...oldFacts } = beforeItem;
  assert.deepEqual(otherFacts, oldFacts, 'closure and all other item facts remain intact');
  assert.equal(itemStatus(after, id), 'done');
  const shown = f.json(['show', id, '--json']);
  assert.deepEqual(shown.accept, item.accept);
  assert.deepEqual(shown.closed, beforeItem.closed);
});

test('amending an item without initial acceptance retains an empty original revision', t => {
  const f = fixture(t), id = 'ENG-1';
  // Existing records can predate intent-first creation, which now supplies a prompt.
  transact(f.dir, () => ({ add: [{type:'item.added', id, kind:'work', role:'engineer', title:'Previously unspecified', accept:[]}] }));
  f.ok(['amend-accept', id, '--accept', 'Now specified', '--why', 'Define the result']);
  const item = f.json(['show', id, '--json']);
  assert.deepEqual(item.accept, ['Now specified']);
  assert.deepEqual(item.accept_history[0].accept, []);
  assert.match(f.ok(['show', id]), /\(no acceptance text\)/);
});

test('invalid or reserved acceptance amendments append nothing', t => {
  const f = fixture(t), id = f.ok(['add', 'Keep acceptance', '--accept', 'Original']).trim();
  const file = path.join(f.root, 'empty.md');
  fs.writeFileSync(file, ' \n\t');
  f.ok(['start', id]);
  const reserved = f.ok(['add', 'Reserved question', '--role', 'human', '--meta', 'operator_reserved=true']).trim();
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  const bad = [
    [id, '--why', 'Missing text'],
    [id, '--accept', 'Text'],
    [id, '--accept', 'Text', '--why', '  '],
    [id, '--accept', 'Text', '--accept', '\n', '--why', 'Empty criterion'],
    [id, '--file', file, '--why', 'Empty file'],
    [id, '--file', file, '--accept', 'Mixed', '--why', 'Mixed inputs'],
    [id, '--file', f.root, '--why', 'Directory'],
    [id, '--file', path.join(f.root, 'missing'), '--why', 'Missing file'],
    ['NO-SUCH-ITEM', '--accept', 'Text', '--why', 'Unknown item'],
    ['R-1', '--accept', 'Text', '--why', 'Run is not an item'],
    [id, 'extra', '--accept', 'Text', '--why', 'Extra positional'],
    [reserved, '--accept', 'Text', '--why', 'Reserved'],
  ];
  for (const argv of bad) {
    const result = f.org(['amend-accept', ...argv]);
    assert.equal(result.code, 1, result.out + result.err);
    assert.match(result.err, /^record: /);
    assert.doesNotMatch(result.err, /\n\s+at /, 'validation has a normal CLI diagnostic');
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
  }
});

test('every reserved item form refuses both amendment inputs without changing record bytes', t => {
  const f = fixture(t), original = 'Keep the reserved acceptance';
  const forms = [
    ['--meta', 'operator_reserved=true'],
    ['--meta', 'reserved=true'],
    ['--role', 'human'],
    ['--role', 'HUMAN'],
    ...['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities']
      .map(category => ['--meta', `category=${category}`]),
  ];
  const ids = forms.map((form, index) => f.ok(['add', `Reserved form ${index}`, '--accept', original, ...form]).trim());
  const created = new Map(ids.map(id => [id, f.json(['show', id, '--json']).accept]));
  const file = path.join(f.root, 'replacement.md');
  fs.writeFileSync(file, 'Replacement acceptance\n');
  const log = path.join(f.dir, 'events.jsonl'), before = fs.readFileSync(log);
  for (const id of ids) {
    for (const input of [['--accept', 'Replacement acceptance'], ['--file', file]]) {
      const result = f.org(['amend-accept', id, ...input, '--why', 'Attempt reserved rewrite']);
      assert.equal(result.code, 1, result.out + result.err);
      assert.match(result.err, /operator-reserved acceptance cannot be amended/);
      assert.deepEqual(fs.readFileSync(log), before, `${id}: refusal appends nothing`);
    }
    const item = f.json(['show', id, '--json']);
    assert.deepEqual(item.accept, created.get(id));
    assert.ok(item.accept.join('\n').endsWith(original), 'reserved creation retains the original words');
    assert.equal(item.accept_history, undefined);
  }
});

test('acceptance writer inherits the existing promotion member guard', t => {
  const f = fixture(t);
  const git = args => {
    const result = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-qb', 'main']);
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.org/\n.lane/\n');
  git(['add', '.gitignore']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Seed']);
  const id = f.ok(['add', 'Queued source', '--accept', 'Original']).trim();
  const other = f.ok(['add', 'Independent item']).trim();
  f.ok(['start', id]);
  f.ok(['claim', 'R-1', '--controller', 'brain']);
  const queue = queueFor(f.root);
  enqueue(queue, ['queued-source'], { org: f.dir, claimedBy: 'brain', run: 'R-1', expectedHead: git(['rev-parse', 'HEAD']) });
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  const result = f.org(['amend-accept', id, '--accept', 'Replacement', '--why', 'Queued member']);
  assert.equal(result.code, 3, result.err + result.out);
  assert.match(result.err, /promotion write guard REFUSED/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
  f.ok(['amend-accept', other, '--accept', 'Independent acceptance', '--why', 'Independent scope']);
  assert.deepEqual(f.json(['show', other, '--json']).accept, ['Independent acceptance']);
});
