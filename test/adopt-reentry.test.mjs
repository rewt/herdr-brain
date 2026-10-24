import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { contentDigest, policyLocation, projectIdentity } from '../lib/config-home.mjs';
import { gitProject } from '../lib/project.mjs';
import { initOrg, transact } from '../lib/store.mjs';
import { auditEvents } from '../lib/config-audit.mjs';
import { digest } from '../lib/digest.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { recordStandardSlot } from '../sessions/receipts.mjs';
import { adopt, adoptCommand } from '../lib/adopt-command.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fold } from '../lib/state.mjs';

// ENG-603, 2026-10-24: the retained incident artifacts contain identity.json,
// an identity record and project.json with no published policy. The project
// record still has the earlier adopt's intents/changed events. Reproduce that
// split in isolated homes; never restore or write the operator's artifacts.
function oldBaseline(f, kind = 'lane', { operation = `adopt-rolled-back:${kind}`, bytes } = {}) {
  const identity = projectIdentity(gitProject(f.cwd), f.env).name;
  const name = kind === 'identity' ? 'identity.json' : kind === 'validation' ? 'lane.validation.json' : 'lane.json';
  const file = path.join(f.home, '.herdr-monitor', identity, ...(kind === 'identity' ? [] : ['project']), name);
  const record = kind === 'identity' ? path.join(path.dirname(file), '.org') : f.env.ORG_DIR;
  if (kind === 'identity' && !fs.existsSync(record)) initOrg(record);
  bytes ??= fs.readFileSync(path.join(f.cwd, kind === 'validation' ? '.lane.validation.json' : '.lane.json'));
  const value = JSON.parse(bytes), hash = contentDigest(bytes), scope = kind === 'identity' ? 'identity' : 'project';
  const { added } = transact(record, () => ({ add: [
    { type: 'config.change-intent', operation, file, scope, origin: 'adopt', old_value: value, new_value: value, old_digest: hash, new_digest: hash },
    { type: 'config.changed', operation, file, scope, origin: 'adopt', old_value: value, new_value: value, old_digest: hash, new_digest: hash },
  ] }), { actor: 'fixture-supervisor' });
  return added[1];
}
function homeSnapshot(f) {
  const home = path.join(f.home, '.herdr-monitor'), entries = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      entries.push([path.relative(home, file), entry.isDirectory() ? 'directory' : fs.readFileSync(file, 'utf8')]);
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(home); return entries;
}
async function refusesWithoutPublication(f, options, message) {
  const home = homeSnapshot(f), events = f.events(), exclude = fs.readFileSync(path.join(f.cwd, '.git/info/exclude'));
  await assert.rejects(f.adopt(options), message);
  assert.deepEqual(homeSnapshot(f), home);
  assert.deepEqual(f.events(), events);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.git/info/exclude')), exclude);
  assert.equal(fs.existsSync(path.join(f.cwd, '.brain')), false);
  assert.equal(policyLocation(f.cwd, 'lane', f.env).file, path.join(f.cwd, '.lane.json'));
  assert.equal(inspect({ cwd: f.cwd, env: f.env }).valid, true);
}

test('firing control A: owner-authorized re-adoption supersedes an absent identical-byte baseline', async t => {
  const f = configFixture(t), old = oldBaseline(f), history = f.events();
  oldBaseline(f, 'validation');
  const result = await f.adopt();
  assert.equal(result.adopted, true);
  assert.deepEqual(f.events().slice(0, history.length), history, 'old history is immutable');
  const superseded = f.events().find(e => e.type === 'config.baseline-superseded' && e.file === old.file);
  assert.ok(superseded, 'identical bytes under a new operation require an explicit supersession');
  assert.equal(superseded.previous.operation, old.operation);
  assert.equal(superseded.previous.seq, old.seq);
  assert.equal(superseded.previous.digest, old.new_digest);
  assert.equal(contentDigest(fs.readFileSync(old.file)), old.new_digest);
  assert.ok(f.binding().adoption.completed);
  // state.mjs is byte-identical to main: its old fold ignores the additive event.
  const events = f.events(), { eventCount: allCount, ...all } = fold(events);
  const { eventCount: knownCount, ...known } = fold(events.filter(e => e.type !== 'config.baseline-superseded'));
  assert.ok(allCount > knownCount); assert.deepEqual(all, known);
});

test('firing control B: a refused stale-baseline adopt publishes nothing and preserves legacy routes', async t => {
  const f = configFixture(t);
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  // A baseline outside the answered scope must refuse, even with identical bytes.
  oldBaseline(f);
  const before = f.events(), exclude = fs.readFileSync(path.join(f.cwd, '.git/info/exclude'));
  await assert.rejects(f.adopt(), /audited revision|baseline.*changed|supersession/);
  assert.equal(fs.existsSync(path.join(f.home, '.herdr-monitor')), false, 'refusal must not leave identity.json, identity .org or a partial project folder');
  assert.deepEqual(f.events(), before);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.git/info/exclude')), exclude);
  for (const file of ['.brain', '.git/sessions/standard-slots.json', '.git/sessions/controller-journal.json'])
    assert.equal(fs.existsSync(path.join(f.cwd, file)), false, file);
  assert.equal(policyLocation(f.cwd, 'lane', f.env).file, path.join(f.cwd, '.lane.json'));
});

test('custom identity re-adoption supersedes missing identity and different-byte project baselines exactly once', async t => {
  const f = configFixture(t, { custom: 'bastian' });
  const oldIdentity = oldBaseline(f, 'identity', { bytes: Buffer.from(JSON.stringify({ identity_root: f.ownerRoot, main: 'old-main' })) });
  const oldProject = oldBaseline(f, 'lane', { bytes: Buffer.from('{"main":"old-main"}') });
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  const entries = f.scope.scope.migration.supersedes;
  for (const old of [oldIdentity, oldProject]) {
    const entry = entries.find(e => e.file === old.file);
    assert.deepEqual({ operation: entry.operation, seq: entry.seq, digest: entry.digest, observed_digest: entry.observed_digest },
      { operation: old.operation, seq: old.seq, digest: old.new_digest, observed_digest: null });
  }
  await f.adopt();
  const record = path.join(path.dirname(oldIdentity.file), '.org');
  for (const [events, old] of [[auditEvents(record), oldIdentity], [f.events(), oldProject]]) {
    const retired = events.filter(e => e.type === 'config.baseline-superseded' && e.file === old.file);
    assert.equal(retired.length, 1);
    assert.deepEqual(retired[0].previous, { operation: old.operation, seq: old.seq, digest: old.new_digest });
    assert.equal(retired[0].scope_sha256, digest(f.scope.scope));
    assert.deepEqual(retired[0].authorization, f.binding().adoption.authorization);
    assert.ok(events.some(e => e.seq === old.seq && e.operation === old.operation));
  }
  const projectEvents = f.events(), identityEvents = auditEvents(record);
  await f.adopt();
  assert.deepEqual(f.events(), projectEvents); assert.deepEqual(auditEvents(record), identityEvents);
});

test('retained unbound policy bytes are digest-bound and replaced only by an answered supersession', async t => {
  const f = configFixture(t), old = oldBaseline(f), retained = Buffer.from('{"main":"retained-rollback"}\n');
  fs.mkdirSync(path.dirname(old.file), { recursive: true }); fs.writeFileSync(old.file, retained);
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  assert.equal(f.scope.scope.migration.supersedes[0].observed_digest, contentDigest(retained));
  const scopeDigest = digest(f.scope.scope);
  await f.adopt();
  assert.equal(contentDigest(fs.readFileSync(old.file)), old.new_digest);
  const retired = f.events().find(e => e.type === 'config.baseline-superseded');
  assert.equal(retired.observed_digest, contentDigest(retained)); assert.equal(retired.scope_sha256, scopeDigest);
});

test('changed observed bytes and later audit revisions invalidate a captured supersession before publication', async t => {
  const f = configFixture(t), old = oldBaseline(f);
  fs.mkdirSync(path.dirname(old.file), { recursive: true }); fs.writeFileSync(old.file, '{"main":"first-rollback"}');
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  fs.writeFileSync(old.file, '{"main":"second-rollback"}');
  await refusesWithoutPublication(f, {}, /baseline changed since owner supersession scope capture/);
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  oldBaseline(f, 'lane', { operation: 'adopt-another:lane' });
  await refusesWithoutPublication(f, {}, /baseline changed since owner supersession scope capture/);
});

test('supersession file, operation, seq and digest are covered by the scope digest and checked against history', async t => {
  const f = configFixture(t); oldBaseline(f);
  const captured = await f.capture(), originalDecision = f.question(captured.scope);
  for (const [key, value] of [['file', path.join(f.scratch, 'foreign.json')], ['operation', 'adopt-other:lane'], ['seq', 999], ['digest', 'f'.repeat(64)]]) {
    const scope = structuredClone(captured.scope); scope.migration.supersedes[0][key] = value;
    assert.notEqual(digest(scope), digest(captured.scope), key);
    const scopeFile = path.join(f.cwd, '.git/config-home/scopes', `${digest(scope)}.json`);
    fs.writeFileSync(scopeFile, JSON.stringify(scope));
    f.scope = { scope, scopeFile }; f.decision = originalDecision;
    await refusesWithoutPublication(f, {}, /owner answer does not authorize/);
    f.decision = f.question(scope);
    await refusesWithoutPublication(f, {}, /supersession/);
  }
});

for (const replaced of [false, true]) test(`supersession retries after interruption ${replaced ? 'after' : 'before'} replacement without losing or duplicating history`, async t => {
  const f = configFixture(t); oldBaseline(f, 'lane', { operation: 'adopt-even-earlier:lane' });
  const old = oldBaseline(f), rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = function(from, to) {
    if (!interrupted && path.basename(to) === path.basename(old.file)) {
      interrupted = true;
      if (replaced) rename.call(this, from, to);
      throw Error('supersession write interrupted');
    }
    return rename.call(this, from, to);
  };
  try { await assert.rejects(f.adopt(), /supersession write interrupted/); }
  finally { fs.renameSync = rename; }
  assert.equal(interrupted, true);
  const before = f.events();
  assert.equal(before.filter(e => e.type === 'config.baseline-superseded').length, 1);
  await f.adopt();
  assert.deepEqual(f.events().slice(0, before.length), before);
  assert.equal(f.events().filter(e => e.type === 'config.baseline-superseded').length, 1);
  assert.equal(f.events().filter(e => e.type === 'config.changed' && e.file === old.file).length, 3);
});

for (const target of ['identity', 'pin']) test(`a conflicting ${target} intent refuses before any identity or project publication`, async t => {
  const f = configFixture(t); f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  const root = path.join(f.home, '.herdr-monitor', f.scope.scope.identity);
  const record = target === 'identity' ? path.join(root, '.org') : f.env.ORG_DIR;
  if (target === 'identity') initOrg(record);
  const file = path.join(root, ...(target === 'identity' ? ['identity.json'] : ['project', 'pin']));
  transact(record, () => ({ add: [{ type: 'config.change-intent', file, operation: 'unfinished-config', new_digest: 'a'.repeat(64) }] }));
  await refusesWithoutPublication(f, {}, /conflicting config intent/);
});

test('a changed second native observation refuses before publication', async t => {
  const f = configFixture(t); f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  let count = 0;
  const observer = { observe: async () => {
    const observation = structuredClone(f.observation);
    if (++count === 2) observation.agents[0].agent_session.value = 'replaced-conversation';
    return observation;
  } };
  await refusesWithoutPublication(f, { observer }, /scope changed before publication|same project supervisor/);
  assert.equal(count, 2);
});

test('a competing KEEP layout refuses without changing existing enrollment or publishing config', async t => {
  const f = configFixture(t); f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  const slot = structuredClone(f.scope.scope.slots[0].slot); slot.panes[0].pane = 'other-pane';
  recordStandardSlot({ cwd: f.cwd, action: 'adopt', uid: 'competing-slot', actor: 'fixture', why: 'existing KEEP', slot });
  const file = path.join(f.cwd, '.git/sessions/standard-slots.json'), bytes = fs.readFileSync(file);
  await refusesWithoutPublication(f, {}, /existing KEEP layout conflicts/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(f.cwd, '.git/sessions/controller-journal.json')), false);
});

test('an incomplete new binding ignores the old operation audit when selecting unpublished policy', async t => {
  const f = configFixture(t); oldBaseline(f);
  await assert.rejects(f.adopt({ afterPublish(kind) { if (kind === 'binding') throw Error('binding write interrupted'); } }), /binding write interrupted/);
  assert.deepEqual(f.binding().published, []); assert.equal(f.binding().adoption.completed, undefined);
  assert.equal(policyLocation(f.cwd, 'lane', f.env).file, path.join(f.cwd, '.lane.json'));
  assert.equal(inspect({ cwd: f.cwd, env: f.env }).valid, true);
  await f.adopt(); assert.ok(f.binding().adoption.completed);
});

test('bare identity and empty project directories never select a home policy without a binding', async t => {
  const f = configFixture(t), identity = projectIdentity(gitProject(f.cwd), f.env).name;
  const area = path.join(f.home, '.herdr-monitor', identity, 'project'); fs.mkdirSync(area, { recursive: true });
  for (const kind of ['lane', 'validation', 'promote', 'housekeeping', 'pin']) assert.equal(policyLocation(f.cwd, kind, f.env).home, false);
  assert.equal(inspect({ cwd: f.cwd, env: f.env }).valid, true);
  await f.adopt(); assert.ok(f.binding().adoption.completed);
});

test('a completed adoption rolled back outside the audit can be re-adopted with unchanged shared identity bytes', async t => {
  const f = configFixture(t); await f.adopt();
  const old = f.binding(), prior = f.events(), identityEvents = auditEvents(path.join(path.dirname(old.identityFile), '.org'));
  const identityBytes = fs.readFileSync(old.identityFile), identityInode = fs.statSync(old.identityFile).ino;
  const evidence = path.join(f.scratch, 'rollback-evidence'); fs.mkdirSync(evidence);
  fs.renameSync(old.directory, path.join(evidence, 'project'));
  fs.renameSync(path.join(old.common, 'sessions'), path.join(evidence, 'sessions'));
  fs.unlinkSync(path.join(f.cwd, '.brain'));
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  assert.notEqual(digest(f.scope.scope), old.adoption.scope_sha256);
  await f.adopt();
  assert.deepEqual(f.events().slice(0, prior.length), prior);
  assert.deepEqual(fs.readFileSync(old.identityFile), identityBytes);
  assert.equal(fs.statSync(old.identityFile).ino, identityInode);
  const events = auditEvents(path.join(path.dirname(old.identityFile), '.org'));
  assert.deepEqual(events.slice(0, identityEvents.length), identityEvents);
  const retired = events.filter(e => e.type === 'config.baseline-superseded');
  assert.equal(retired.length, 1); assert.equal(retired[0].previous.operation, `${old.adoption.id}:identity`);
  assert.equal(retired[0].previous.digest, retired[0].new_digest);
  assert.equal(f.events().filter(e => e.type === 'config.adopted').length, 2);
});

test('a project lock refusal removes only its own newly created preparation directories', async t => {
  const f = configFixture(t); f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  const mkdir = fs.mkdirSync; let locks = 0;
  fs.mkdirSync = function(file, ...args) {
    if (path.basename(String(file)) === '.config.lock' && ++locks === 2) throw Object.assign(Error('project config lock busy'), { code: 'EEXIST' });
    return mkdir.call(this, file, ...args);
  };
  try { await refusesWithoutPublication(f, {}, /project config lock busy/); }
  finally { fs.mkdirSync = mkdir; }
  assert.equal(locks, 2); assert.equal(fs.existsSync(path.join(f.home, '.herdr-monitor')), false);
});

test('a refused invocation without an owner answer leaves no scope, controller or config publication', async t => {
  const f = configFixture(t), events = f.events();
  await assert.rejects(adopt({ ...f.options, expiresAt: new Date(Date.now() + 3600000).toISOString() }), /requires the affirmative workspace owner answer/);
  assert.deepEqual(f.events(), events);
  for (const file of ['.brain', '.git/config-home', '.git/sessions']) assert.equal(fs.existsSync(path.join(f.cwd, file)), false, file);
  assert.equal(fs.existsSync(path.join(f.home, '.herdr-monitor')), false);
});

test('unrelated files in an unbound destination remain a collision with no publication', async t => {
  const f = configFixture(t); f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  const area = path.join(f.home, '.herdr-monitor', f.scope.scope.identity, 'project'); fs.mkdirSync(area, { recursive: true });
  fs.writeFileSync(path.join(area, 'keep.txt'), 'unrelated owner data');
  await refusesWithoutPublication(f, {}, /project name collision/);
});

test('standalone routing with invalid effective desk references refuses before publication', async t => {
  const f = configFixture(t, { routing: true });
  const parent = path.join(f.ownerRoot, '.lane.json'), defaults = JSON.parse(fs.readFileSync(parent));
  fs.writeFileSync(parent, JSON.stringify({ ...defaults, settle: { review_route: 'review' } }));
  fs.writeFileSync(path.join(f.cwd, 'routing.json'), JSON.stringify({ dispatch: { kind: 'codex' }, routes: { engineer: { kind: 'codex' } } }));
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  await refusesWithoutPublication(f, {}, /unknown route.*review|review.*not found/);
});

test('refused direct and command adoption do not audit shared hand edits during preflight; ordinary reads still do', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), changed = { ...binding.defaults, main: 'hand-edited-default' };
  fs.writeFileSync(binding.identityFile, JSON.stringify(changed));
  const home = homeSnapshot(f), events = f.events();
  await assert.rejects(f.adopt({ decision: { id: 'HUM-999', seq: 999 } }));
  await assert.rejects(adoptCommand(['.', '--scope', f.scope.scopeFile, '--decision', 'HUM-999:999'], f.options));
  assert.deepEqual(homeSnapshot(f), home); assert.deepEqual(f.events(), events);
  policyLocation(f.cwd, 'lane', f.env);
  assert.equal(auditEvents(path.join(path.dirname(binding.identityFile), '.org')).at(-1).origin, 'hand-edit');
});

test('adoption release selection and forwarding do not publish a hand-edit audit before a refused command', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(); fs.writeFileSync(binding.identityFile, JSON.stringify({ ...binding.defaults, main: 'unapproved-hand-edit' }));
  const home = homeSnapshot(f), events = f.events();
  const releases = pathToFileURL(path.join(f.bundle, 'lib/releases.mjs')).href;
  for (const entry of ['runRelease', 'forwardRelease']) {
    const script = `import { ${entry} } from ${JSON.stringify(releases)};
      process.argv[1] = 'fixture-forwarder.mjs'; process.argv[2] = 'adopt';
      const result = ${entry === 'runRelease'
        ? `runRelease('bin/org.mjs', ['adopt', '.', '--scope', ${JSON.stringify(f.scope.scopeFile)}, '--decision', 'HUM-999:999'], { cwd: ${JSON.stringify(f.cwd)}, home: ${JSON.stringify(f.installationHome)} })`
        : `forwardRelease('bin/org.mjs', ${JSON.stringify(f.cwd)})`};
      process.exitCode = result ?? 0;`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, entry === 'runRelease' ? 1 : 0, result.stdout + result.stderr);
    assert.deepEqual(homeSnapshot(f), home, entry); assert.deepEqual(f.events(), events, entry);
  }
});
