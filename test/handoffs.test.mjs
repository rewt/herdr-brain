import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupOrg, T0 } from './helpers.mjs';
import { fold, itemStatus } from '../lib/state.mjs';
import { fold as olderFold, itemStatus as olderStatus } from './fixtures/state-v0.mjs';
import { handoffDigest, handoffKey, missingHandoffSections, readHandoff } from '../lib/handoffs.mjs';
import { describeEvent, renderHandoffTemplate } from '../lib/render.mjs';

function fixture(t) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const file = path.join(f.root, 'draft.md');
  fs.writeFileSync(file, renderHandoffTemplate());
  const scope = ['--workspace', 'w34E', '--slot', 'supervisor'];
  const save = (options) => f.json(['handoffs', 'write', ...scope, '--file', file, '--json'], { env: { ORG_ACTOR: 'supervisor-test' }, ...options });
  const latest = () => f.json(['handoffs', 'latest', ...scope, '--json']);
  return { ...f, file, scope, save, latest };
}

test('handoffs write exact immutable bytes and one event; every write gets a fresh timestamp', t => {
  const f = fixture(t);
  const bytes = Buffer.from('\ufeff' + renderHandoffTemplate() + '\nUnicode 🐢\r\n');
  fs.writeFileSync(f.file, bytes);
  const first = f.save(), event = f.events()[0];
  assert.equal(f.events().length, 1);
  assert.deepEqual(Object.keys(event).sort(), ['at', 'author', 'by', 'path', 'seq', 'sha256', 'slot', 'type', 'workspace']);
  assert.equal(event.type, 'handoff.recorded'); assert.equal(event.author, 'supervisor-test'); assert.equal(event.by, event.author);
  assert.equal(event.path, 'handoffs/w34E/supervisor/2026-09-15T09:00:00.000Z.md');
  assert.equal(first.sha256, handoffDigest(bytes)); assert.deepEqual(fs.readFileSync(first.path), bytes);
  assert.equal(fs.statSync(first.path).mode & 0o222, 0);
  fs.writeFileSync(f.file, renderHandoffTemplate() + '\nSecond draft.\n');
  const second = f.save(), third = f.save({ now: '2026-09-14T00:00:00Z', env: { ORG_ACTOR: 'second-author' } });
  assert.notEqual(second.path, first.path); assert.notEqual(third.path, second.path);
  assert.match(second.path, /00\.001Z\.md$/); assert.match(third.path, /00\.002Z\.md$/);
  assert.deepEqual(fs.readFileSync(first.path), bytes);
  assert.equal(f.events().length, 3); assert.equal(f.latest().path, third.path); assert.equal(f.latest().author, 'second-author');
  assert.match(describeEvent(event), /handoff w34E\/supervisor: .*sha256=.*author=supervisor-test/);
});

test('latest uses recorded event order per workspace and slot and ignores unrecorded files', t => {
  const f = fixture(t), first = f.save();
  const orphan = path.join(path.dirname(first.path), '2099-01-01T00:00:00.000Z.md');
  fs.writeFileSync(orphan, 'unrecorded');
  for (const [workspace, slot] of [['w34E', 'chat'], ['another', 'supervisor']]) {
    f.ok(['handoffs', 'write', '--workspace', workspace, '--slot', slot, '--file', f.file]);
  }
  assert.equal(f.latest().path, first.path);
  assert.equal(fold(f.events()).handoffs.size, 3);
  assert.equal(fold(f.events()).handoffs.get(handoffKey('w34E', 'supervisor')).sha256, first.sha256);
});

test('a crash-left file is preserved and never adopted or overwritten', t => {
  const f = fixture(t), directory = path.join(f.dir, 'handoffs/w34E/supervisor');
  fs.mkdirSync(directory, { recursive: true });
  const orphan = path.join(directory, new Date(T0).toISOString() + '.md');
  fs.writeFileSync(orphan, 'interrupted write');
  assert.match(f.fail(['handoffs', 'latest', ...f.scope]), /no recorded handoff/);
  const saved = f.save();
  assert.match(saved.path, /00\.001Z\.md$/); assert.equal(fs.readFileSync(orphan, 'utf8'), 'interrupted write');
});

for (const failure of ['missing', 'changed']) test(`latest refuses a ${failure} recorded file without falling back`, t => {
  const f = fixture(t), older = f.save(), latest = f.save();
  if (failure === 'missing') fs.unlinkSync(latest.path);
  else { fs.chmodSync(latest.path, 0o644); fs.writeFileSync(latest.path, 'tampered'); }
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  assert.match(f.fail(['handoffs', 'latest', ...f.scope]), failure === 'missing' ? /handoff missing/ : /sha256 mismatch/);
  assert.ok(fs.existsSync(older.path)); assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
});

test('handoff paths refuse traversal, redirected directories, redirected files and nonregular files', t => {
  const f = fixture(t);
  for (const value of ['../escape', '.', '..', '/absolute', 'nested/slot', 'two words']) {
    assert.match(f.fail(['handoffs', 'write', '--workspace', value, '--slot', 'supervisor', '--file', f.file]), /single identifier/);
    assert.match(f.fail(['handoffs', 'latest', '--workspace', 'w34E', '--slot', value]), /single identifier/);
  }
  assert.equal(f.events().length, 0);
  fs.symlinkSync(f.root, path.join(f.dir, 'handoffs'));
  assert.match(f.fail(['handoffs', 'write', ...f.scope, '--file', f.file]), /not a plain directory/);
  fs.unlinkSync(path.join(f.dir, 'handoffs'));
  const saved = f.save(), entry = f.events()[0];
  assert.throws(() => readHandoff(f.dir, { ...entry, path: '../draft.md' }), /invalid recorded/);
  fs.unlinkSync(saved.path); fs.symlinkSync(f.file, saved.path);
  assert.match(f.fail(['handoffs', 'latest', ...f.scope]), /handoff unreadable/);
  fs.unlinkSync(saved.path); fs.mkdirSync(saved.path);
  assert.match(f.fail(['handoffs', 'latest', ...f.scope]), /not a regular file/);
});

test('template and section check are advisory and need no record; missing sections do not refuse writes', t => {
  const f = fixture(t), absent = path.join(f.root, 'never-initialized');
  const template = f.ok(['handoffs', 'template'], { env: { ORG_DIR: absent } });
  assert.deepEqual(missingHandoffSections(template), []);
  fs.writeFileSync(f.file, '# A draft\n\n## First steps\nInspect.\n');
  const check = f.json(['handoffs', 'check', '--file', f.file, '--json'], { env: { ORG_DIR: absent } });
  assert.equal(check.missing_sections.length, 4); assert.equal(fs.existsSync(absent), false);
  assert.match(f.ok(['handoffs', 'write', ...f.scope, '--file', f.file]), /Missing handoff sections \(advisory\)/);
  assert.equal(f.latest().missing_sections.length, 4);
  assert.equal(missingHandoffSections('```md\n' + template + '\n```').length, 5);
  assert.equal(missingHandoffSections(template.toUpperCase().replaceAll('\n', '\r\n')).length, 0);
});

test('latest is read-only even while the record lock is held', t => {
  const f = fixture(t), saved = f.save(), lock = path.join(f.dir, 'lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  assert.equal(f.latest().path, saved.path);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
});

test('frozen old fold ignores the actual handoff event and work status remains derived', t => {
  const f = fixture(t), item = f.ok(['add', 'Existing work', '--role', 'engineer']).trim();
  f.ok(['start', item]); f.save();
  const events = f.events(), old = olderFold(events), without = olderFold(events.filter(e => e.type !== 'handoff.recorded'));
  assert.deepEqual(old.items, without.items); assert.deepEqual(old.runs, without.runs); assert.deepEqual(old.links, without.links);
  assert.equal(old.eventCount, events.length);
  assert.equal(olderStatus(old, item), itemStatus(fold(events), item));
  assert.equal(fold(events).handoffs.size, 1); assert.equal('status' in events.at(-1), false);
});
