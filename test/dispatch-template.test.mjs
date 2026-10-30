import test from './helpers/bounded-test.mjs';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupOrg } from './helpers.mjs';
import { fold } from '../lib/state.mjs';
import { DEFAULT_CONFIG } from '../lib/store.mjs';
import { renderBrief } from '../lib/render.mjs';
import { createWorkerBrief } from '../lib/worker-brief.mjs';
import { briefContext } from '../lib/brief-context.mjs';
import { dispatchPrompt, isDispatchPrompt, intentFirstCreation } from '../lib/dispatch-template.mjs';
import { proposalIntakeEvents } from '../lib/proposal-intake.mjs';
import { reviewCorrectionEvents } from '../line-service/review-findings.mjs';

const fleet = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-template-fleet-'));
process.env.HERDR_MONITOR_FLEET = fleet;
after(() => fs.rmSync(fleet, { recursive: true, force: true }));
const stamp = events => events.map((e, n) => ({ ...e, seq: n + 1, at: '2026-10-30T17:00:00Z', by: 'fixture' }));
function fixture(t) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  return f;
}

test('authoring template and complete file preserve the authored intent verbatim without changing legacy records', t => {
  const f = fixture(t), before = f.events();
  const draft = f.ok(['template']);
  assert.equal(isDispatchPrompt(draft), true);
  assert.deepEqual(f.events(), before, 'printing a template creates no record work');
  const authored = draft.replace('<intended benefit, linked to dated evidence>', 'The operator needs a fresh owner to see the dated original intent')
    .replace('<the outcome or uncertainty this owner can resolve>', 'Can a fresh owner find the intended result')
    .replace('<observable change, owned seam and named consumer>', 'Find the original ask in one brief; the next reviewer consumes the exact link');
  const file = path.join(f.root, 'prompt.md'); fs.writeFileSync(file, authored);
  const id = f.ok(['add', 'Carry the original intent', '--role', 'engineer', '--file', file, '--why', 'Keep the operator wording']).trim();
  const creation = f.events().find(e => e.id === id && e.type === 'item.added');
  assert.deepEqual(creation.accept, [authored]);
  assert.equal(creation.why, 'Keep the operator wording');
  assert.match(f.fail(['add', 'Ambiguous input', '--file', file, '--accept', 'Other scope']), /choose --file or --accept/);
  fs.writeFileSync(file, '');
  assert.match(f.fail(['add', 'Empty input', '--file', file]), /empty prompt/);
});

test('ordinary and decision intake expose missing measurements and preserve every original requirement', t => {
  const f = fixture(t), raw = ['Keep the native guard.\nDo not run $(anything).', 'The original owner retains STOP/HOLD.'];
  for (const role of ['engineer', 'decision']) {
    const id = f.ok(['add', 'Resolve the bounded outcome', '--role', role, ...raw.flatMap(a => ['--accept', a])]).trim();
    const item = fold(f.events()).items.get(id), prompt = item.accept[0];
    assert.equal(isDispatchPrompt(prompt), true);
    for (const source of raw) assert.ok(prompt.includes(source));
    assert.match(prompt, /Measure: Not recorded separately/);
    assert.match(prompt, /Baseline: Unmeasured/);
    assert.match(prompt, /completed template.*does not prove/);
    assert.equal(item.meta.queue_selected, undefined, 'a prompt grants no selection');
    f.ok(['start', id]);
    const brief = f.ok(['brief', `R-${item.id === 'ENG-1' ? 1 : 2}`]);
    assert.match(brief, /## Dispatch prompt\nWhy:/);
    assert.ok(brief.includes(prompt));
  }
});

test('ask preserves category recommendation and pending authority while carrying the intent-first prompt', t => {
  const f = fixture(t), parent = f.ok(['add', 'Owning work']).trim();
  const id = f.ok(['ask', 'May this reserved effect proceed?', '--parent', parent, '--category', 'publish', '--recommend', 'no', '--why', 'Publication requires the actual owner.', '--wait']).trim();
  const item = fold(f.events()).items.get(id);
  assert.equal(isDispatchPrompt(item.accept[0]), true);
  assert.match(item.accept[0], /Why: Publication requires the actual owner/);
  assert.match(item.accept[0], /Question: May this reserved effect proceed\?/);
  assert.match(item.accept[0], /recommendation is not an answer/);
  assert.equal(item.meta.category, 'publish'); assert.equal(item.meta.recommend, 'no');
  assert.equal(item.meta.answer, undefined); assert.equal(item.closed, null);
});

test('proposal intake retains immutable sources, grouping, selection and replay identity with the new shape', () => {
  const events = stamp([{ type: 'item.added', id: 'ENG-1', title: 'Source', role: 'engineer' }, { type: 'run.started', id: 'R-1', item: 'ENG-1' }]);
  const report = { outcome: 'done', proposals: Array.from({ length: 4 }, (_, n) => ({ role: 'engineer', title: `Future ${n}`, why: 'Keep every source', accept: [`Original requirement ${n}`] })) };
  const before = structuredClone(report);
  const intake = history => {
    const state = fold(history);
    return proposalIntakeEvents({ events: history, state, run: state.runs.get('R-1'), report, sha256: 'immutable' });
  };
  const added = intake(events), creation = added.find(e => e.type === 'item.added');
  assert.equal(isDispatchPrompt(creation.accept[0]), true);
  assert.equal(creation.meta.proposal_sources.length, 4);
  assert.equal(creation.meta.queue_selected, false);
  assert.deepEqual(creation.meta.proposal_sources.map(s => s.proposal), report.proposals);
  assert.deepEqual(report, before);
  assert.deepEqual(intake(stamp([...events, ...added])), []);
});

test('formal correction keeps the original finding keys and specific Major checks across repeated intake', () => {
  const target = { base: 'a'.repeat(40), head: 'b'.repeat(40), scope: { commits: ['b'.repeat(40)] } };
  const events = stamp([{ type: 'item.added', id: 'REV-1', title: 'Review', role: 'reviewer', meta: { review_target: target, review_source_item: 'ENG-1', review_source_run: 'R-0' } }, { type: 'run.started', id: 'R-1', item: 'REV-1' }]);
  const finding = { severity: 'major', text: 'A refused effect was replaced', correction_check: 'Assert a refused original attempt cannot be replaced.' };
  const intake = history => {
    const state = fold(history);
    return reviewCorrectionEvents({ events: history, state, run: state.runs.get('R-1'), review: state.items.get('REV-1'), report: { proposals: [] }, findings: [finding], verdict: 'FAIL', sha256: 'immutable' });
  };
  const { add } = intake(events), creation = add.find(e => e.type === 'item.added');
  assert.equal(isDispatchPrompt(creation.accept[0]), true);
  assert.ok(creation.accept[0].includes(finding.text));
  assert.ok(creation.accept[0].includes(finding.correction_check));
  assert.equal(creation.meta.review_round_cap, 1);
  assert.equal(add.filter(e => e.type === 'review.finding-linked').length, 1);
  assert.deepEqual(intake(stamp([...events, ...add])).add, []);
});

test('legacy dispatch is a view over current acceptance and never rewrites historical requirements or saved briefs', t => {
  const f = fixture(t);
  const legacy = { type: 'item.added', id: 'ENG-1', title: 'Legacy work', role: 'engineer', accept: ['Original operator wording.'] };
  const events = stamp([legacy, { type: 'run.started', id: 'R-1', item: 'ENG-1', brief_path: path.join(f.dir, 'runs/R-1/brief.md') }]);
  const state = fold(events), before = structuredClone(state), ctx = { config: DEFAULT_CONFIG, cli: 'record' };
  const brief = renderBrief(state, 'R-1', ctx);
  assert.match(brief, /## Dispatch prompt\nWhy:/);
  assert.match(brief, /Current acceptance \(verbatim source; still governs scope\):\nOriginal operator wording\./);
  assert.deepEqual(state, before);
  fs.appendFileSync(path.join(f.dir, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
  fs.mkdirSync(path.join(f.dir, 'runs/R-1'), { recursive: true });
  fs.writeFileSync(events[1].brief_path, 'Saved old brief bytes\n');
  assert.equal(f.ok(['brief', 'R-1']), 'Saved old brief bytes\n');
  f.ok(['amend-accept', 'ENG-1', '--accept', 'Owner-amended current outcome.', '--why', 'Owner changes the scope']);
  const amended = fold(f.events());
  assert.match(dispatchPrompt(amended.items.get('ENG-1')), /Owner-amended current outcome/);
  assert.deepEqual(amended.items.get('ENG-1').accept_history[0].accept, legacy.accept);
  assert.equal(f.ok(['brief', 'R-1']), 'Saved old brief bytes\n');
});

test('fresh line contracts deliver the complete prompt once without replacing guards or routing metadata', () => {
  const event = intentFirstCreation({ type: 'item.added', id: 'ENG-1', title: 'A bounded change', role: 'engineer', accept: ['Preserve captured callbacks'] });
  const events = stamp([event, { type: 'run.started', id: 'R-1', item: event.id, workspace: '/project/lane', meta: { lane: 'topic', route: 'engineer', harness: 'codex' } }]);
  const state = fold(events), item = state.items.get(event.id), run = state.runs.get('R-1');
  const contract = createWorkerBrief({ item, ask: '/record/ask.md', askText: 'The bounded ask', project: '/project', org: '/record', lane: 'topic', route: 'engineer', harness: 'codex', reviewRoute: 'review', exception: { to: 'supervisor', source: 'project promote.to' } });
  contract.workspace = run.workspace; run.meta.worker_brief = JSON.stringify(contract);
  const brief = renderBrief(state, run.id, { config: DEFAULT_CONFIG, cli: 'record' });
  assert.equal(brief.split(item.accept[0]).length, 2);
  assert.deepEqual(briefContext(state, item.id).paths, [], 'generic guideposts introduce no fake source selectors');
  assert.equal(contract.outcome, item.title);
  assert.match(brief, /PROJECT SUPERVISOR supervisor/);
  assert.match(brief, /labels and estimates grant no authority/);
});
