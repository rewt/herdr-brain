import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createLineService, sourceRoot, serviceDirectory } from '../line-service/line-service.mjs';
import { bindReviewTarget, reviewAttempt, selectedReviewConsumer } from '../line-service/review.mjs';
import { DEFAULT_CONFIG } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { fold } from '../lib/state.mjs';

function fixture(t, { admission = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-review-'))), repo = path.join(root, 'project'), workspace = path.join(root, 'lane');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(repo);
  const git = (args, cwd = repo) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Review fixture']); git(['config', 'user.email', 'review@example.invalid']);
  fs.writeFileSync(path.join(repo, 'code.mjs'), 'export const value = 0;\n'); git(['add', '.']); git(['commit', '-qm', 'Baseline']);
  const base = git(['rev-parse', 'HEAD']); git(['worktree', 'add', '-qb', 'lane/topic', workspace]);
  const commit = value => { fs.writeFileSync(path.join(workspace, 'code.mjs'), `export const value = ${value};\n`); git(['add', 'code.mjs'], workspace); git(['commit', '-qm', 'Implementation'], workspace); return git(['rev-parse', 'HEAD'], workspace); };
  const head = admission ? base : commit(1), org = path.join(repo, '.org'); if(!admission)git(['merge','--ff-only',head]); fs.mkdirSync(path.join(org, 'reports'), { recursive: true }); fs.mkdirSync(path.join(org, 'dispatch'));
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n.org/\n.lane/\n'); fs.writeFileSync(path.join(org, 'config.json'), JSON.stringify(DEFAULT_CONFIG));
  const identity = gitProject(repo).identity, owner = { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root: fs.realpathSync(sourceRoot), identity: gitProject(sourceRoot).identity } };
  const journal = path.join(org, 'dispatch', 'fixture.json'), artifacts = [`Commit: ${head}`, 'code.mjs'];
  const text = `---\nrun: R-1\noutcome: blocked\nsummary: Committed implementation with red development evidence.\nartifacts:\n  - "Commit: ${head}"\n  - code.mjs\n---\n`;
  fs.writeFileSync(path.join(org, 'reports/R-1.md'), text);
  const hash = createHash('sha256').update(text).digest('hex');
  const boundary = {id:'fixture-cutover',project:identity,repo,org,source:fs.realpathSync(sourceRoot),main:'main',canonical_head:base};
  const events = [
    // The prior boundary is the real base, not the already-landed fixture head.
    ...['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type})),
    { type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'Implement', meta: {}, seq: 1 },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace, meta: { lane: 'topic', dispatch_journal: journal, dispatch_attempt: 'fixture' }, seq: 2 },
    { type: 'run.claimed', run: 'R-1', owner, record: org, project: identity, seq: 3 },
    { type: 'report.ingested', run: 'R-1', item: 'ENG-1', sha256: hash, file: 'reports/R-1.md', report: { outcome: 'blocked', summary: 'Committed code, tests red', artifacts, blockers: [], extra: { validation: { exit_code: 1 } } }, seq: 4 },
  ];
  const write = () => fs.writeFileSync(path.join(org, 'events.jsonl'), events.map((e,i) => {e.seq=i+1;return JSON.stringify({ at: '2026-10-26T18:00:00Z', by: 'fixture', ...e });}).join('\n') + '\n');
  // Review steps mutate only through an installed service binding, as in production.
  const directory = serviceDirectory(org, identity); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(root, '.identity-root'), 'fixture\n');
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ at: '2026-10-27T00:00:00Z', repo, org, source: sourceRoot, node: process.execPath, file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` }));
  const env = { ...process.env }; for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'CODEX_THREAD_ID']) delete env[key];
  write(); fs.writeFileSync(journal, JSON.stringify({ token: 'fixture', stage: 'complete', run: 'R-1', item: 'ENG-1', org, common: identity, workspace, base }));
  const context = () => { const state = fold(events); return { repo, org, identity, events, state, item: state.items.get('ENG-1'), run: state.runs.get('R-1') }; };
  const calls = [], notices = [];
  const service = options => createLineService({ repo, org, to: 'test-supervisor', env, command: (exe, args) => { calls.push({ exe, args }); return { status: 0, stdout: JSON.stringify({ result: 'review_pending', item: 'ENG-1', run: 'R-1', head: args[args.indexOf('--head') + 1] }), stderr: '' }; }, recordNotice: data => { notices.push(data.reason); return { id:data.id,state:'record-only' }; }, ...options });
  return { root, repo, org, workspace, base, head, events, write, context, service, calls, notices, git, commit };
}

for (const directory of ['current', 'foreign']) for (const root of [null, false, 0, '']) {
  test(`service journal correction preserves ${JSON.stringify(root)} in ${directory} before automatic effects`, t => {
    const f = fixture(t), s = f.service(), file = path.join(directory === 'current'
      ? s.directory : path.join(f.org, 'line-service/foreign'), 'effects.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = ` ${JSON.stringify(root)}\n`, events = fs.readFileSync(path.join(f.org, 'events.jsonl'));
    fs.writeFileSync(file, bytes);
    if (directory === 'current') assert.throws(() => s.pass(), /absence UNKNOWN/);
    else s.pass();
    assert.equal(f.calls.length, 0, 'no queue or native helper is invoked');
    const after = fs.readFileSync(path.join(f.org, 'events.jsonl'));
    assert.deepEqual(after.subarray(0, events.length), events, 'existing record history stays immutable');
    const added = after.subarray(events.length).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(added.map(e => e.type), directory === 'current' ? [] : ['line-service.review-error', 'line-service.review-health']);
    if (directory === 'foreign') {
      assert.match(added[0].reason, /absence UNKNOWN/);
      assert.equal(added[0].scope.head, f.head);
      assert.equal(added[1].queued, 0);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  });
}

test('automatic review binds committed changed evidence despite blocked outcome and red tests', t => {
  const f = fixture(t), target = bindReviewTarget(f.context());
  assert.equal(target.head, f.head); assert.equal(target.base, f.base); assert.ok(target.diff_sha256);
  assert.equal(reviewAttempt(f.context().item, f.context()), null);
  const s = f.service(); s.pass(); s.pass();
  assert.equal(f.calls.length, 1); const args = f.calls[0].args;
  assert.equal(args[1], 'queue-review');
  assert.equal(args[args.indexOf('--head') + 1], f.head);
  assert.equal(args[args.indexOf('--base') + 1], f.base);
  const effects = JSON.parse(fs.readFileSync(path.join(s.directory, 'effects.json')));
  assert.equal(effects.actions[`review:ENG-1:${f.head}`].review_target.reportHash, target.reportHash);
});

test('automatic review holds blocked uncommitted admission source before any helper launch', t => {
  const f = fixture(t, { admission: true }); fs.writeFileSync(path.join(f.workspace, 'code.mjs'), 'draft\n'.repeat(187));
  assert.throws(() => bindReviewTarget(f.context()), /admission HEAD/);
  f.service().pass(); assert.equal(f.calls.length, 0); assert.equal(f.notices.length,0);
});

for (const kind of ['pending', 'native', 'manual', 'decision', 'unknown', 'legacy']) {
  test(`automatic review retains pending manual ambiguous and UNKNOWN item attempts across heads runs and restarts: ${kind}`, t => {
    const f = fixture(t), c = f.context();
    if (kind === 'pending') {
      fs.mkdirSync(path.join(f.org, 'line-service/older-head'), { recursive: true });
      fs.writeFileSync(path.join(f.org, 'line-service/older-head/effects.json'), JSON.stringify({ actions: { 'review:ENG-1': { state: 'complete', result: { result: 'review_pending', run: 'R-older', head: f.head } } } }));
    } else if (kind === 'native') {
      fs.mkdirSync(path.join(f.org, 'retirement/occupants'), { recursive: true }); fs.writeFileSync(path.join(f.org, 'retirement/occupants/native.json'), JSON.stringify({ kind: 'settle', run: 'R-1', common: c.identity, qualification: 'UNKNOWN' }));
    } else if (kind === 'manual') {
      fs.mkdirSync(path.join(f.org, 'evidence/ENG-1/owner'), { recursive: true }); fs.writeFileSync(path.join(f.org, 'evidence/ENG-1/owner/review-launch.json'), JSON.stringify({ item: 'ENG-1', native_qualification: 'UNKNOWN' }));
    } else if (kind === 'decision') f.events.push({ type: 'note.added', id: 'ENG-1', seq: 5, decision: true, text: 'C1 retained reviewer; qualification UNKNOWN; do not replace' });
    else if (kind === 'unknown') { fs.mkdirSync(path.join(f.org, 'retirement/reviews'), { recursive: true }); fs.writeFileSync(path.join(f.org, 'retirement/reviews/unmapped.json'), '{"qualification":"UNKNOWN"}'); }
    else { const claim=f.events.find(e=>e.type==='run.claimed');claim.owner = { ...claim.owner, legacy: true }; }
    const unbound = kind === 'manual' || kind === 'unknown';
    const evidence = kind === 'manual' ? path.join(f.org, 'evidence/ENG-1/owner/review-launch.json') : kind === 'unknown' ? path.join(f.org, 'retirement/reviews/unmapped.json') : null;
    const original = evidence && fs.readFileSync(evidence);
    f.write(); const next = f.context();
    try { assert.ok(reviewAttempt(next.item, next)); } catch (e) { assert.match(e.message, /UNKNOWN|unmapped/); }
    // Unattributed UNKNOWN evidence stays visible; it cannot hold this commit.
    if (unbound) assert.equal(reviewAttempt(next.item, { ...next, target: bindReviewTarget(next) }), null);
    f.service().pass(); f.service().pass(); assert.equal(f.calls.length, unbound ? 1 : 0, kind);
    if (unbound) {
      assert.equal(f.calls[0].args[1], 'queue-review');
      assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--head') + 1], f.head);
    }
    if (evidence) assert.deepEqual(fs.readFileSync(evidence), original);
  });
}

test('automatic immutable capture ignores subsequent engineer head movement and cleanup', t => {
  const f = fixture(t), target = bindReviewTarget(f.context()); f.commit(2); f.git(['worktree', 'remove', '--force', f.workspace]);
  assert.deepEqual(bindReviewTarget(f.context()), target);
  assert.match(f.git(['show', `${target.head}:code.mjs`]), /value = 1/);
});

test('automatic review holds old saved or forwarded adopted consumers before launch capability is assumed', t => {
  const f = fixture(t), c = f.context(), old = path.join(f.root, 'old-consumer'); fs.mkdirSync(old);
  assert.throws(() => selectedReviewConsumer({ ...c, run: { ...c.run, owner: { ...c.run.owner, release: { ...c.run.owner.release, root: old } } } }), /saved review helper capability/);
  assert.throws(() => selectedReviewConsumer({ ...c, resolve: () => old }), /selected\/pinned consumer cannot certify/);
  assert.equal(f.calls.length, 0);
});

test('settled history sweep has constant identity work and bounded log rows while retaining current UNKNOWN review', t => {
  const f = fixture(t);
  f.events.push({ type: 'note.added', id: 'ENG-1', seq: 5, decision: true, text: 'Retained reviewer qualification UNKNOWN; keep' });
  for (let n = 0; n < 2035; n++) {
    const item = `OLD-${n}`, run = `OLD-R-${n}`, seq = 6 + n * 4;
    f.events.push({ type: 'item.added', id: item, title: 'Settled history', meta: {}, seq }, { type: 'run.started', id: run, item, workspace: `/gone-history/${n}`, report_path: `/gone-history/${n}/report.md`, meta: {}, seq: seq + 1 },
      { type: 'report.ingested', run, item, file: `old/${n}.md`, sha256: 'a'.repeat(64), report: { outcome: 'done', artifacts: [] }, seq: seq + 2 }, { type: 'item.closed', id: item, as: 'done', seq: seq + 3 });
  }
  f.write(); let identities = 0, historicalReads = 0;
  const exists = fs.existsSync; fs.existsSync = file => { if (String(file).startsWith('/gone-history/')) historicalReads++; return exists(file); };
  let s;
  try { s = f.service({ identify: cwd => { identities++; return gitProject(cwd); } }); s.pass(); } finally { fs.existsSync = exists; }
  assert.equal(identities, 2); assert.equal(historicalReads, 0); assert.equal(f.calls.length, 0);
  const rows = fs.readFileSync(path.join(s.directory, 'passes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.length <= 4, JSON.stringify(rows, null, 2));
  const retained = rows.find(r => r.action === 'review-retained'); assert.ok(retained);
  assert.equal(retained.notice_record.entry.count, 1);
  assert.equal(retained.notice_record.entry.scope.head, f.head);
  assert.equal(rows.find(r => r.action === 'review-health').errors.occurrences, 1);
  const timing = rows.find(r => r.action === 'pass-complete').timing;
  assert.equal(timing.snapshots, 1); assert.equal(timing.historical_intake_skipped, 2035); assert.equal(timing.effect_command_ms, 0);
});
