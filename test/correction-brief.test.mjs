import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, isolatedEnv } from './helpers/retire-fixture.mjs';
import { loadEvents, transact, DEFAULT_CONFIG } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { correctionSource } from '../lib/report-closeout.mjs';
import { reviewResultEvents } from '../line-service/phase1.mjs';
import { createWorkerBrief, lineWorkerPrompt } from '../lib/worker-brief.mjs';
import { renderBrief } from '../lib/render.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const major = 'codec.mjs:41 - Reject invalid source paths';
const second = 'codec.mjs:52 - Preserve source ownership';
const minor = 'codec.mjs:60 - Explain a missing capture';
const controls = ['node test/helpers/run.mjs test/codec.test.mjs; invalid paths refuse before effects',
  'node test/helpers/run.mjs test/owner.test.mjs; foreign owner remains unchanged'];

function context(t, { structured = true } = {}) {
  const f = fixture(t, { merged: false, occupied: false });
  isolatedEnv(t, f);
  const append = add => transact(f.org, () => ({ add }));
  const current = () => { const events = loadEvents(f.org).events; return { events, state: fold(events) }; };
  const packet = (run, saved) => {
    const bytes = JSON.stringify(saved), file = path.join(f.org, `${run}-packet.json`);
    fs.writeFileSync(file, bytes);
    append([{ type: 'closeout.effect', run, outcome: { action: 'report-evidence', packet: file, sha256: hash(bytes) } }]);
    return file;
  };
  const base = f.git(['rev-parse', 'HEAD']), diff = f.git(['diff', base, f.head]);
  const authorPacket = packet('R-1', { branch: 'lane/topic', base, head: f.head, diff,
    proof_locations: ['/proof/author-failed.tap', '/proof/author-unrun.md'],
    check: { executed: true, outcome: 'red', exit_code: 1, command: controls[0], log: '/proof/failed.log', execution_receipt: '/proof/failed.execution.json' } });
  const target = { base, head: f.head, diff_sha256: hash(diff), evidence: authorPacket, reportHash: hash(fs.readFileSync(authorPacket)) };
  append([
    { type: 'item.added', id: 'REV-1', role: 'reviewer', title: 'Review captured source', meta: {
      review_key: `ENG-1:${f.head}`, review_target: target, review_source_item: 'ENG-1', review_source_run: 'R-1', review_round_cap: 1 } },
    { type: 'run.started', id: 'R-7', item: 'REV-1', report_path: '/mutable/wrong-review.md' },
  ]);
  const report = { outcome: 'done', summary: 'FAIL with scoped controls', learnings: [], blockers: [],
    artifacts: ['/proof/reviewer-failed.tap', '/proof/reviewer-unrun.md'],
    proposals: [{ role: 'engineer', title: 'Repair all findings', accept: ['Repair all three findings'],
      ...(!structured ? { extra: { review_correction_checks: { [major]: controls[0], [second]: controls[1] } } } : {}) }],
    extra: { verdict: 'FAIL', ...(structured ? { findings: [major, second].map((text, i) => ({ severity: 'major', text, correction_check: controls[i] })) } : {}) } };
  const c = current(), facts = reviewResultEvents({ ...c, run: c.state.runs.get('R-7'), report, sha256: 'review-sha',
    body: `- [Major] ${major}\n- [Major] ${second}\n- [Minor] ${minor}` });
  append([{ type: 'report.ingested', run: 'R-7', report, file: 'reports/R-7.md', sha256: 'review-sha' }, ...facts,
    { type: 'run.started', id: 'R-8', item: 'REV-1', report_path: '/mutable/unreported-review.md' }]);
  const fix = facts.find(e => e.type === 'item.added');
  const source = () => { const c = current(); return correctionSource({ item: c.state.items.get(fix.id), ...c, repo: f.repo, org: f.org }); };
  return { ...f, append, current, packet, target, fix, source };
}

test('full fix context survives review intake and detached prompt with both reports, all findings and distinct Major controls', t => {
  for (const structured of [true, false]) {
    const f = context(t, { structured }), source = f.source(), c = f.current();
    assert.equal(source.base, f.head);
    assert.equal(source.ref, 'refs/heads/lane/topic');
    assert.match(source.brief, new RegExp(`Review report: ${f.org}/reports/R-7.md; SHA256: review-sha`));
    assert.doesNotMatch(source.brief, /mutable\/.*review/);
    for (const text of [major, second, minor, ...controls, f.target.base, f.target.head, f.target.diff_sha256,
      '/proof/author-failed.tap', '/proof/author-unrun.md', '/proof/reviewer-failed.tap', '/proof/reviewer-unrun.md',
      '/proof/failed.log', '/proof/failed.execution.json', '"outcome":"red"', '"exit_code":1']) assert.ok(source.brief.includes(text), text);
    assert.equal((source.brief.match(/\(finding /g) ?? []).length, 3, 'body/structured duplicates are one finding');
    assert.ok(source.brief.includes(`diff --no-ext-diff --no-textconv '${f.target.base}' '${f.head}'`));
    assert.equal(c.events.find(e => e.type === 'change.reviewed').verdict, 'FAIL');

    const item = c.state.items.get(f.fix.id), lane = 'fresh-fixer';
    const contract = createWorkerBrief({ item, ask: '/record/fix-ask.md', askText: source.brief, extra: source.brief,
      project: f.repo, org: f.org, lane, route: 'engineer', harness: 'codex', reviewRoute: 'review',
      exception: { to: 'supervisor-herdr', source: 'project config' } });
    contract.workspace = path.join(f.scratch, 'fresh-fixer');
    const state = fold([...c.events, { type: 'run.started', id: 'R-9', item: item.id, workspace: contract.workspace,
      brief_path: '/record/R-9/brief.md', report_path: '/record/R-9/report.md',
      meta: { lane, route: 'engineer', harness: 'codex', worker_brief: JSON.stringify(contract) } }]);
    const run = state.runs.get('R-9'), brief = renderBrief(state, run.id, { config: DEFAULT_CONFIG, cli: 'record', archive: [] });
    const job = { workerBrief: contract, repo: f.repo, org: f.org, brief: contract.ask, lane, workspace: contract.workspace,
      route: 'engineer', declared: { harness: 'codex' }, worker: { agentName: 'fresh-fixer' }, to: 'supervisor-herdr', extra: source.brief };
    const prompt = lineWorkerPrompt({ job, run, brief, node: process.execPath, laneCLI: '/brain/lanes/lane.mjs' });
    assert.ok(prompt.includes(source.brief), 'the complete context is delivered through the real detached prompt builder');
    assert.match(prompt, /watcher targets supervisor-herdr/);
    assert.equal(contract.guidance.role, 'worker');
    assert.match(prompt, /promote fresh-fixer --expected-head-from-worktree/);
    assert.doesNotMatch(prompt, /--expected-head FULL_SHA/);
    assert.match(prompt, /record the resulting committed candidate head, and verify the command's captured head matches it/);
    assert.match(prompt, /Final-head correction check authorization: if a required rebase/);
    assert.match(prompt, /automatically authorized to run that same selected command with lane check --cmd/);
    assert.match(prompt, /without supervisor action/);
    assert.match(prompt, /Run only that affected control once per new head/);
    assert.match(prompt, /existing green final-head receipt is reused, never replayed/);
    assert.match(prompt, /First preserve every earlier gate JSON, log and execution receipt/);
    assert.match(prompt, /each finding must also supply prior_checks/);
    assert.match(prompt, /omitted or changed earlier proof leaves acceptance Unknown/);
    assert.match(prompt, /formal correction's explicit final-head authorization in its fix context/);
    assert.equal(c.state.items.get(item.id).meta.review_round_cap, 1);
    assert.deepEqual(f.read().actions, []);
  }
});

test('second formal fix retains earlier fixer proof and its own unlanded source without replacing original review evidence', t => {
  const f = context(t), lane = path.join(f.scratch, 'first-fix');
  f.git(['worktree', 'add', '-b', 'lane/first-fix', lane, f.head]);
  fs.writeFileSync(path.join(lane, 'seed'), 'first correction');
  f.git(['commit', '-am', 'first correction'], lane);
  const head = f.git(['rev-parse', 'HEAD'], lane);
  f.append([{ type: 'run.started', id: 'R-9', item: f.fix.id, workspace: lane, meta: { lane: 'first-fix' } },
    { type: 'report.ingested', run: 'R-9', report: { outcome: 'failed', artifacts: ['/proof/fixer-failed.tap', '/proof/fixer-unrun.md'] }, file: 'reports/R-9.md', sha256: 'fixer-sha' }]);
  f.packet('R-9', { branch: 'lane/first-fix', base: f.head, head,
    check: { executed: false, outcome: 'unrun', log: '/proof/fixer.log' } });
  const before = fs.readFileSync(f.eventFile), source = f.source();
  assert.equal(source.base, head);
  assert.equal(source.ref, 'refs/heads/lane/first-fix');
  for (const text of ['Earlier fixer R-9', 'reports/R-9.md', 'fixer-sha', '/proof/fixer-failed.tap', '/proof/fixer-unrun.md', '"outcome":"unrun"', f.target.base, f.target.head]) assert.ok(source.brief.includes(text), text);
  assert.deepEqual(fs.readFileSync(f.eventFile), before, 'assembling context never changes attempts or verdicts');
  fs.writeFileSync(path.join(lane, 'seed'), 'unsaved correction');
  assert.throws(() => f.source(), /unsaved author work/);
});

test('ordinary continuation uses its recorded immutable source and explicitly names absent review and check evidence', t => {
  const f = fixture(t, { merged: false, occupied: false }); isolatedEnv(t, f);
  const base = f.git(['rev-parse', 'HEAD']);
  const events = loadEvents(f.org).events.map(e => e.type === 'report.ingested' ? { ...e,
    report: { outcome: 'blocked', artifacts: [`source: ${f.head}; base: ${base}`, '/proof/unrun.md'] }, file: 'reports/R-1.md' } : e);
  const state = fold(events), before = JSON.stringify(events);
  const source = correctionSource({ item: state.items.get('ENG-1'), state, events, repo: f.repo, org: f.org });
  assert.equal(source.base, f.head);
  assert.ok(source.brief.includes(`Immutable base/head: ${base} ${f.head}`));
  assert.ok(source.brief.includes('/proof/unrun.md'));
  assert.match(source.brief, /Review report: UNKNOWN/);
  assert.match(source.brief, /No preserved check capture/);
  assert.doesNotMatch(source.brief, /Final-head correction check authorization/);
  assert.equal(JSON.stringify(events), before);
});
