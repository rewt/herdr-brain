import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { fold } from '../lib/state.mjs';
import { renderShowItem } from '../lib/render.mjs';
import { reviewResultEvents, dispatchInput } from '../line-service/phase1.mjs';
import { queueSelected } from '../line-service/priority-order.mjs';
import { conditionalMinorTrigger, conditionalMinorDeferrals, REVIEW_LIVE_WITNESS_PREFIX } from '../lib/review-live-trigger.mjs';

const trigger = 'Fix forward if it is ever seen live.';
const text = `lib/command-receipt.mjs:76 - Other callers still refuse in the vanished-marker window. ${trigger} No correction needed.`;
const target = { base: 'a'.repeat(40), head: 'b'.repeat(40), scope: { commits: ['b'.repeat(40)] } };
const stamp = events => events.map((event, i) => ({ seq: i + 1, at: '2026-11-01T09:00:00Z', by: 'fixture', ...event }));
function fixture({ findings, proposals = [], body = `- [Minor] ${text}` } = {}) {
  let events = stamp([
    { type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'Producer' },
    { type: 'item.added', id: 'REV-1', role: 'reviewer', title: 'Review', meta: {
      review_source_item: 'ENG-1', review_source_run: 'R-1', review_target: target } },
    { type: 'run.started', id: 'R-2', item: 'REV-1' },
  ]);
  const data = { outcome: 'done', proposals, extra: { verdict: 'PASS', ...(findings ? { findings } : {}) } };
  const intake = () => { const state = fold(events); return reviewResultEvents({ state, events, run: state.runs.get('R-2'), report: data, body, sha256: 'e'.repeat(64) }); };
  const added = intake(); events = stamp([...events, ...added]);
  const id = added.find(e => e.type === 'review.finding-linked' && conditionalMinorTrigger(e.finding))?.correction_item ??
    added.find(e => e.type === 'item.added')?.id;
  const state = () => fold(events), item = () => state().items.get(id);
  const add = event => { events = stamp([...events, event]); };
  const note = witness => add({ type: 'note.added', id, text: REVIEW_LIVE_WITNESS_PREFIX + JSON.stringify(witness) });
  const witness = () => ({ schema: 'brain.review-live-witness/v1', finding_key: item().finding_bindings[0].finding_key,
    trigger: conditionalMinorTrigger(item().finding_bindings[0].finding), observed_at: '2026-11-01T08:59:00Z', evidence: '/record/evidence/observed-live.json' });
  const input = () => dispatchInput({ events, state: state(), item: item() });
  return { added, state, item, add, note, witness, input, intake };
}

test('conditional Minor from R-1585 wording remains visible and cannot supply an automatic dispatch input', () => {
  const f = fixture(), item = f.item(), before = structuredClone(item);
  assert.equal(item.meta.queue_selected, true, 'retains the selection without treating it as observation');
  assert.equal(queueSelected(item, f.state()), false);
  assert.equal(queueSelected(item, f.state(), { selected_only: true }), false, 'ordinary admission cannot bypass the trigger');
  assert.equal(f.input(), null);
  assert.deepEqual(conditionalMinorDeferrals(item), [{ finding_key: item.finding_bindings[0].finding_key, trigger }]);
  const view = renderShowItem(f.state(), item.id, { config: { budget: {} }, events: [], now: new Date('2026-11-01T09:00:00Z') });
  assert.ok(view.includes(`automatic correction: deferred; trigger: ${trigger}`));
  assert.deepEqual(item, before, 'eligibility checks do not mutate the obligation');
  assert.deepEqual(f.intake(), [], 'repeated review intake preserves the original correction');
});

test('ordinary notes, malformed and wrong-finding/live-trigger witnesses leave the conditional Minor deferred', () => {
  const variants = [
    w => ({ ...w, finding_key: 'another-finding' }), w => ({ ...w, trigger: 'another trigger' }),
    w => ({ ...w, evidence: '' }), w => ({ ...w, schema: 'test-result' }),
    w => ({ ...w, observed_at: 'tomorrow' }), w => ({ ...w, observed_at: '2026-11-02T00:00:00Z' }),
    w => ({ ...w, observed_at: '2026-11-01T08:59:00' }),
  ];
  for (const variant of variants) {
    const f = fixture(); f.note(variant(f.witness()));
    assert.equal(queueSelected(f.item(), f.state()), false); assert.equal(f.input(), null);
  }
  const f = fixture();
  f.add({ type: 'note.added', id: f.item().id, text: 'The test passed; select this correction.' });
  f.add({ type: 'note.added', id: f.item().id, text: REVIEW_LIVE_WITNESS_PREFIX + '{broken' });
  assert.equal(f.input(), null);
});

test('an exact recorded live witness restores ordinary admission without clearing independent deselection or blockers', () => {
  const f = fixture(); assert.equal(f.input(), null);
  f.note(f.witness());
  assert.deepEqual(conditionalMinorDeferrals(f.item()), []);
  assert.equal(queueSelected(f.item(), f.state()), true); assert.ok(f.input());
  f.add({ type: 'item.updated', id: f.item().id, fields: { meta: { queue_selected: false } } });
  assert.equal(queueSelected(f.item(), f.state()), false);
  f.add({ type: 'item.added', id: 'ENG-99', role: 'engineer', title: 'Independent blocker' });
  f.add({ type: 'link.added', blocker: 'ENG-99', blocked: f.item().id });
  assert.equal(f.input(), null);
});

test('one proposal separates conditional Minors from immediate Major and ordinary Minor obligations', () => {
  const f = fixture({ findings: [{ severity: 'major', text: 'Reject wrong ownership', correction_check: 'Reproduce wrong ownership' },
    { severity: 'minor', text: 'Improve diagnostics' }, { severity: 'minor', text }],
    proposals: [{ role: 'engineer', title: 'Address review findings' }] });
  const corrections = f.added.filter(e => e.type === 'item.added');
  assert.equal(corrections.length, 2); assert.equal(f.added.filter(e => e.type === 'review.finding-linked').length, 3);
  const immediate = f.state().items.get(corrections.find(e => e.meta.severity === 'major').id);
  assert.equal(queueSelected(immediate, f.state()), true); assert.equal(immediate.finding_bindings.length, 2);
  assert.equal(queueSelected(f.item(), f.state()), false); assert.equal(f.item().finding_bindings.length, 1);
  assert.deepEqual(f.intake(), []);
});

test('ordinary Minor and Major findings retain automatic correction eligibility', () => {
  for (const finding of [{ severity: 'minor', text: 'Improve diagnostic context' }, { severity: 'major', text }]) {
    const f = fixture({ findings: [finding] });
    assert.equal(queueSelected(f.item(), f.state()), true); assert.ok(f.input());
  }
});

test('structured live triggers and legacy conditional bindings defer without changing finding identity or attempts', () => {
  const f = fixture({ findings: [{ severity: 'minor', text: 'Rare diagnostic race', live_trigger: 'The missing marker is observed in a live reconciliation.' }] });
  assert.equal(f.input(), null); f.note(f.witness()); assert.ok(f.input());
  const legacy = fixture();
  const old = legacy.item(); delete old.meta.review_live_triggers;
  delete old.finding_bindings[0].finding.live_trigger;
  assert.equal(queueSelected(old, legacy.state()), false, 'old bindings infer the conditional trigger from immutable text');
  assert.equal(conditionalMinorTrigger({ severity: 'major', text }), null, 'a Major cannot be deferred by this policy');
  for (const wording of ['Fix forward only if the race is observed live.', 'Fix-forward-if-seen-live', 'Fix forward when this occurs live.'])
    assert.ok(conditionalMinorTrigger({ severity: 'minor', text: wording }));
  assert.equal(conditionalMinorTrigger({ severity: 'minor', text: 'Fix forward now; check the live log.' }), null);
});

test('repeated structured finding declarations retain the live trigger and refuse contradictory conditions', () => {
  const plain = { severity: 'minor', text: 'Rare race' }, conditional = { ...plain, live_trigger: trigger };
  const f = fixture({ findings: [plain, conditional] });
  assert.equal(f.input(), null);
  assert.throws(() => fixture({ findings: [conditional, { ...conditional, live_trigger: 'A different condition' }] }), /contradictory live triggers/);
});
