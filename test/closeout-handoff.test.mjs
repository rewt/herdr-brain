// Receipt resolution is read-only: no native process source, watcher or queue claim.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { completedCloseoutKeys } from '../lib/closeout-handoff.mjs';
import { digest } from '../lib/completion.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, { handed = true } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completion-tail-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Tail fixture']); git(['config', 'user.email', 'tail@example.invalid']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.org/\n.lane/\n'); git(['add', '.']); git(['commit', '-qm', 'Base']);
  const common = fs.realpathSync(path.join(repo, '.git')), head = git(['rev-parse', 'HEAD']), org = path.join(repo, '.org');
  fs.mkdirSync(org); fs.mkdirSync(path.join(repo, '.lane'));
  const log = path.join(repo, '.lane/gate.log'); fs.writeFileSync(log, 'green offline gate\n');
  const receipt = path.join(repo, '.lane/manual.record.json'), checkpoint = receipt + '.closeout.json';
  const target = { schema: 'closeout-entry/v2', key: '1'.repeat(64), common, project: repo, org,
    run: 'R-1', item: 'ENG-1', signal: 'landed', branch: 'lane/topic', head, cwd: path.join(repo, 'original-lane') };
  const payload = { version: 1, batch: 'manual-recovery', org, identity: common, base: head, tip: head,
    gate: { exit_code: 0, log, sha256: sha(fs.readFileSync(log)) }, items: [{ item: target.item, run: target.run, head, superseded: [] }], excluded: [] };
  fs.writeFileSync(receipt, JSON.stringify(payload));
  const source = { type: 'promotion.reconciled', identity: common, batch: payload.batch, base: head, tip: head,
    fingerprint: digest(payload), gate: payload.gate, heads: [{ item: target.item, run: target.run, head }], closeout_targets: [target], seq: 5 };
  const tail = { schema: 'closeout-completion/v1', identity: common, project: repo, org,
    source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint, digest: digest(source), batch: source.batch },
    receipt: { file: receipt, sha256: sha(fs.readFileSync(receipt)), fingerprint: source.fingerprint }, keys: [target.key] };
  fs.writeFileSync(checkpoint, JSON.stringify(tail));
  const events = [
    { type: 'item.added', id: target.item, kind: 'work', role: 'engineer', seq: 1 },
    { type: 'run.started', id: target.run, item: target.item, workspace: target.cwd, meta: {}, seq: 2 },
    { type: 'report.ingested', run: target.run, report: { outcome: 'done' }, sha256: 'fixture', seq: 3 },
    { type: 'item.closed', id: target.item, as: 'done', seq: 4 }, source,
    ...(handed ? [{ type: 'closeout.handoff', seq: 6, identity: common, project: repo, org,
      source: { seq: source.seq, type: source.type }, keys: [target.key], checkpoint, digest: digest(tail) }] : []),
  ];
  const eventFile = path.join(org, 'events.jsonl'), save = () => fs.writeFileSync(eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  save();
  const expected = { common, project: repo, org, run: target.run, item: target.item, topic: 'topic', tip: head,
    source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint } };
  const resolve = (binding = expected) => completedCloseoutKeys({ cwd: repo, org, expected: binding });
  return { repo, common, org, target, source, tail, payload, receipt, checkpoint, log, events, eventFile, save, expected, resolve };
}

test('a recovered source alone cannot substitute for its manual caller tail', t => {
  const f = fixture(t, { handed: false }), before = fs.readFileSync(f.eventFile);
  assert.throws(() => f.resolve(), /awaiting exact completion handoff/);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
});

test('an exact committed manual tail resolves idempotently without another handoff or effect', t => {
  const f = fixture(t), before = fs.readFileSync(f.eventFile), checkpoint = fs.readFileSync(f.checkpoint);
  assert.deepEqual(f.resolve(), [f.target.key]); assert.deepEqual(f.resolve(), [f.target.key]);
  assert.deepEqual(fs.readFileSync(f.eventFile), before); assert.deepEqual(fs.readFileSync(f.checkpoint), checkpoint);
});

for (const field of ['common', 'project', 'org', 'run', 'item', 'topic', 'tip', 'source-seq', 'source-type', 'source-fingerprint'])
  test(`a recovered outbox cannot redirect its ${field} binding`, t => {
    const f = fixture(t), expected = structuredClone(f.expected);
    if (field.startsWith('source-')) expected.source[field.slice(7)] = field === 'source-seq' ? 99 : 'foreign';
    else expected[field] = field === 'org' ? f.repo : 'foreign';
    assert.throws(() => f.resolve(expected), /binding|source|target/);
  });

for (const change of ['source', 'gate', 'receipt-bytes', 'checkpoint', 'redirected-receipt'])
  test(`a committed completion tail keeps changed ${change} evidence`, t => {
    const f = fixture(t);
    if (change === 'source') { f.source.heads[0].head = 'f'.repeat(40); f.save(); }
    if (change === 'gate') fs.appendFileSync(f.log, 'changed');
    if (change === 'receipt-bytes') fs.appendFileSync(f.receipt, ' ');
    if (change === 'checkpoint') fs.appendFileSync(f.checkpoint, 'changed');
    if (change === 'redirected-receipt') {
      const copy = f.receipt + '.copy'; fs.renameSync(f.receipt, copy); fs.symlinkSync(copy, f.receipt);
    }
    assert.throws(() => f.resolve());
  });

for (const change of ['reopen', 'new-run']) test(`manual recovery cannot acquire authority after ${change}`, t => {
  const f = fixture(t);
  f.events.push(change === 'reopen' ? { type: 'item.reopened', id: f.target.item, seq: 7 } :
    { type: 'run.started', id: 'R-2', item: f.target.item, workspace: f.target.cwd, meta: {}, seq: 7 });
  f.save(); assert.throws(() => f.resolve(), /reopened|run changed/);
});
