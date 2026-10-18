import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupOrg } from '../../test/helpers.mjs';
import { coldStart, renderColdStart, receiptDirectory } from '../context.mjs';
import { renderHandoffTemplate } from '../../lib/render.mjs';

function fixture(t) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', f.root], { stdio: 'pipe' });
  const draft = path.join(f.root, 'draft.md'); fs.writeFileSync(draft, renderHandoffTemplate());
  const save = (workspace, slot = 'supervisor') => f.json(['handoffs', 'write', '--workspace', workspace, '--slot', slot, '--file', draft, '--json']);
  const read = (options = {}) => coldStart({ cwd: f.root, org: f.dir, memory: { available: 8 * 1024 ** 3, total: 16 * 1024 ** 3, swap_used: 0 }, ...options });
  return { ...f, draft, save, read };
}

test('brief names the latest supervisor handoff once per workspace, supports selection, and never advances the record', t => {
  const f = fixture(t), old = f.save('w1'), newest = f.save('w1'), other = f.save('w2'); f.save('w1', 'chat');
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  const doc = f.read(), text = renderColdStart(doc);
  assert.equal(doc.handoffs.length, 2);
  assert.equal(text.split('\n').filter(line => line.startsWith('Handoff (')).length, 2);
  assert.ok(text.includes(`${newest.path} sha256=${newest.sha256}`)); assert.ok(text.includes(other.path)); assert.ok(!text.includes(old.path));
  assert.deepEqual(f.read({ workspace: 'w1' }).handoffs.map(h => h.path), [newest.path]);
  assert.equal(f.read({ workspace: 'unrecorded' }).handoffs.length, 0);
  assert.equal(fs.existsSync(path.join(receiptDirectory(f.dir, doc.project.identity), 'cursor.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
});

for (const failure of ['missing', 'changed']) test(`brief reports ${failure} latest handoff as recovery evidence without naming an older file`, t => {
  const f = fixture(t), old = f.save('w1'), newest = f.save('w1');
  if (failure === 'missing') fs.unlinkSync(newest.path);
  else { fs.chmodSync(newest.path, 0o644); fs.writeFileSync(newest.path, 'changed'); }
  const doc = f.read(), text = renderColdStart(doc);
  assert.equal(doc.handoffs.length, 0); assert.equal(doc.recovery.length, 1);
  assert.match(doc.recovery[0].reason, failure === 'missing' ? /handoff missing/ : /sha256 mismatch/);
  assert.ok(!text.includes(old.path)); assert.doesNotMatch(text, /^Handoff \(/m);
});

test('supervisor brief CLI names the selected handoff in one line and JSON exposes its verified hash', t => {
  const f = fixture(t), handoff = f.save('w1'); f.save('w2');
  const cli = fileURLToPath(new URL('../supervisor.mjs', import.meta.url));
  const args = [cli, 'brief', '--repo', f.root, '--org', f.dir, '--workspace', 'w1'];
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  const invoke = extra => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8', env: { ...process.env, ORG_DIR: f.dir } });
  const plain = invoke([]); assert.equal(plain.status, 0, plain.stderr);
  assert.ok(plain.stdout.includes(`${handoff.path} sha256=${handoff.sha256}`));
  assert.equal(plain.stdout.split('\n').filter(line => line.startsWith('Handoff (')).length, 1);
  const json = invoke(['--json']); assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).handoffs.map(h => h.sha256), [handoff.sha256]);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
});

test('a record with no handoffs keeps the brief free of handoff lines and recovery warnings', t => {
  const f = fixture(t), doc = f.read();
  assert.deepEqual(doc.handoffs, []); assert.deepEqual(doc.recovery, []);
  assert.doesNotMatch(renderColdStart(doc), /^Handoff \(/m);
});
