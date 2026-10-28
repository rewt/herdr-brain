import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exitFixture } from './retire-exit-fixture.mjs';
import { fixture, isolatedEnv } from './retire-fixture.mjs';
import { sweepCommands } from './retire-sweep-fixture.mjs';
import { assertFixtureScratch } from './scratch-fixture.mjs';
import { setTimeout as pause } from 'node:timers/promises';
import { loadTimeout } from '../../lib/deadline.mjs';
import { loadEvents, transact } from '../../lib/store.mjs';
import { fold } from '../../lib/state.mjs';
import { handoffCloseout } from '../../lib/closeout-handoff.mjs';
import { digest } from '../../lib/completion.mjs';
import { bindCloseoutSources, publishCloseoutEvents } from '../../lib/closeout.mjs';
import { drainCloseout } from '../../lib/closeout-consumer.mjs';
import { sourceRoot } from '../../line-service/line-service.mjs';
import { readCloseoutObservations } from '../../lib/closeout-diagnostics.mjs';
import { closeoutWaitState } from '../../lib/closeout-status.mjs';
import { unresolvedCloseoutEffect } from '../../lib/closeout.mjs';

const cli = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const closer = fileURLToPath(new URL('../../supervisor/closeout.mjs', import.meta.url));
const lanes = fileURLToPath(new URL('../../lanes/lane.mjs', import.meta.url));
const retirementCLI = fileURLToPath(new URL('../../supervisor/retire.mjs', import.meta.url));
const events = f => loadEvents(f.org).events;
async function waitForChange(_files, predicate, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + loadTimeout(timeoutMs);
  while (!predicate()) { if (Date.now() >= deadline) throw Error('bounded fixture observation timed out'); await pause(25); }
}
function setup(t, { occupied = true, merged = false, terminal = false, direct = false } = {}) {
  const f = occupied ? exitFixture(t) : fixture(t, { occupied, merged });
  if (occupied && !merged) f.git(['reset', '--hard', `${f.head}^`]);
  isolatedEnv(t, f);
  fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.org\n.lane/\n');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { closeout_queue: true } }));
  fs.writeFileSync(f.eventFile, events(f).filter(e => e.type !== 'item.closed' && e.type !== 'report.ingested').map(e => JSON.stringify(e) + '\n').join(''));
  const commands = sweepCommands(f);
  const options = { herdr: f.job.herdr, command: commands.command,
    log: row => { if (row.action === 'scratch-manifest') assertFixtureScratch(row.manifest, f.env, options.scratchRoots); },
    readOwner: owner => (f.read().info?.process_tree ?? []).some(p => p.pid === owner.pid && p.identity === owner.identity) };
  f.receipts = new Map();
  f.autoTail = true;
  f.append = add => {
    // Existing lifecycle cases own a completed post-return tail. New ordering
    // witnesses explicitly disable this helper and exercise the missing tail.
    add = add.map(e => {
      if (e.type !== 'promotion.reconciled') return e;
      const state = fold([...events(f), ...add]), id = e.batch ?? `fixture-${events(f).length}`;
      const log = path.join(f.scratch, `${id}.gate.log`); fs.writeFileSync(log, 'successful offline gate\n');
      const payload = { version: 1, batch: id, org: f.org, identity: f.common,
        base: f.git(['rev-parse', 'HEAD']), tip: e.tip ?? f.git(['rev-parse', 'HEAD']),
        gate: { exit_code: 0, log, sha256: createHash('sha256').update(fs.readFileSync(log)).digest('hex') },
        items: e.heads.map(h => ({ ...h, item: h.item ?? state.runs.get(h.run).item, superseded: [] })), excluded: [] };
      const receipt = path.join(f.scratch, `${id}.record.json`); fs.writeFileSync(receipt, JSON.stringify(payload));
      f.receipts.set(id, receipt);
      return { ...e, batch: id, base: payload.base, tip: payload.tip, gate: payload.gate, fingerprint: digest(payload), heads: payload.items.map(({item,run,head}) => ({item,run,head})) };
    });
    const result = transact(f.org, current => {
      const mutation = bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add } });
      // Existing controls model saved pre-direct requests. New direct controls
      // opt in to today's writer and record-only target representation.
      if (!direct) for (const event of mutation.add) for (const target of event.closeout_targets ?? []) delete target.reportCloseout;
      return mutation;
    }, { actor: 'fixture' });
    publishCloseoutEvents({ cwd: f.repo, org: f.org, added: result.added, start: false, env: f.env });
    if (f.autoTail) for (const source of result.added.filter(e => e.type === 'promotion.reconciled')) {
      const state = fold(events(f));
      if (source.heads.every(h => state.runs.get(h.run)?.report && state.items.get(h.item)?.closed?.as === 'done'))
        handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
    }
    return result.added;
  };
  f.options = options;
  f.drain = extra => drainCloseout({ cwd: f.repo, org: f.org, env: f.env, retirementOptions: options, ...extra });
  f.report = () => f.append([{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' }]);
  f.land = () => { f.git(['merge', '--ff-only', f.head]); return f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }, {
    type: 'promotion.reconciled', identity: f.common, batch: 'fixture', tip: f.head,
    heads: [{ run: 'R-1', item: 'ENG-1', head: f.head }], runs: ['R-1'], items: ['ENG-1'],
  }]); };
  if (terminal) { f.report(); f.land(); }
  return f;
}
const evaluations = f => [...events(f).filter(e => e.type === 'closeout.evaluated'),...readCloseoutObservations(f.common,f.org,events(f))].sort((a,b)=>(a.seq??a.observed_seq)-(b.seq??b.observed_seq));
const effects = f => events(f).filter(e => e.type === 'closeout.effect').map(e => e.outcome);

// Unresolved native outcomes need their original producer, not a retry/readback.
function retainNativeOutcome(f, entry) {
  const original = events(f), intent = unresolvedCloseoutEffect(entry, original);
  assert.ok(intent, 'fixture must retain an unresolved original native intent');
  const file = path.join(f.common, 'closeout/entries', entry.key + '.json');
  const intentId = original.find(e => e.type === 'closeout.effect' && e.outcome === intent).effect;
  const bytes = fs.readFileSync(file), calls = f.herdrCalls(), actions = f.read().actions;
  const originalEffects = effects(f), command = f.options.command;
  let nativeCalls = 0;
  f.options.command = (exe, args, options) => {
    if (exe === f.job.herdr) nativeCalls++;
    return command(exe, args, options);
  };
  return () => {
    const all = events(f), waits = all.filter(e => e.type === 'closeout.waiting' && e.key === entry.key &&
      (e.waiting.defect || e.waiting.producers.some(p => p.kind === 'native-command' && p.intent === intentId)));
    assert.deepEqual(all.slice(0, original.length), original, 'original source, intent, waits and failures stay immutable');
    assert.deepEqual(unresolvedCloseoutEffect(entry, all), intent, 'native outcome remains UNKNOWN');
    assert.deepEqual(effects(f), originalEffects, 'no observed completion, release or removal is invented');
    assert.equal(nativeCalls, 0, 'no new native read or effect, including refused reads');
    assert.deepEqual(f.herdrCalls(), calls);
    assert.deepEqual(f.read().actions, actions);
    assert.deepEqual(fs.readFileSync(file), bytes, 'original lane/source binding survives');
    assert.ok(fs.existsSync(f.lane));
    assert.ok(waits.length > 0, 'durable pending or defect evidence survives');
    for (const wait of waits) assert.notEqual(closeoutWaitState(wait, all), 'complete');
    assert.equal(all.slice(original.length).some(e => e.type === 'closeout.producer-status' && e.key === entry.key && e.status === 'complete'), false);
    assert.equal(evaluations(f).some(e => e.key === entry.key && e.completed), false);
  };
}

function selectCurrentCleanup(f) {
  const directory = path.join(f.org, 'line-service', createHash('sha256').update(JSON.stringify(f.common)).digest('hex').slice(0, 20));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'installation.json');
  const receipt = { repo: f.repo, org: f.org, source: sourceRoot, node: process.execPath,
    file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` };
  fs.writeFileSync(file, JSON.stringify(receipt));
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { closeout_queue: false, line_service_cleanup: true } }));
  return { file, receipt, directory };
}

function assertRemoved(f) {
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.deepEqual(f.read().workspaces, []);
  assert.ok(effects(f).some(e => e.action === 'lane-removed'));
}

function child(exe, args, options) {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, options); let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
    c.once('error', reject); c.once('close', status => resolve({ status, stdout, stderr }));
  });
}


export { cli, closer, lanes, retirementCLI, events, waitForChange, setup, evaluations, effects, retainNativeOutcome, selectCurrentCleanup, assertRemoved, child };
