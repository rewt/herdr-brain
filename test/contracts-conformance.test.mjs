// Writer -> current-reader witnesses for the shared contracts. Never enroll live storage.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { recipientAgent } from './helpers/recipient-agent.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { readFleet } from '../lib/fleet.mjs';
import { fold } from '../lib/state.mjs';
import { publishedSummaryStatus, projectSummary } from '../lib/project-summary.mjs';
import { renderProjectSummary } from '../lib/render.mjs';
import { renderRetirementStatus } from '../lib/retire-status.mjs';
import { validateDocument } from '../board/rows.mjs';
import { readTestSlotOccupancy } from '../test-slot/occupancy.mjs';
import { publishProvingReservation, readProvingReservations } from '../test-slot/reservations.mjs';
import { projectPin, releaseHome, checkRelease, checkBundle } from '../lib/releases.mjs';
import { parseEvent } from '../messages/schema.mjs';
import { LogJournal } from '../logs/journal.mjs';
import { Receiver, addressKey, readTransport, foldTransport } from '../messages/receiver.mjs';
import { hookHandoff } from '../messages/hook-pull.mjs';
import { historicalHookClaim } from './helpers/historical-messages.mjs';
import { readDeclaredReferences } from '../lib/retire-runtime.mjs';
import { explainMiss, readReceiptDeclaration } from '../lanes/exact-validation.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const at = '2026-10-18T12:00:00.000Z';
const extra = { future_field: { version: 2 } };
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode });
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-transport-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixtureFleet(t, root);
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'FIXTURE'), 'brain.transport-fixture/v1\n', { mode: 0o600 });
  const env = { ...process.env, HOME: root, HERDR_ORG_CONSOLE_CONFIG: path.join(root, 'absent-console.json') };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || /^(ORG_DIR|LANE_.*|HERDR_(PANE|TAB|WORKSPACE)_ID)$/.test(key)) delete env[key];
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  const repo = () => {
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    run('git', ['init', '-qb', 'main', cwd]);
    run('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    return cwd;
  };
  return { root, env, run, repo };
}

// Resolve once for the conformance cases. An absent pinned bundle skips; a
// present but invalid bundle fails. Neither falls back to an unrelated current.
let installed;
function installedWriter(cwd = source, home = releaseHome()) {
  const pin = projectPin(cwd);
  if (pin?.release) {
    try { fs.lstatSync(path.join(home, 'releases', pin.release)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { skip: `pinned release not installed: ${pin.release}` };
    }
    return { ...checkRelease(home, pin.release), selection: 'project pin' };
  } else {
    let root;
    try { root = fs.realpathSync(path.join(home, 'current')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { skip: 'no installed release (no project pin or current)' };
    }
    // Legacy installed bundles may predate the manifest protocol.
    return fs.existsSync(path.join(root, '.release-manifest.json'))
      ? { ...checkBundle(root), selection: 'unpinned current' }
      : { root, id: path.basename(root), selection: 'legacy unpinned current' };
  }
}

test('installed writer selection skips an absent pinned bundle but rejects a present invalid bundle', t => {
  const f = fixture(t), cwd = f.repo(), home = path.join(f.root, 'installation'), id = 'fixture-release';
  write(path.join(cwd, '.herdr-release.json'), { release: id });
  f.run('git', ['-C', cwd, 'add', '.herdr-release.json']);
  f.run('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'accept fixture release']);
  const read = () => installedWriter(cwd, home), absent = { skip: `pinned release not installed: ${id}` };
  assert.deepEqual(read(), absent, 'missing releases directory explicitly skips');
  const other = path.join(home, 'releases/other'); fs.mkdirSync(other, { recursive: true });
  fs.symlinkSync(other, path.join(home, 'current'));
  assert.deepEqual(read(), absent, 'missing pinned directory skips without falling back to current');
  const pinned = path.join(home, 'releases', id); fs.mkdirSync(pinned);
  assert.throws(read, { code: 'ENOENT' }, 'present bundle without a manifest must fail');
  write(path.join(pinned, '.release-manifest.json'), { schema: 'herdr-release/v999', protocol: 999 });
  fs.writeFileSync(path.join(pinned, '.release-commit'), 'a'.repeat(40) + '\n');
  assert.throws(read, /incomplete or incompatible release/, 'present incompatible bundle must fail');
});

const contracts = [
  ['brain.review-scope/v1', ['settle/review-range.mjs'], async (f, root) => {
    const writer = await load(root, 'settle/review-range.mjs'), workspace = f.repo();
    const base = f.run('git', ['rev-parse', 'HEAD'], workspace);
    f.run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'delivery'], workspace);
    const head = f.run('git', ['rev-parse', 'HEAD'], workspace);
    const scope = writer.reviewScope({ workspace, base, head, artifacts: [`Commit: ${head}`, `Base: ${base}`] });
    // Like settle's result consumers, read known fields of an internally made
    // receipt. There is no arbitrary external scope-document/version reader.
    const read = doc => ({ schema: doc.schema, base: doc.base, head: doc.head, commits: doc.commits,
      claims: doc.claims, context: doc.context, outside: doc.outside, unresolved: doc.unresolved, deferred: doc.deferred });
    const expected = { schema: 'brain.review-scope/v1', base, head, commits: [head], claims: [head],
      context: [base], outside: [], unresolved: [], deferred: null };
    assert.deepEqual(read(JSON.parse(JSON.stringify(scope))), expected);
    assert.deepEqual(read({ ...scope, ...extra }), expected);
    assert.equal({ result: 'promotable' }.review_scope, undefined, 'older results omit this additive field');
    const deferred = writer.reviewScope({ workspace, base, head, artifacts: [`HEAD: ${base}`] });
    assert.equal(deferred.deferred, 'named-commit-outside-range'); assert.deepEqual(deferred.outside, [base]);
  }],
  ['exact-validation/v1', ['lanes/exact-validation.mjs'], async (f, root) => {
    const writer = await load(root, 'lanes/exact-validation.mjs'), cwd = f.repo();
    const declaration = { schema: 'validation-receipts/v1', exclude: ['settle-review-document'], environment: ['PATH'] };
    write(path.join(cwd, '.validation-receipts.json'), declaration);
    f.run('git', ['-C', cwd, 'add', '.validation-receipts.json']);
    f.run('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Opt in']);
    const base = f.run('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    const identity = writer.exactIdentity({ cwd, common: path.join(cwd, '.git'), base, commands: ['true'], env: f.env, declaration });
    assert.equal(identity.schema, 'exact-validation/v1');
    assert.deepEqual(readReceiptDeclaration({ repo: cwd, base }), declaration);
    assert.equal(explainMiss(identity, { exact: { identity }, ...extra }), null, 'receipt envelope additions are ignored');
    const extended = { ...identity, adapter: { version: 1 } };
    assert.equal(explainMiss(extended, extended), null);
    assert.equal(explainMiss(extended, identity), 'declared', 'adapter identity inputs cannot be dropped');
    assert.equal(explainMiss(identity, { ...identity, schema: 'exact-validation/v999' }), 'declared');
  }],
  ['fleet.json', ['lib/fleet.mjs'], async (f, root) => {
    const writer = await load(root, 'lib/fleet.mjs'), cwd = f.repo();
    const record = path.join(cwd, '.org');
    fs.mkdirSync(record); fs.writeFileSync(path.join(record, 'events.jsonl'), '');
    const joined = writer.joinFleet({ cwd, env: f.env, record, worktrees: path.join(f.root, 'lanes'), layers: [] });
    const doc = json(joined.file), read = () => readFleet(f.env);
    assert.equal(doc.version, 1); assert.equal(read().projects[joined.name].identity, path.join(cwd, '.git'));
    write(joined.file, { ...doc, ...extra, projects: { [joined.name]: { ...doc.projects[joined.name], ...extra } } });
    assert.equal(read().projects[joined.name].record, record);
    write(joined.file, { ...doc, version: 999 });
    assert.throws(read, /invalid fleet/);
  }],
  ['project-summary/v1', ['lib/project-summary.mjs'], async (f, root) => {
    const writer = await load(root, 'lib/project-summary.mjs');
    const project = { identity: path.join(f.root, '.git'), canonical: path.join(f.root, 'project') };
    const archive = [path.join(f.root, 'durable-evidence')];
    const doc = writer.projectSummary({ project, state: fold([]), lanes: { counts: {}, rows: [] }, now: at,
      archive,
      releases: { current: 'fixture', pinned: 'fixture' } });
    const org = path.join(f.root, 'record'); fs.mkdirSync(org);
    writer.writeProjectSummary(org, doc);
    const file = path.join(org, 'published/summary.json'), written = json(file);
    assert.equal(written.schema, 'project-summary/v1');
    if (root === source) assert.deepEqual(written.archive, { dirs: archive });
    assert.equal(publishedSummaryStatus(org, { now: at, project }).status, 'fresh');
    assert.match(renderProjectSummary(written), /fixture/);
    const markdown = renderProjectSummary(written);
    write(file, { ...written, ...extra, project: { ...written.project, ...extra } });
    assert.equal(publishedSummaryStatus(org, { now: at, project }).status, 'fresh');
    assert.equal(renderProjectSummary(json(file)), markdown);
    // The status reader only needs the original freshness/identity envelope.
    write(file, { schema: written.schema, project: written.project, generated_at: written.generated_at,
      stale_after_seconds: written.stale_after_seconds });
    assert.equal(publishedSummaryStatus(org, { now: at, project }).status, 'fresh');
    write(file, { ...written, schema: 'project-summary/v999' });
    assert.equal(publishedSummaryStatus(org, { now: at, project }).status, 'invalid');
  }],
  ['lanes-status/v1', ['lib/retire-status.mjs'], async (f, root) => {
    const writer = await load(root, 'lib/retire-status.mjs');
    const doc = writer.retirementStatus({ common: f.root, errors: ['fixture diagnostic'] }, { generatedAt: at });
    assert.equal(doc.schema, 'lanes-status/v1'); assert.equal(doc.counts.UNKNOWN, 1);
    const rendered = renderRetirementStatus(doc);
    assert.match(rendered, /fixture diagnostic/);
    const enriched = { ...doc, ...extra, rows: doc.rows.map(row => ({ ...row, ...extra })) };
    assert.equal(renderRetirementStatus(enriched), rendered);
    // Exercise the actual summary consumer too; it reads counts and diagnostics.
    const summary = lanes => projectSummary({ project: { identity: f.root, canonical: f.root }, state: fold([]), lanes, now: at });
    assert.deepEqual(summary(enriched), summary(doc));
  }],
  ['board-rows/v1', ['board/brain.mjs'], async (f, root) => {
    const writer = await load(root, 'board/brain.mjs'), common = path.join(f.root, '.git');
    write(path.join(common, 'promote/queue.json'), { identity: common, pending: [{ id: 'job-1', topic: 'topic', queued: at }], results: [] });
    const doc = await writer.brainSource({ identity: common, name: 'fixture', worktrees: [] }, { now: Date.parse(at), logClocks: false, show: () => null });
    const read = value => validateDocument(value, { roots: [common] });
    assert.equal(doc.schema, 'board-rows/v1');
    const parsed = read(doc); assert.equal(parsed.rows[0].id, 'job-1'); assert.equal(parsed.rows[0].phase, 'queued');
    assert.deepEqual(read({ ...doc, ...extra, rows: doc.rows.map(row => ({ ...row, ...extra, status: { ...row.status, ...extra } })) }), parsed);
    const older = structuredClone(doc); for (const row of older.rows) delete row.clocks;
    assert.deepEqual(read(older).rows[0].clocks, []);
    assert.equal(read({ ...doc, schema: 'board-rows/v999' }).rows[0].id, 'source-schema');
  }],
  ['occupancy/v1', ['test-slot/occupancy.mjs'], async (f, root) => {
    const writer = await load(root, 'test-slot/occupancy.mjs'), lock = path.join(f.root, 'slot.lock');
    const held = writer.sharedOccupancy(lock, 'contract fixture', { reason: 'offline conformance' });
    try {
      const doc = json(held.occupancyPath);
      const read = () => readTestSlotOccupancy(lock, { kill: () => {}, startRecord: () => ({ start: doc.processStart, birth: doc.processBirth }) });
      assert.equal(doc.schema, 'occupancy/v1'); assert.equal(read()[0].state, 'live'); assert.equal(read()[0].record.pid, process.pid);
      write(held.occupancyPath, { ...doc, ...extra }); assert.equal(read()[0].state, 'live');
      const older = { ...doc }; for (const key of ['processBirth', 'groupBirth', 'cwd', 'startedAt', 'profile_id']) delete older[key];
      write(held.occupancyPath, older); assert.equal(read()[0].state, 'live');
      write(held.occupancyPath, { ...doc, schema: 'occupancy/v2' });
      assert.deepEqual(read(), []); assert.ok(fs.existsSync(held.occupancyPath), 'unknown versions cannot be pruned');
    } finally { held.release(); }
  }],
  ['host-reservation/v1', ['test-slot/reservations.mjs'], async (f, root) => {
    const writer = await load(root, 'test-slot/reservations.mjs'), lock = path.join(f.root, 'slot.lock');
    const held = writer.publishProvingReservation({ lockPath: lock, label: 'contract proof', reason: 'ENG-424 R-601',
      expiresAt: new Date(Date.now() + 60000).toISOString() });
    const bytes = fs.readFileSync(held.path, 'utf8'), doc = JSON.parse(bytes);
    try {
      assert.equal(doc.schema, 'host-reservation/v1'); assert.equal(readProvingReservations(lock)[0].state, 'live');
      write(held.path, { ...doc, ...extra }); assert.equal(readProvingReservations(lock)[0].state, 'live');
      const missing = { ...doc }; delete missing.expiresAt;
      write(held.path, missing); assert.equal(readProvingReservations(lock, { prune: true })[0].state, 'unknown');
      assert.ok(fs.existsSync(held.path));
      write(held.path, { ...doc, schema: 'host-reservation/v999' });
      assert.deepEqual(readProvingReservations(lock, { prune: true }), [
        { path: held.path, record: null, state: 'unknown', why: 'unsupported reservation schema' }
      ]); assert.ok(fs.existsSync(held.path));
    } finally { fs.writeFileSync(held.path, bytes); held.release(); }
  }],
  ['herdr-release/v1', ['herdr/releases.mjs'], async (f, root) => {
    // Small inventory, real manifest writer. Mandatory entrypoint/hash drift is
    // covered comprehensively by release-pins, not duplicated here.
    const bundle = path.join(f.root, 'bundle'); fs.mkdirSync(bundle);
    for (const file of ['bin/org.mjs', 'lanes/lane.mjs', 'lib/releases.mjs', 'supervisor/supervisor.mjs', 'promote/promote.mjs',
      'housekeeping/housekeeping.mjs', 'contrib/settle-watch.mjs', 'lib/cli-help.mjs', 'lanes/docs/REVIEW_TEMPLATE.md']) {
      fs.mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true }); fs.writeFileSync(path.join(bundle, file), '// fixture\n');
    }
    fs.writeFileSync(path.join(bundle, '.release-commit'), 'a'.repeat(40) + '\n');
    f.run(process.execPath, [path.join(root, 'herdr/releases.mjs'), 'manifest', bundle]);
    const file = path.join(bundle, '.release-manifest.json'), doc = json(file);
    assert.equal(doc.schema, 'herdr-release/v1'); assert.equal(checkBundle(bundle, { verifyFiles: true }).commit, 'a'.repeat(40));
    write(file, { ...doc, ...extra }); assert.equal(checkBundle(bundle, { verifyFiles: true }).protocol, 1);
    write(file, { ...doc, protocol: 999 }); assert.throws(() => checkBundle(bundle), /incompatible release/);
  }],
  ['.herdr-release.json', ['herdr/releases.mjs'], async (f, root) => {
    const cwd = f.repo();
    // unpin is the same writer as pin, without manufacturing a second release.
    f.run(process.execPath, [path.join(root, 'herdr/releases.mjs'), 'unpin', path.join(f.root, 'installation'), cwd]);
    const file = path.join(cwd, '.herdr-release.json'); assert.deepEqual(json(file), { release: null });
    const commit = () => f.run('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'pin fixture']);
    f.run('git', ['-C', cwd, 'add', '.herdr-release.json']); commit();
    assert.equal(projectPin(cwd).release, null);
    write(file, { release: 'fixture-release' }); commit(); assert.equal(projectPin(cwd).release, 'fixture-release');
    // Explicit exception to extensible versioned documents: this selector is a
    // closed unversioned config. Preserve its current rejection of extra keys.
    write(file, { release: 'fixture-release', ...extra }); commit();
    assert.throws(() => projectPin(cwd), /invalid .herdr-release.json/);
  }],
  ['brain.log/v1', ['logs/journal.mjs', 'logs/inputs.mjs'], async (f, root) => {
    const writer = await load(root, 'logs/journal.mjs'), inputs = await load(root, 'logs/inputs.mjs');
    const commonDir = path.join(f.root, '.git'); fs.mkdirSync(commonDir);
    const scope = { identity: 'fixture', commonDir, root: path.join(f.root, 'logs') };
    const journal = new writer.LogJournal({ ...scope, clock: () => at });
    const event = inputs.sourceGap({ source: 'fixture', reason: 'offline fixture' }, scope, at);
    await journal.appendRaw(event);
    const reader = new LogJournal(scope), state = await reader.read();
    assert.equal(state.entries.length, 1); assert.equal(parseEvent(JSON.stringify(state.entries[0])).eventId, event.eventId);
    const file = path.join(journal.directory, state.segments[0].name);
    const enriched = { ...state.entries[0], ...extra, payload: { ...state.entries[0].payload, ...extra } };
    write(file, enriched); assert.equal((await reader.read()).entries[0].eventId, event.eventId);
    const older = { ...event }; delete older.source;
    assert.equal(parseEvent(JSON.stringify(older)).eventId, event.eventId);
    assert.throws(() => parseEvent(JSON.stringify({ ...event, schema: 'brain.log/v999' })), /schema/);
  }],
  ['brain.transport/v1', ['messages/receiver.mjs'], async (f, root) => {
    const writer = await load(root, 'messages/receiver.mjs');
    const common = path.join(f.root, '.git');
    const address = { identity: 'fixture', projectRef: common, role: { name: 'supervisor', bindingRef: 'fixture-launch' } };
    const receiver = new writer.Receiver({ root: f.root });
    await receiver.initialize({ supervisor: address, recipients: [{ address, consumer: 'fixture' }],
      senders: [{ receipt: 'launch', producer: 'sender', epoch: 'one', address, recipients: [addressKey(address)], bodyRoots: [f.root] }] });
    const records = readTransport(f.root); assert.equal(records.length, 1); assert.equal(foldTransport(records).config.supervisor.identity, 'fixture');
    const file = path.join(f.root, 'transport.jsonl');
    write(file, { ...records[0], ...extra });
    assert.equal(new Receiver({ root: f.root }).state().config.recipients[0].consumer, 'fixture');
    fs.appendFileSync(file, JSON.stringify({ schema: 'brain.transport/v1', sequence: 2, at, type: 'future.inert', ...extra }) + '\n');
    assert.equal(new Receiver({ root: f.root }).state().entries.length, 0);
    write(file, { ...records[0], schema: 'brain.transport/v999' }); assert.throws(() => readTransport(f.root), /corrupt transport/);
  }],
  ['hook-pull/v1', ['messages/receiver.mjs', 'messages/hook-pull.mjs'], async (f, root) => {
    const writer = await load(root, 'messages/receiver.mjs');
    const common = path.join(f.root, '.git');
    const sender = { identity: 'fixture', projectRef: common, role: { name: 'supervisor', bindingRef: 'launch' } };
    const address = { identity: 'fixture', projectRef: common, session: { uid: 'worker', incarnation: 'one' } }, recipient = addressKey(address);
    const receiver = new writer.Receiver({ root: f.root });
    await receiver.initialize({ supervisor: sender, recipients: [{ address: sender, consumer: 'sender' }, { address, consumer: 'worker' }],
      senders: [{ receipt: 'launch', producer: 'sender', epoch: 'one', address: sender, recipients: [recipient], bodyRoots: [f.root] }] });
    const event = { schema: 'brain.log/v1', eventId: 'contract-message', producer: { id: 'sender', epoch: 'one', sequence: 1 }, occurredAt: at,
      type: 'session.message.v1', level: 'info', identity: 'fixture', project: { commonDir: common }, payload: { from: sender, to: [address],
        kind: 'request', refs: [], reply_to: null, priority: 'normal', reply_by: null, summary: 'Contract fixture', body_ref: null, decision_ref: null } };
    await receiver.accept(event, { sender: 'launch', recipient });
    const session = { root: f.root, recipient, consumer: 'worker', cwd: f.root, kind: 'claude', rendering: 'plain' };
    await historicalHookClaim(receiver, event.eventId, session);
    const current = new Receiver({ root: f.root });
    const receipt = current.state().entries[0].receipts.at(-1); assert.equal(receipt.transport, 'hook-pull/v1');
    assert.deepEqual(hookHandoff(session).claimedIds, [event.eventId]);
    const records = readTransport(f.root), last = records.at(-1);
    last.receipt = { ...last.receipt, ...extra };
    fs.writeFileSync(path.join(f.root, 'transport.jsonl'), records.map(row => JSON.stringify({ ...row, ...extra })).join('\n') + '\n');
    assert.deepEqual(hookHandoff(session).claimedIds, [event.eventId]);
    await current.consume(event.eventId, recipient, { consumer: 'worker' });
    assert.deepEqual(hookHandoff(session).claimedIds, []);
  }],
  ['herdr-reference/v1', ['supervisor/README.md'], async (f, root) => {
    // No bundled writer exists: the claiming tool follows this published example.
    const guide = fs.readFileSync(path.join(root, 'supervisor/README.md'), 'utf8');
    const example = /```json\s*(\{\s*"schema": "herdr-reference\/v1",[\s\S]*?\})\s*```/.exec(guide);
    assert.ok(example, 'declared reference writer example remains available');
    const doc = JSON.parse(example[1]), file = path.join(f.root, 'references/job.json');
    const read = () => readDeclaredReferences(f.root, Date.parse(doc.created_at));
    write(file, doc); assert.equal(read().errors.length, 0); assert.equal(read().references[0].job, doc.job);
    const older = { ...doc, ...extra }; for (const key of ['run', 'lane', 'cwd', 'pane']) delete older[key];
    write(file, older); assert.equal(read().references[0].owner, doc.owner);
    write(file, { ...doc, schema: 'herdr-reference/v999' });
    assert.equal(read().references.length, 0); assert.match(read().errors[0], /project kept/);
  }],
  ['identity desks', ['supervisor/request.mjs'], async (f, root) => {
    const writer = await load(root, 'supervisor/request.mjs');
    // Procedural contract, no request JSON schema or model-side text validator.
    // Fake only Herdr's physical seam; no real desk is created or prompted.
    for (const enriched of [false, true]) {
      const calls = [], text = 'What: inspect. Why: contract. Done: reply. Evidence: fixture.\nKeep literal $(text).';
      const agent = recipientAgent('desk-fixture', path.join(f.root, 'development/fixture'), {
        agent: 'codex', workspace_id: 'w1', pane_id: 'w1:p1', ...(enriched ? extra : {}),
      });
      const result = await writer.request(['fixture', text], { env: f.env, mirror: () => {}, execute: (_command, args) => {
        calls.push(args);
        const result = args[1] === 'list' ? { agents: [agent] } : args[1] === 'get' ? { agent } : {};
        return { status: 0, stdout: JSON.stringify({ result, ...(enriched ? extra : {}) }) };
      } });
      assert.equal(result.desk, 'desk-fixture');
      assert.deepEqual(calls, [['agent', 'list'], ['agent', 'get', 'desk-fixture'], ['agent', 'prompt', 'desk-fixture', text]]);
    }
  }],
];

test('installed occupancy reader and BCH closed-key reader skip proving reservations without pruning', async t => {
  const f = fixture(t), lock = path.join(f.root, 'slot.lock');
  const held = publishProvingReservation({ lockPath: lock, label: 'mixed proof', reason: 'ENG-424 R-601', expiresAt: new Date(Date.now() + 60000).toISOString() });
  const bytes = fs.readFileSync(held.path, 'utf8');
  try {
    const required = ['schema', 'class', 'pid', 'processStart', 'processBirth', 'pgid', 'groupStart', 'groupBirth', 'acquiredAt', 'startedAt', 'project', 'label', 'cwd', 'host', 'reason'];
    // B:552 checks this closed set only AFTER skipping schemas other than occupancy/v1.
    const bchRead = () => fs.readdirSync(`${lock}.occupancy`).filter(n => !n.startsWith('.')).flatMap(name => {
      const h = json(path.join(`${lock}.occupancy`, name));
      if (h?.schema !== 'occupancy/v1') return [];
      return [{ state: required.every(k => Object.hasOwn(h, k)) && Object.keys(h).every(k => required.includes(k) || k === 'profile_id') ? 'reserved' : 'unknown' }];
    });
    assert.deepEqual(bchRead(), []); assert.equal(fs.readFileSync(held.path, 'utf8'), bytes);
    const release = installed ??= installedWriter();
    if (release.skip) return t.skip(`installed occupancy reader: ${release.skip}`);
    if (!fs.existsSync(path.join(release.root, 'test-slot/occupancy.mjs'))) return t.skip(`installed ${release.id} predates occupancy reader`);
    t.diagnostic(`${release.selection}: ${release.id} (${release.root})`);
    const reader = await load(release.root, 'test-slot/occupancy.mjs');
    assert.deepEqual(reader.readTestSlotOccupancy(lock, { prune: true, kill: () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); } }), []);
    assert.equal(fs.readFileSync(held.path, 'utf8'), bytes);
  } finally { held.release(); }
});

for (const [name, files, conform] of contracts) {
  test(`${name}: current writer -> current reader; compatible shape`, async t => {
    await conform(fixture(t), source);
  });
  test(`${name}: installed writer -> current reader; compatible shape`, async t => {
    const release = installed ??= installedWriter();
    if (release.skip) return t.skip(release.skip);
    const missing = files.filter(file => !fs.existsSync(path.join(release.root, file)));
    if (missing.length) return t.skip(`installed ${release.id} predates ${name} contract writer: ${missing.join(', ')}`);
    t.diagnostic(`${release.selection}: ${release.id} (${release.root})`);
    await conform(fixture(t), release.root);
  });
}
