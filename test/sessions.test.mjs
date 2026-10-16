import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseManifest, validateManifest, validateSet } from '../sessions/manifest.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { canonicalProject } from '../sessions/project.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { readStandardSlots, recordStandardSlot, slotReceiptFile } from '../sessions/receipts.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';
import { copyProduct, productFiles } from '../lib/product-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = name => parseManifest(fs.readFileSync(path.join(root, `test/fixtures/sessions/${name}.md`), 'utf8'));
const document = value => `# prose\n\n## Manifest\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
const validate = (m, project = { root: fs.realpathSync(os.tmpdir()) }, config = ROUTE_PRESET) => validateManifest(m, { config, project });
function repo(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const main = path.join(scratch, 'repo'), lane = path.join(scratch, 'lane'); fs.mkdirSync(main);
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(main, '.lane.json'), '{}'); git('add', '.'); git('commit', '-qm', 'init'); git('worktree', 'add', '-b', 'lane/topic', lane);
  return { scratch, main, lane, git, project: canonicalProject(lane), env: { ...process.env, HERDR_MONITOR_FLEET: path.join(scratch, 'no-fleet'), LANE_CONFIG: undefined } };
}
function modify(m, key, value, remove = false) {
  const parts = key.split('.'), last = parts.pop(); let target = m;
  for (const part of parts) target = target[part];
  if (remove) delete target[last]; else target[last] = value;
}

for (const name of ['chat', 'supervisor', 'engineer-worker', 'reviewer', 'logs-viewer', 'logs-triage']) test(`adopted example: ${name}`, () => {
  const m = fixture(name), result = validate(m, name === 'reviewer' ? { root } : undefined);
  assert.equal(result.manifest, m); assert.deepEqual(result.diagnostics, []);
  if (m.kind === 'Session') assert.equal(result.resolvedSpec.resolvedRoute.route, m.spec.route);
});
const negatives = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/sessions/negative.json'), 'utf8'));
for (const negative of negatives) test(`manifest rejects ${negative.name}`, () => {
  const m = fixture(negative.base);
  for (const [key, value] of Object.entries(negative.set ?? {})) modify(m, key, value);
  for (const key of negative.delete ?? []) modify(m, key, undefined, true);
  assert.throws(() => validate(parseManifest(document(m)), negative.base === 'reviewer' ? { root } : undefined), new RegExp(negative.error));
});

test('shipped reviewer references the authoritative personality and has a round-specific lifecycle', () => {
  const m = parseManifest(fs.readFileSync(path.join(root, 'sessions/templates/reviewer.md'), 'utf8')), s = m.spec;
  assert.deepEqual(m, fixture('reviewer'));
  assert.equal(s.role, 'reviewer'); assert.equal(s.intent.kind, 'work-item'); assert.equal(s.intent.item, 'ENG-232');
  assert.equal(s.route, 'review'); assert.equal(s.launch, undefined);
  assert.equal(s.personality.profile, 'lane-reviewer'); assert.match(s.personality.instructions, /lanes\/docs\/REVIEW_TEMPLATE\.md/);
  for (const source of ['identity-instructions', 'run-brief', 'item-lessons']) assert.ok(s.context.some(c => c.source === source && c.required));
  assert.ok(s.context.some(c => c.source === 'latest-review'));
  assert.ok(s.context.some(c => c.source === 'file' && c.path === 'lanes/docs/REVIEW_TEMPLATE.md' && c.required));
  assert.equal(s.permissions.owner, 'native'); assert.equal(s.permissions.profileRef, 'read-only');
  assert.deepEqual(s.tools, { input: 'preloaded-scoped-files', allowed: ['write-own-review-output'] });
  const l = s.lifecycle;
  assert.equal(l.afterReport, 'park-awaiting-verdict-ingestion'); assert.equal(l.retainUntil, 'verdict-ingested-or-explicit-disposition');
  assert.equal(l.corrections, 'new-reviewer-session'); assert.equal(l.reset, 'never-before-verdict-ingestion'); assert.equal(l.resetWhileParked, false);
  assert.deepEqual(validate(m, { root }).diagnostics, []);
  const engineer = fixture('engineer-worker'); engineer.spec.lifecycle = structuredClone(l);
  assert.throws(() => validate(engineer), /engineer lifecycle must retain through review and corrections/);
});

test('reviewer resolves review variants and project override routes without fixing a model', () => {
  const m = fixture('reviewer'), config = structuredClone(ROUTE_PRESET);
  config.routes['project-review'] = { kind: 'codex', model: 'project-selected-model', effort: 'high' };
  config.settle = { review_route: 'project-review' };
  for (const route of ['review', 'review-codex', 'review-max', config.settle.review_route]) {
    m.spec.route = route;
    const resolved = validate(m, { root }, config).resolvedSpec.resolvedRoute;
    assert.equal(resolved.route, route); assert.equal(resolved.model, config.routes[route].model);
  }
});

test('Markdown fences and duplicate decoded keys are parsed without evaluating prose', () => {
  const m = fixture('chat'), valid = document(m);
  assert.deepEqual(parseManifest('$(touch no)\n' + valid + '\n## Notes\n```json\n{}\n```'), m);
  for (const text of ['', '```json\n{}\n```', '## Manifest\n', valid + '\n```json\n{}\n```', valid + '\n## Manifest\n', '## Manifest\n```json\n{}']) assert.throws(() => parseManifest(text));
  assert.throws(() => parseManifest('## Manifest\n```json\n{"x":1,"\\u0078":2}\n```'), /duplicate JSON key/);
  assert.throws(() => parseUniqueJson('{"a":{"x":1,"x":2}}'), /duplicate/);
  assert.deepEqual(parseUniqueJson('{"a":{"x":1},"b":{"x":2},"c":["a\\\"b",true,null,-2.3e2]}'), { a: { x: 1 }, b: { x: 2 }, c: ['a"b', true, null, -230] });
  for (const invalid of ['{"x":1,}', '{"x":01}', '{"x":true false}', '[1 2]', '{} trailing']) assert.throws(() => parseUniqueJson(invalid));
  assert.throws(() => parseUniqueJson('['.repeat(66) + '0' + ']'.repeat(66)), /nesting/);
});

for (const info of ['JSON', 'jsonc', '', 'text']) test(`Manifest section rejects an extra ${info || 'unlabelled'} fence`, () => {
  const valid = document(fixture('chat'));
  assert.throws(() => parseManifest(`${valid}\n~~~${info}\n{}\n~~~\n`), /exactly one fenced block labelled json/);
});

test('context paths require an explicit canonical project diagnostic instead of a TypeError', () => {
  const m = fixture('chat');
  assert.deepEqual(validateManifest(m, { config: ROUTE_PRESET }).diagnostics, [], 'symbolic context does not require project paths');
  for (const required of [true, false]) {
    m.spec.context = [{ source: 'file', required, path: 'context.md' }];
    const diagnostic = error => error instanceof Error && !(error instanceof TypeError) && error.message === 'context path validation requires a canonical project';
    assert.throws(() => validateManifest(m), diagnostic);
    for (const project of [undefined, null, {}, { root: 123 }, { root: 'relative' }]) assert.throws(() => validateManifest(m, { config: ROUTE_PRESET, project }), diagnostic);
  }
});

test('required/optional paths are bounded to the canonical project, including missing and dangling symlinks', t => {
  const f = repo(t), m = fixture('chat');
  const set = (p, required = false) => { m.spec.context = [{ source: 'file', path: p, required }]; return () => validate(m, f.project); };
  fs.writeFileSync(path.join(f.main, 'context.md'), 'context data');
  assert.deepEqual(set('context.md', true)().diagnostics, []);
  assert.match(set('missing')().diagnostics[0].message, /optional context absent/);
  assert.throws(set('missing', true), /required context missing/);
  fs.symlinkSync(f.scratch, path.join(f.main, 'escape'));
  fs.symlinkSync('missing', path.join(f.main, 'dangling'));
  assert.throws(set('escape/no-file'), /escapes project/);
  assert.throws(set('dangling'), /dangling symlink/);
  assert.throws(set('context.md/child'), /ENOTDIR/);
});

test('set validation rejects a second project triage across namespaces, duplicate UID and duplicate pane positions', () => {
  const a = validate(fixture('logs-triage')), b = validate(fixture('logs-triage'));
  b.manifest.metadata.namespace = 'other/namespace';
  assert.deepEqual(validateSet([a, b]).map(d => d.message), ['duplicate uid example-project-logs-triage', 'duplicate standard tab/pane position', 'second logs-triage session for canonical project']);
});

test('layered route assertions and hygiene aliases validate resolved settings without model hard-coding', t => {
  const f = repo(t), config = structuredClone(ROUTE_PRESET), m = fixture('logs-triage');
  config.routes['future-replay'] = { kind: 'claude', model: 'future-candidate', effort: 'low' };
  m.spec.route = 'future-replay'; m.spec.launch = { harness: 'claude', model: 'future-candidate', effort: 'low' };
  assert.equal(validate(m, f.project, config).resolvedSpec.resolvedRoute.model, 'future-candidate');
  config.routes.alias = { ...config.routes.triage }; m.spec.route = 'alias'; delete m.spec.launch;
  assert.throws(() => validate(m, f.project, config), /preset triage/);
  fs.writeFileSync(path.join(f.scratch, '.lane.json'), JSON.stringify({ routes: { executive: { kind: 'codex', model: 'parent-model', effort: 'low' } } }));
  fs.writeFileSync(path.join(f.main, '.lane.json'), JSON.stringify({ routes: { executive: { kind: 'codex', model: 'project-model', effort: 'high' } } }));
  const file = path.join(f.scratch, 'chat.md'), chat = fixture('chat'); chat.spec.launch = { model: 'project-model', harness: 'codex', effort: 'high' }; fs.writeFileSync(file, document(chat));
  const result = inspect({ files: [file], cwd: f.lane, env: f.env });
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics)); assert.equal(result.routeFiles.length, 2);
});

for (const name of ['engineer-worker', 'reviewer']) test(`${name} inspection checks item existence in the read-only folded record and holds a torn tail`, t => {
  const f = repo(t), file = path.join(f.scratch, 'worker.md'), org = path.join(f.scratch, 'record');
  if (name === 'reviewer') {
    fs.mkdirSync(path.join(f.main, 'lanes/docs'), { recursive: true });
    fs.copyFileSync(path.join(root, 'lanes/docs/REVIEW_TEMPLATE.md'), path.join(f.main, 'lanes/docs/REVIEW_TEMPLATE.md'));
  }
  fs.mkdirSync(org); fs.writeFileSync(file, document(fixture(name)));
  const log = path.join(org, 'events.jsonl'); fs.writeFileSync(log, '');
  const run = () => inspect({ files: [file], cwd: f.lane, env: { ...f.env, ORG_DIR: org } });
  assert.match(run().diagnostics[0].message, /unknown work item/);
  const bytes = JSON.stringify({ type: 'item.added', id: 'ENG-232', kind: 'work', role: 'engineer', seq: 1 }) + '\n';
  fs.writeFileSync(log, bytes); assert.equal(run().valid, true); assert.equal(fs.readFileSync(log, 'utf8'), bytes);
  fs.appendFileSync(log, '{'); assert.match(run().diagnostics[0].message, /complete record tail/);
});

test('default templates ship, follow canonical committed overrides, and select model-free non-home status', t => {
  const f = repo(t), before = f.git('status', '--porcelain');
  const home = inspect({ cwd: f.lane, env: f.env }); assert.equal(home.valid, true, JSON.stringify(home.diagnostics)); assert.equal(home.entries.length, 4);
  assert.equal(home.entries.some(e => ['engineer', 'reviewer'].includes(e.manifest.spec.role)), false, 'work-item examples are not discovered');
  assert.equal(home.project.common, path.join(f.main, '.git')); assert.equal(home.project.root, f.main);
  const away = inspect({ cwd: f.lane, workspace: 'lane/another', env: f.env });
  assert.equal(away.valid, true, JSON.stringify(away.diagnostics)); assert.equal(away.entries.filter(e => e.manifest.spec.role === 'logs-triage').length, 0);
  assert.equal(away.entries.find(e => e.manifest.spec.role === 'triage-status').manifest.kind, 'LogViewer');
  assert.notEqual(home.entries[0].manifest.metadata.uid, away.entries[0].manifest.metadata.uid);
  fs.mkdirSync(path.join(f.main, '.sessions')); const chat = fixture('chat'); chat.metadata.name = 'project-chat'; delete chat.spec.launch;
  fs.writeFileSync(path.join(f.main, '.sessions/chat.md'), document(chat));
  const untracked = inspect({ cwd: f.lane, env: f.env });
  assert.equal(untracked.entries[0].manifest.metadata.name, 'workspace-chat', 'untracked ignored');
  assert.equal(untracked.diagnostics[0].level, 'warning'); assert.match(untracked.diagnostics[0].message, /untracked.*\.sessions\/chat.md/);
  f.git('add', '.sessions/chat.md');
  const staged = inspect({ cwd: f.lane, env: f.env });
  assert.equal(staged.entries[0].manifest.metadata.name, 'workspace-chat', 'index-only override ignored');
  assert.equal(staged.diagnostics[0].level, 'warning'); assert.match(staged.diagnostics[0].message, /uncommitted.*\.sessions\/chat.md/);
  f.git('commit', '-qm', 'Committed session override');
  const overridden = inspect({ cwd: f.lane, env: f.env }); assert.equal(overridden.entries[0].manifest.metadata.name, 'project-chat');
  assert.deepEqual(overridden.diagnostics, []);
  fs.mkdirSync(path.join(f.lane, '.sessions')); fs.writeFileSync(path.join(f.lane, '.sessions/chat.md'), 'invalid lane override');
  assert.equal(inspect({ cwd: f.lane, env: f.env }).valid, true);
  const cli = spawnSync(process.execPath, [path.join(root, 'sessions/sessions.mjs'), 'inspect', '--project', f.lane], { env: f.env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).valid, true);
  assert.equal(before, ''); assert.equal(fs.existsSync(path.join(f.main, '.git/sessions')), false, 'inspector never enrolls');
  const installed = path.join(f.scratch, 'installed'); copyProduct(root, installed);
  assert.ok(productFiles(root).includes('sessions/templates/logs-triage.md'));
  for (const file of ['sessions/templates/reviewer.md', 'lanes/docs/REVIEW_TEMPLATE.md']) assert.ok(productFiles(root).includes(file));
  const reviewer = parseManifest(fs.readFileSync(path.join(installed, 'sessions/templates/reviewer.md'), 'utf8'));
  assert.deepEqual(validate(reviewer, { root: installed }).diagnostics, [], 'copied product keeps required reviewer context without a product Git worktree');
  const copy = spawnSync(process.execPath, [path.join(installed, 'sessions/sessions.mjs'), 'inspect', '--project', f.main], { env: f.env, encoding: 'utf8' });
  assert.equal(copy.status, 0, copy.stderr);
});

test('canonical HEAD manifest bytes survive working-tree edits, staged replacements and missing files with warnings', t => {
  const f = repo(t), file = path.join(f.main, '.sessions/chat.md'), chat = fixture('chat');
  fs.mkdirSync(path.dirname(file)); chat.metadata.name = 'committed-chat'; delete chat.spec.launch;
  const committed = document(chat); fs.writeFileSync(file, committed);
  f.git('add', '.sessions/chat.md'); f.git('commit', '-qm', 'Desired session');
  const check = () => {
    const result = inspect({ cwd: f.lane, env: f.env });
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics)); assert.equal(result.entries.length, 4);
    assert.equal(result.entries[0].manifest.metadata.name, 'committed-chat');
    const warning = result.diagnostics.find(d => d.file === file);
    assert.equal(warning.level, 'warning'); assert.match(warning.message, /uncommitted.*\.sessions\/chat.md/);
    return result;
  };
  fs.writeFileSync(file, 'invalid uncommitted manifest'); check();
  f.git('add', '.sessions/chat.md'); fs.writeFileSync(file, committed);
  check(); // Working tree equals HEAD, but the index still contains different bytes.
  const added = path.join(f.main, '.sessions/additional.md'); fs.writeFileSync(added, 'invalid new manifest');
  let result = check();
  assert.match(result.diagnostics.find(d => d.file === added).message, /untracked/);
  f.git('add', '.sessions/additional.md'); result = check();
  assert.match(result.diagnostics.find(d => d.file === added).message, /uncommitted/);
  fs.unlinkSync(file); check();
});

test('an unborn canonical project uses defaults and warns about uncommitted manifests', t => {
  const f = repo(t); f.git('checkout', '--orphan', 'fresh');
  fs.mkdirSync(path.join(f.main, '.sessions')); fs.writeFileSync(path.join(f.main, '.sessions/chat.md'), 'uncommitted');
  const result = inspect({ cwd: f.main, env: f.env });
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics)); assert.equal(result.entries[0].manifest.metadata.name, 'workspace-chat');
  assert.match(result.diagnostics[0].message, /untracked.*\.sessions\/chat.md/);
});

test('canonical receipt history adopts and explicitly withdraws slots across linked lanes without live actions', t => {
  const f = repo(t), slot = { server: 'default', workspace: 'w', checkout: f.lane, tab: 'w:t', standardSlot: 'logs', panes: [{ pane: 'w:p', paneSlot: 'viewer' }, { pane: 'w:q', paneSlot: 'triage' }] };
  assert.deepEqual(readStandardSlots(f.project.common).slots, []);
  const op = recordStandardSlot({ cwd: f.lane, action: 'adopt', uid: 'logs', actor: 'fixture', why: 'proven offline binding', slot });
  assert.equal(op.seq, 1); assert.equal(readStandardSlots(f.project.common).slots[0].common, f.project.common);
  assert.throws(() => recordStandardSlot({ cwd: f.main, action: 'adopt', uid: 'other', actor: 'fixture', why: 'duplicate', slot }), /duplicate/);
  assert.throws(() => recordStandardSlot({ cwd: f.main, action: 'adopt', uid: 'foreign', actor: 'fixture', why: 'wrong checkout', slot: { ...slot, checkout: f.scratch } }));
  recordStandardSlot({ cwd: f.main, action: 'withdraw', uid: 'logs', actor: 'fixture', why: 'explicit disposition with handoff' });
  assert.deepEqual(readStandardSlots(f.project.common).slots, []);
  const history = JSON.parse(fs.readFileSync(slotReceiptFile(f.project.common), 'utf8'));
  assert.deepEqual(history.operations.map(o => o.action), ['adopt', 'withdraw']);
  assert.throws(() => recordStandardSlot({ cwd: f.main, action: 'withdraw', uid: 'missing', actor: 'fixture', why: 'unknown' }), /adopted/);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('unknown, unreadable, duplicate-key and mismatched canonical receipts fail closed', t => {
  const f = repo(t), file = slotReceiptFile(f.project.common); fs.mkdirSync(path.dirname(file));
  for (const value of ['{', '{"schema":"future/v2"}', JSON.stringify({ schema: 'standard-slot-history/v1', common: '/foreign/.git', operations: [] }), '{"schema":1,"schema":2}']) {
    fs.writeFileSync(file, value); assert.match(readStandardSlots(f.project.common).errors[0], /project kept/);
  }
  fs.unlinkSync(file); fs.mkdirSync(file); assert.match(readStandardSlots(f.project.common).errors[0], /regular file/);
  fs.rmdirSync(file); fs.symlinkSync('missing', file); assert.match(readStandardSlots(f.project.common).errors[0], /regular file/);
  fs.unlinkSync(file); fs.mkdirSync(path.join(path.dirname(file), 'standard-slots.lock'));
  assert.match(readStandardSlots(f.project.common).errors[0], /lock unresolved/);
});
