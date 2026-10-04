import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupOrg } from './helpers.mjs';
import * as state from '../lib/state.mjs';
import * as render from '../lib/render.mjs';
import { fold as olderFold, itemStatus as olderStatus } from './fixtures/state-v0.mjs';

const agent = { env: { ORG_ACTOR: 'run:R-226' } };
const stamp = events => events.map((e, index) => ({ seq: index + 1, at: '2026-10-04T16:00:00Z', by: 'worker', ...e }));
const proposal = (id, extra = {}) => ({ type: 'lesson.proposed', id, text: `Claim ${id}`, scope: 'project',
  paths: [], modules: [], evidence: [{ kind: 'item', id: 'ENG-1' }], ...extra });
function fixture(t) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.ok(['add', 'Build lessons', '--role=engineer'], agent);
  f.ok(['start', 'ENG-1'], agent);
  return f;
}
const add = (f, text, options = []) => f.ok(['lesson', 'add', text, '--evidence=ENG-1', ...options], agent).trim();
const activate = (f, id, options = []) => f.ok(['lesson', 'activate', id, ...options], agent);

test('lesson fold retains facts and derives proposal, activation, retirement and supersession', () => {
  const events = stamp([proposal('L-1'), { type: 'lesson.activated', id: 'L-1' },
    { type: 'lesson.retired', id: 'L-1', reason: 'No longer useful' },
    { type: 'lesson.activated', id: 'L-1' }, proposal('L-2'),
    { type: 'lesson.activated', id: 'L-2' },
    { type: 'lesson.superseded', id: 'L-1', by_lesson: 'L-2', reason: 'Updated evidence' }]);
  assert.equal(state.lessonState(state.fold(events.slice(0, 1)).lessons.get('L-1')), 'proposed');
  assert.equal(state.lessonState(state.fold(events.slice(0, 2)).lessons.get('L-1')), 'active');
  const retired = state.fold(events.slice(0, 3)).lessons.get('L-1');
  assert.equal(state.lessonState(retired), 'retired');
  assert.equal(retired.retirement.reason, 'No longer useful');
  const s = state.fold(events);
  assert.equal(state.lessonState(s.lessons.get('L-1')), 'superseded');
  assert.equal(state.lessonState(s.lessons.get('L-2')), 'active');
  assert.equal(s.lessons.get('L-1').supersession.by_lesson, 'L-2');
  assert.equal(s.lessons.get('L-1').proposed.by, 'worker');
  for (const lesson of s.lessons.values()) assert.equal(Object.hasOwn(lesson, 'state'), false);
  assert.equal(state.nextLessonId(s), 'L-3');
});

test('frozen older fold ignores actual lesson event types through its unknown-type path', () => {
  const base = [{ type: 'item.added', id: 'ENG-1', title: 'Work', kind: 'work' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1' }, { type: 'run.abandoned', id: 'R-1' }];
  const lessons = [proposal('L-1'), { type: 'lesson.activated', id: 'L-1' },
    { type: 'lesson.retired', id: 'L-1', reason: 'Old' }, proposal('L-2'),
    { type: 'lesson.activated', id: 'L-2' }, { type: 'lesson.superseded', id: 'L-1', by_lesson: 'L-2', reason: 'Better' }];
  const events = stamp([base[0], ...lessons, ...base.slice(1)]);
  const old = olderFold(events), current = state.fold(events);
  const withoutLessons = olderFold(events.filter(e => !e.type.startsWith('lesson.')));
  assert.equal(current.lessons.size, 2);
  assert.deepEqual(old.items, withoutLessons.items);
  assert.deepEqual(old.runs, withoutLessons.runs);
  assert.deepEqual(old.links, withoutLessons.links);
  assert.equal(old.eventCount, events.length);
  assert.equal(olderStatus(old, 'ENG-1'), state.itemStatus(current, 'ENG-1'));
});

test('lesson CLI stores bounded claims, targets, evidence and proposer in the single event log', t => {
  const f = fixture(t);
  assert.equal(add(f, '  Keep the core dependency-free.  ', ['--path=./lib//', '--path=lib', '--module=record',
    '--evidence=R-1', '--evidence=event:1', '--evidence=ENG-1']), 'L-1');
  assert.deepEqual(f.json(['lessons', '--json']), []);
  const proposed = f.json(['lessons', '--state=proposed', '--json'])[0];
  assert.equal(proposed.text, 'Keep the core dependency-free.');
  assert.equal(proposed.scope, 'project');
  assert.deepEqual(proposed.paths, ['lib']);
  assert.deepEqual(proposed.modules, ['record']);
  assert.deepEqual(proposed.evidence, [{ kind: 'item', id: 'ENG-1' }, { kind: 'run', id: 'R-1' }, { kind: 'event', seq: 1 }]);
  assert.equal(proposed.proposed.by, 'run:R-226');
  assert.match(activate(f, 'L-1'), /L-1/);
  assert.equal(f.json(['lessons', '--json'])[0].state, 'active');
  const count = f.events().length;
  activate(f, 'L-1');
  assert.equal(f.events().length, count, 'activation is idempotent');
  f.ok(['lesson', 'retire', 'L-1', '--reason=Obsolete evidence'], agent);
  assert.deepEqual(f.json(['lessons', '--json']), []);
  assert.equal(f.json(['lessons', '--state=retired', '--json'])[0].retirement.reason, 'Obsolete evidence');
  activate(f, 'L-1');
  assert.equal(f.json(['lessons', '--json'])[0].retirement, null);
  assert.equal(state.itemStatus(state.fold(f.events()), 'ENG-1'), 'active', 'lessons do not schedule work');
  assert.ok(f.events().filter(e => e.type.startsWith('lesson.')).every(e => !Object.hasOwn(e, 'state')));
});

test('invalid lesson data and unknown evidence refuse atomically without consuming IDs', t => {
  const f = fixture(t);
  const before = f.events();
  for (const args of [
    ['add', ''], ['add', 'Claim'], ['add', 'x'.repeat(401), '--evidence=ENG-1'],
    ['add', 'Claim', '--scope=personal', '--evidence=ENG-1'],
    ['add', 'Claim', '--evidence=ENG-404'], ['add', 'Claim', '--evidence=R-404'],
    ['add', 'Claim', '--evidence=event:999'], ['add', 'Claim', '--evidence=event:0'],
    ['add', 'Claim', '--evidence=event:1.0'], ['add', 'Claim', '--evidence=ENG-1', '--evidence=R-404'],
    ['add', 'Claim', '--evidence=ENG-1', '--path=../outside'],
    ['add', 'Claim', '--evidence=ENG-1', '--path=/absolute'],
    ['add', 'Claim', '--evidence=ENG-1', '--path=lib/**'],
    ['add', 'Claim', '--evidence=ENG-1', '--module='],
    ['activate', 'L-404'], ['retire', 'L-404', '--reason=Unknown'],
  ]) f.fail(['lesson', ...args], agent);
  assert.deepEqual(f.events(), before);
  assert.equal(add(f, '😀'.repeat(400)), 'L-1', 'limit counts Unicode code points');
  const added = f.events();
  assert.match(f.fail(['lesson', 'retire', 'L-1'], agent), /reason/);
  assert.match(f.fail(['lesson', 'retire', 'L-1', '--reason=  '], agent), /reason/);
  assert.deepEqual(f.events(), added);
});

test('matching is literal, normalized, boundary-aware, exact for modules and deterministically ranked', async () => {
  const { lessonsJson } = await import('../lib/lessons.mjs');
  const events = stamp([
    proposal('L-1'), proposal('L-2', { scope: 'framework' }), proposal('L-3', { scope: 'fleet' }),
    proposal('L-4', { paths: ['lib'] }), proposal('L-5', { paths: ['lib/state.mjs'] }),
    proposal('L-6', { paths: ['library'] }), proposal('L-7', { modules: ['record'] }),
    proposal('L-8', { paths: ['lib/deep'] }),
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'lesson.activated', id: `L-${i + 1}` })),
  ]);
  const s = state.fold(events);
  const ids = options => lessonsJson(s, options).map(l => l.id);
  assert.deepEqual(ids({ path: './lib//state.mjs' }), ['L-5', 'L-4', 'L-1', 'L-3', 'L-2']);
  assert.deepEqual(ids({ path: 'lib/deep/file.mjs' }), ['L-8', 'L-4', 'L-1', 'L-3', 'L-2']);
  assert.deepEqual(ids({ path: 'library/a.mjs' }), ['L-6', 'L-1', 'L-3', 'L-2']);
  assert.deepEqual(ids({ module: 'record' }), ['L-7', 'L-1', 'L-3', 'L-2']);
  assert.deepEqual(ids({ module: 'Record' }), ['L-1', 'L-3', 'L-2']);
  assert.deepEqual(ids({ path: 'lib/state.mjs', scope: 'fleet' }), ['L-3']);
  assert.deepEqual(ids({ path: 'lib/../library/a.mjs' }), ids({ path: 'library/a.mjs' }));
  assert.throws(() => lessonsJson(s, { path: '../../outside' }), /relative/);
});

test('lessons CLI filters path, scope, module and derived state without model or filesystem lookup', t => {
  const f = fixture(t);
  const global = add(f, 'Global'); activate(f, global);
  const fleet = add(f, 'Fleet', ['--scope=fleet']); activate(f, fleet);
  const path = add(f, 'Core', ['--path=lib']); activate(f, path);
  const module = add(f, 'Module', ['--scope=framework', '--module=record']); activate(f, module);
  const proposed = add(f, 'Proposed');
  const ids = args => f.json(['lessons', ...args, '--json']).map(l => l.id);
  assert.deepEqual(ids(['--path=lib/not-created-yet.mjs']), [path, global, fleet]);
  assert.deepEqual(ids(['--module=record', '--scope=framework']), [module]);
  assert.deepEqual(ids(['--state=proposed']), [proposed]);
  assert.equal(ids(['--state=all']).length, 5);
  f.fail(['lessons', '--scope=personal']); f.fail(['lessons', '--state=ready']);
  f.fail(['lessons', '--path=../outside']);
});

test('bounded rendering shows the relevant five and remaining count while JSON returns all evidence', async () => {
  const { lessonsJson } = await import('../lib/lessons.mjs');
  const events = stamp([
    ...Array.from({ length: 8 }, (_, i) => proposal(`L-${i + 1}`, { text: 'x'.repeat(400),
      ...(i === 7 ? { paths: ['lib/state.mjs'] } : {}) })),
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'lesson.activated', id: `L-${i + 1}` })),
  ]);
  const doc = lessonsJson(state.fold(events), { path: 'lib/state.mjs' });
  const text = render.renderLessons(doc);
  assert.equal(doc.length, 8);
  assert.equal(text.match(/^L-\d+ /gm).length, 5);
  assert.match(text, /3 more.*record lessons.*--json/);
  assert.ok(text.indexOf('L-8 ') < text.indexOf('L-1 '));
  assert.ok(text.length < 4000);
  assert.equal(text, render.renderLessons(doc));
  assert.match(render.renderLessons([]), /No matching lessons/);
  const hostile = render.renderLessons([{ ...doc[0], text: '\x1b[31mClaim\x1b[0m', modules: ['bad\x1b[2J'] }]);
  assert.doesNotMatch(hostile, /\x1b/);
  const unicode = render.renderLessons([{ ...doc[0], text: '😀'.repeat(400) }]);
  assert.ok(unicode.includes('😀'.repeat(400)), 'a valid claim is shown in full without cutting a Unicode code point');
});

test('default CLI text is bounded and JSON preserves every matching lesson', t => {
  const f = fixture(t);
  for (let i = 1; i <= 7; i++) activate(f, add(f, `Claim ${i}`));
  const text = f.ok(['lessons']);
  assert.equal(text.match(/^L-\d+ /gm).length, 5);
  assert.match(text, /2 more/);
  assert.equal(f.json(['lessons', '--json']).length, 7);
});

test('supersession is atomic, evidence-preserving and refuses unknown IDs, self-links and transitive cycles', t => {
  const f = fixture(t);
  const a = add(f, 'First'), b = add(f, 'Second'), c = add(f, 'Third');
  activate(f, a);
  const before = f.events();
  for (const options of [['--supersedes=L-404'], [`--supersedes=${b}`], [`--supersedes=${a}`, '--supersedes=L-404']])
    f.fail(['lesson', 'activate', b, ...options], agent);
  assert.deepEqual(f.events(), before, 'a failed multi-target activation appends nothing');
  activate(f, b, [`--supersedes=${a}`]);
  assert.deepEqual(f.json(['lessons', '--json']).map(l => l.id), [b]);
  const old = f.json(['lessons', '--state=superseded', '--json'])[0];
  assert.equal(old.id, a); assert.equal(old.supersession.by_lesson, b);
  assert.deepEqual(old.evidence, [{ kind: 'item', id: 'ENG-1' }]);
  assert.equal(old.supersession.by, 'run:R-226');
  const count = f.events().length;
  activate(f, b, [`--supersedes=${a}`]); assert.equal(f.events().length, count);
  activate(f, c, [`--supersedes=${b}`]);
  const chain = state.fold(f.events());
  assert.equal(state.wouldCycleLesson(chain, c, a), true);
  assert.equal(state.wouldCycleLesson(chain, a, c), false);
  const chainEvents = f.events();
  assert.match(f.fail(['lesson', 'activate', a, `--supersedes=${c}`], agent), /cycle/);
  assert.match(f.fail(['lesson', 'activate', a], agent), /superseded/);
  assert.match(f.fail(['lesson', 'retire', a, '--reason=Obsolete'], agent), /superseded/);
  assert.deepEqual(f.events(), chainEvents);
});

test('lesson allocation avoids existing item IDs and later item allocation avoids lesson IDs', t => {
  const f = fixture(t);
  assert.equal(f.ok(['add', 'Legacy prefix', '--role=l'], agent).trim(), 'L-1');
  assert.equal(add(f, 'Claim'), 'L-2');
  assert.equal(f.ok(['add', 'Another legacy prefix', '--role=l'], agent).trim(), 'L-3');
});
