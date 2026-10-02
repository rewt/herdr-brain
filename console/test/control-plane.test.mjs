import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModernSession } from '../modern/session.mjs';
import { controlEntries } from '../modern/model.mjs';
import { lineText } from '../lib/frame.mjs';
import { routesSnapshot } from '../../lanes/routes-command.mjs';
import { resolveRoute, resolveLaunchRoute } from '../../lanes/routes.mjs';
import { orgRouteSet } from '../lib/cli.mjs';

const bin = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
function fixture(t, deps = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'console-control-'));
  const cwd = path.join(scratch, 'project'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'New project\n'); git(['add', '.']); git(['commit', '-m', 'New project']);
  const env = { ...process.env, ORG_DIR: path.join(cwd, '.org'), ORG_ACTOR: 'fixture-agent' };
  const org = (args, overrides = {}) => execFileSync(process.execPath, [bin, ...args], { cwd, env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  org(['init']);
  const goal = org(['add', 'Ship useful work', '--goal']);
  org(['set', goal, 'meta.block=now']);
  org(['note', goal, 'Agents keep routine decisions.', '--decision', '--summary=Agents own implementation choices.']);
  const question = org(['ask', 'Publish this project?', '--parent', goal, '--category=publish', '--recommend=yes', '--why=Operator authority is required.', '--wait']);
  const session = createModernSession({ config: { projects: [{ name: 'Fresh project', cwd }], refresh_seconds: 60 }, env: { HERDR_ENV: '1' }, deps: {
    herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), herdrRead: async () => ({ ok: true, text: '' }),
    brainQueue: async () => ({ rows: [], off: true }),
    ...deps,
  } });
  t.after(() => session.stop());
  return { scratch, cwd, git, org, goal, question, session };
}
const render = (s, cols = 100, rows = 40) => s.frame(cols, rows).lines.map(lineText).join('\n');

test('an overflowing priority confirmation supports keyboard review at 80x20 without saving', async t => {
  const { session: s, org, cwd } = fixture(t);
  for (let i = 1; i <= 12; i++) org(['priorities', 'add', `Outcome ${i}: ${'A long outcome with enough context to wrap. '.repeat(3)}`, '--why=Operator choice'], { ORG_ACTOR: 'human' });
  await s.refresh(); await s.key('P'); render(s, 80, 20);
  await s.key('', { return: true }); await s.key('u', { ctrl: true }); await s.key('2');
  await s.key('', { tab: true }); await s.key('Inspect the entire proposed order before saving');
  await s.key('', { return: true });
  const file = path.join(cwd, '.org', 'events.jsonl'), bytes = fs.readFileSync(file, 'utf8');
  const values = [...s.ui.priorityEdit.values];
  const initial = render(s, 80, 20);
  assert.ok(s.ui.frame.maxScroll > s.ui.frame.bodyHeight);
  assert.doesNotMatch(initial, /12\. Outcome 12/);
  await s.key('', { downArrow: true }); render(s, 80, 20);
  assert.equal(s.ui.scroll, 1);
  await s.key('', { upArrow: true }); render(s, 80, 20);
  assert.equal(s.ui.scroll, 0);
  const seen = [];
  while (s.ui.scroll < s.ui.frame.maxScroll) {
    await s.key('', { pageDown: true }); seen.push(render(s, 80, 20));
  }
  assert.match(seen.join('\n'), /12\. Outcome 12/);
  assert.match(seen.at(-1), /Inspect the entire proposed order/);
  assert.match(seen.at(-1), /Save priorities/);
  await s.key('', { pageUp: true }); render(s, 80, 20);
  assert.ok(s.ui.scroll < s.ui.frame.maxScroll);
  assert.equal(s.ui.priorityEdit.confirm, true);
  assert.deepEqual(s.ui.priorityEdit.values, values);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  await s.key('', { escape: true });
  assert.equal(s.ui.priorityEdit, null);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('Priorities invites the operator, groups work, reviews CLI ranks and retains stale or cancelled drafts', async t => {
  const { session: s, org, cwd } = fixture(t);
  await s.refresh(); await s.key('P');
  assert.match(render(s), /No priorities yet/);
  await s.activate('priority-add'); await s.key('Continuity');
  await s.key('', { tab: true }); await s.key('Context clears cost nothing');
  await s.key('', { return: true });
  assert.match(render(s), /Review operator priority/);
  assert.equal(JSON.parse(org(['priorities', '--json'])).priorities.length, 0);
  await s.key('', { return: true });
  assert.equal(s.model.priorities.priorities[0].created.by, 'human');
  org(['priorities', 'add', 'Adoption', '--why=Useful to people'], { ORG_ACTOR: 'human' });
  const task = org(['add', 'Ship an example', '--role=engineer', '--meta=serves=P-2']);
  org(['start', task, '--serves=P-2']);
  org(['add', 'Explore unrelated work', '--role=engineer']);
  await s.refresh();
  for (const width of [80, 100, 140]) {
    const text = render(s, width, 48);
    assert.match(text, /1\. P-1 Continuity/); assert.match(text, /2\. P-2 Adoption/);
    assert.match(text, /Ship an example/); assert.match(text, /Unaligned · 1 open work/);
    assert.match(text, /Explore unrelated work/);
  }
  await s.activate('priority:P-2'); await s.key('u', { ctrl: true }); await s.key('1');
  await s.key('', { tab: true }); await s.key('People can adopt it now');
  await s.key('', { return: true });
  assert.match(render(s), /1\. Adoption/);
  assert.equal(JSON.parse(org(['priorities', '--json'])).priorities[0].id, 'P-1');
  await s.key('', { return: true });
  assert.equal(s.model.priorities.priorities[0].id, 'P-2');
  assert.equal(s.model.priorities.priorities[0].history.at(-1).why, 'People can adopt it now');
  await s.activate('priority:P-1');
  await s.activate('view:goals'); await s.key('p'); await s.key('q');
  assert.equal(s.ui.view, 'priorities'); assert.equal(s.ui.priorityEdit.values[0], '2pq', 'editor owns shortcut typing');
  await s.activate('priority-cancel'); assert.equal(s.ui.priorityEdit, null);
  await s.activate('priority:P-1'); await s.key('u', { ctrl: true }); await s.key('1');
  await s.key('', { tab: true }); await s.key('Restore continuity'); await s.key('', { return: true });
  org(['priorities', 'add', 'Quality', '--why=Dependable tools'], { ORG_ACTOR: 'human' });
  const file = path.join(cwd, '.org', 'events.jsonl'), bytes = fs.readFileSync(file, 'utf8');
  await s.key('', { return: true });
  assert.match(s.ui.message, /changed since you opened/); assert.ok(s.ui.priorityEdit);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  await s.key('', { escape: true }); assert.equal(s.ui.priorityEdit, null);
});

test('Priorities --print confirmation remains read only for both additions and ranks', t => {
  const { org, cwd, scratch } = fixture(t);
  org(['priorities', 'add', 'Adoption', '--why=People first'], { ORG_ACTOR: 'human' });
  const config = path.join(scratch, 'console.json');
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: 'Priorities fixture', cwd }] }));
  const file = path.join(cwd, '.org', 'events.jsonl'), bytes = fs.readFileSync(file, 'utf8');
  const app = fileURLToPath(new URL('../app.mjs', import.meta.url));
  for (const keys of ['P\\n\\tBecause people need it\\n\\n', 'Pk\\nNew outcome\\tFor the next milestone\\n\\n']) {
    const output = execFileSync(process.execPath, [app, '--modern', '--config', config, '--print', '100x40', '--keys', keys],
      { cwd, encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'console-test-agent', HERDR_BIN_PATH: '/usr/bin/false', HERDR_ENV: '1', NO_COLOR: '1' } });
    assert.match(output, /--print does not change priorities/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

test('a project with no console config discovers its record, answers and edits routes through the actual CLI', async t => {
  const f = fixture(t), { session: s } = f;
  await s.refresh();
  assert.equal(fs.realpathSync(s.project.org), fs.realpathSync(path.join(f.cwd, '.org')));
  assert.equal(s.model.routes.suggested, true);
  assert.equal(fs.existsSync(path.join(f.cwd, '.lane.json')), false, 'reading defaults never writes config');
  await s.key('c');
  for (const width of [80, 100, 140]) {
    const text = render(s, width);
    assert.match(text, /Waiting on you · 1/); assert.match(text, /Decided · 1/); assert.match(text, /Asked · 1/); assert.match(text, /Routes in effect/);
    assert.equal(text.split('\n').length, 40);
    const tabs = s.ui.frame.hits[4];
    for (let i = 1; i < tabs.length; i++) assert.ok(tabs[i].from >= tabs[i - 1].to, 'navigation never overlaps');
  }
  await s.activate(`asked:${f.question}`); await s.key('y');
  assert.equal(JSON.parse(f.org(['show', f.question, '--json'])).closed, null);
  await s.key('', { return: true });
  const question = JSON.parse(f.org(['show', f.question, '--json']));
  assert.equal(question.meta.answer, 'yes'); assert.equal(question.meta.answered_by, 'human');
  assert.equal(s.model.needs.length, 0); assert.equal(s.model.asked[0].answerState, 'yes · human');
  assert.match(s.model.decided[0].text, /Publish this project\? → Answered yes/);
  await s.key('u'); await s.activate('route:engineer');
  await s.key('', { tab: true }); await s.key('u', { ctrl: true }); await s.key('portable-model');
  await s.key('', { tab: true }); await s.key('u', { ctrl: true }); await s.key('xhigh');
  await s.key('', { return: true });
  assert.match(render(s), /gpt-6\.1-sol → portable-model/);
  assert.equal(fs.existsSync(path.join(f.cwd, '.lane.json')), false, 'review is read only');
  await s.key('', { return: true });
  const routes = JSON.parse(f.org(['routes', '--json']));
  assert.equal(routes.suggested, undefined);
  assert.equal(resolveRoute(routes.config, { route: 'engineer' }).model, 'portable-model');
  assert.equal(routes.config.routes.engineer.effort, 'xhigh');
  assert.equal(Object.keys(routes.config.routes).length, 15, 'first override keeps other portable defaults');
  assert.equal(routes.config.selection_policy.by_task_class.implementation, 'engineer');
  f.git(['add', '.lane.json']); f.git(['commit', '-m', 'Project route override']);
  assert.match(f.git(['show', 'HEAD:.lane.json']).toString(), /portable-model/);
});

test('route editor owns typing and clicks, cancels, and refuses a stale review without changing disk', async t => {
  const { session: s, cwd, org } = fixture(t); await s.refresh(); await s.key('u'); await s.activate('route:engineer');
  const id = s.ui.projectId;
  await s.activate('view:goals'); await s.key('q'); await s.key('p');
  assert.equal(s.ui.view, 'routes'); assert.equal(s.ui.projectId, id); assert.equal(s.ui.routeEdit.values[0], 'codexqp');
  await s.activate('route-cancel'); assert.equal(s.ui.routeEdit, null); assert.equal(fs.existsSync(path.join(cwd, '.lane.json')), false);
  await s.activate('route:engineer'); await s.key('', { return: true });
  org(['routes', 'set', 'engineer', '--effort=max']);
  const bytes = fs.readFileSync(path.join(cwd, '.lane.json'), 'utf8');
  await s.key('', { return: true });
  assert.match(s.ui.message, /changed since you opened/); assert.equal(fs.readFileSync(path.join(cwd, '.lane.json'), 'utf8'), bytes);
  assert.ok(s.ui.routeEdit, 'failed save retains the draft');
  await s.key('', { escape: true }); assert.equal(s.ui.routeEdit, null);
});

test('CLI overrides preserve inherited routes, policy and project lifecycle fields; reject malformed and redirected writes', t => {
  const { scratch, cwd, org } = fixture(t);
  const parent = { routes: { engineer: { kind: 'opaque-tool', model: 'opaque-model', effort: 'opaque-effort', env: ['KEEP=1'], args: ['--foo'] } },
    selection_policy: { by_task_class: { implementation: 'engineer' } } };
  const parentFile = path.join(scratch, '.lane.json'); fs.writeFileSync(parentFile, JSON.stringify(parent));
  const target = path.join(cwd, '.lane.json'); fs.writeFileSync(target, JSON.stringify({ main: 'trunk', validate: 'npm test', prepare: [{ run: 'prepare' }], routes: {} }));
  const before = fs.readFileSync(parentFile, 'utf8');
  org(['routes', 'set', 'engineer', '--effort=more-reasoning']);
  const own = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(own.main, 'trunk'); assert.deepEqual(own.prepare, [{ run: 'prepare' }]);
  assert.equal(own.routes.engineer.model, 'opaque-model'); assert.deepEqual(own.routes.engineer.args, ['--foo']);
  assert.equal(fs.readFileSync(parentFile, 'utf8'), before);
  assert.equal(routesSnapshot(cwd).config.selection_policy.by_task_class.implementation, 'engineer');
  const bytes = fs.readFileSync(target, 'utf8');
  for (const args of [['routes', 'set', 'engineer', '--model='], ['routes', 'set', 'missing', '--model=anything'], ['routes', 'set', 'constructor', '--effort=x']]) {
    assert.throws(() => org(args)); assert.equal(fs.readFileSync(target, 'utf8'), bytes);
  }
  fs.unlinkSync(target); fs.symlinkSync(parentFile, target);
  assert.throws(() => org(['routes', 'set', 'engineer', '--model=changed']), /regular, unlinked file/);
  assert.equal(fs.readFileSync(parentFile, 'utf8'), before);
});

test('route CLI uses the canonical Git project, ignores launch override paths, and passes model text without shell interpretation', t => {
  const { scratch, cwd, git } = fixture(t), linked = path.join(scratch, 'linked');
  git(['worktree', 'add', '-b', 'lane/test', linked]);
  const marker = path.join(scratch, 'must-not-exist'), model = `opaque; $(touch ${marker})`;
  const r = spawnSync(process.execPath, [bin, 'routes', 'set', 'engineer', `--model=${model}`, '--json'],
    { cwd: linked, encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'console-test-agent', LANE_CONFIG: path.join(scratch, 'external.json') } });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).config.routes.engineer.model, model);
  assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(path.join(linked, '.lane.json')), false);
  assert.equal(fs.existsSync(path.join(cwd, '.lane.json')), true); assert.equal(fs.existsSync(path.join(scratch, 'external.json')), false);
});

test('decisions include older notes and automatic answers, retain provenance, and never mine narrative', () => {
  const facts = controlEntries({ items: [{ id: 'HUM-1', role: 'human', kind: 'work', title: 'Use defaults?', created: { seq: 1, by: 'agent' },
    closed: { seq: 5, at: '2020-01-01T00:00:00Z' }, meta: { answer: 'yes', answered_by: 'auto', recommend: 'yes' }, notes: [{ kind: 'answer', decision: true, seq: 3, by: 'agent', at: '2020-01-01T00:00:00Z', text: 'Answered automatically.' }] },
  { id: 'ENG-1', role: 'engineer', notes: [{ text: 'Narrative asks a question but is not structured.', decision: false }] }],
  runs: [{ id: 'R-1', item: 'ENG-1', notes: [{ decision: true, seq: 5, by: 'agent', at: '2020-01-02T00:00:00Z', summary: 'Use the established design.', text: 'Full reasoning.' }] }] });
  assert.equal(facts.asked.length, 1); assert.equal(facts.decided.length, 2);
  assert.equal(facts.decided[0].source, 'R-1'); assert.equal(facts.decided[0].item, 'ENG-1');
  assert.equal(facts.decided[1].by, 'agent'); assert.equal(facts.decided[1].seq, 3); assert.equal(facts.asked[0].answerState, 'yes · auto');
});

test('--print stays read only even when keys confirm an answer or a route change', t => {
  const { scratch, cwd, question } = fixture(t);
  const config = path.join(scratch, 'console.json'), herdr = path.join(scratch, 'herdr');
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: 'Fresh project', cwd }] }));
  fs.writeFileSync(herdr, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{agents:[],workspaces:[],tabs:[],panes:[]}}));`, { mode: 0o755 });
  const log = path.join(cwd, '.org/events.jsonl'), before = fs.readFileSync(log, 'utf8');
  for (const keys of ['c\\ny\\n', 'u\\n\\n\\n']) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../app.mjs', import.meta.url)), '--modern', '--config', config, '--print', '100x40', '--keys', keys],
      { cwd, env: { ...process.env, ORG_ACTOR: 'console-test-agent', HERDR_BIN_PATH: herdr }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--print does not/);
    assert.equal(fs.readFileSync(log, 'utf8'), before, question);
    assert.equal(fs.existsSync(path.join(cwd, '.lane.json')), false);
  }
});

test('structured ingested report fields appear in Decided and Asked without inventing waiting questions', async t => {
  const { session: s, org, scratch, goal, question } = fixture(t);
  const item = org(['add', 'Choose the implementation', '--parent', goal, '--role=engineer']);
  const run = org(['start', item, '--harness=opaque', '--model=opaque']).match(/^R-\d+/)[0];
  const file = path.join(scratch, 'report.md');
  fs.writeFileSync(file, '---\n' + JSON.stringify({ run, outcome: 'done', summary: 'The implementation is chosen.', headline: 'The implementation is chosen.',
    decisions: [{ text: 'Use a dependency-free projection.', category: 'design', why: 'The durable facts already exist.' }],
    questions: [{ id: question, question: 'Publish this project?' }, { question: 'Which direction next?', category: 'design', recommend: 'Keep iterating', why: 'Several directions remain useful.' }],
  }) + '\n---\n');
  org(['ingest', file]); await s.refresh();
  assert.equal(s.model.decided[0].text, 'Use a dependency-free projection.'); assert.equal(s.model.decided[0].source, run);
  assert.equal(s.model.asked.length, 2, 'the existing record question is not duplicated');
  assert.equal(s.model.needs.length, 1, 'report-only questions never become synthetic waiting items');
  await s.activate(`decision:${s.model.decided[0].key}`); assert.match(render(s), /The durable facts already exist/);
  await s.activate(`asked:${s.model.asked[0].id}`); assert.match(render(s), /Which direction next/); assert.match(render(s), /Several directions remain useful/);
  assert.match(render(s), /no record question to answer/);
});

test('an org-only selection launched in another repository cannot read or edit that repository routes', t => {
  const { scratch, cwd } = fixture(t), selected = path.join(scratch, 'selected'); fs.mkdirSync(selected);
  const org = path.join(selected, '.org');
  execFileSync(process.execPath, [bin, 'init'], { cwd: selected, env: { ...process.env, ORG_ACTOR: 'console-test-agent', ORG_DIR: org }, stdio: 'pipe' });
  const target = path.join(cwd, '.lane.json'), bytes = JSON.stringify({ routes: { engineer: { kind: 'foreign-harness', model: 'foreign-model' } } });
  fs.writeFileSync(target, bytes);
  const sessionModule = new URL('../modern/session.mjs', import.meta.url).href, cliModule = new URL('../lib/cli.mjs', import.meta.url).href;
  const script = `
    import { createModernSession } from ${JSON.stringify(sessionModule)};
    import { orgRoutes, orgRouteSet } from ${JSON.stringify(cliModule)};
    const project = { name: 'Record-only project', org: ${JSON.stringify(org)} };
    const session = createModernSession({ config: { projects: [project] }, env: { HERDR_ENV: '1' }, deps: {
      herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), brainQueue: async () => ({ rows: [], off: true })
    } });
    await session.refresh(); await session.key('u');
    const screen = session.frame(110, 32).lines.map(l => l.spans.map(s => s.text).join('')).join(String.fromCharCode(10));
    await session.activate('route:engineer');
    let readError; try { await orgRoutes(project); } catch (error) { readError = error.message; }
    const write = await orgRouteSet(project, { name: 'engineer', model: 'wrong-project', revision: ${JSON.stringify(routesSnapshot(cwd).revision)} });
    console.log(JSON.stringify({ routes: session.model.routes, edit: session.ui.routeEdit, screen, readError, write })); session.stop();
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'console-test-agent' } }));
  assert.equal(result.routes, null); assert.equal(result.edit, null);
  assert.match(result.readError, /Project directory unknown/); assert.equal(result.write.ok, false); assert.match(result.write.error, /Project directory unknown/);
  assert.match(result.screen, /Read only/); assert.match(result.screen, /Open its folder/); assert.doesNotMatch(result.screen, /foreign-model|Enter edit/);
  assert.equal(fs.readFileSync(target, 'utf8'), bytes); assert.equal(fs.existsSync(path.join(selected, '.lane.json')), false);
});

test('route editor sends partial CLI patches and retains absent harness model and effort defaults', async t => {
  const requests = [], f = fixture(t, { orgRouteSet: async (project, request) => { requests.push(request); return orgRouteSet(project, request); } }), s = f.session;
  const target = path.join(f.cwd, '.lane.json');
  fs.writeFileSync(target, JSON.stringify({ routes: { engineer: { kind: 'opaque', model: 'model-only' }, reviewer: { kind: 'opaque', effort: 'effort-only' } } }));
  await s.refresh(); await s.key('u'); await s.activate('route:engineer');
  assert.match(render(s), /Effort: \(harness default\)/);
  await s.key('', { tab: true }); await s.key('u', { ctrl: true }); await s.key('new-model'); await s.key('', { return: true });
  assert.match(render(s), /effort: \(harness default\) → \(harness default\)/);
  await s.key('', { return: true });
  assert.deepEqual(Object.keys(requests[0]).sort(), ['model', 'name', 'revision']);
  let own = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(own.routes.engineer.model, 'new-model'); assert.equal(Object.hasOwn(own.routes.engineer, 'effort'), false);
  await s.activate('route:reviewer');
  assert.match(render(s), /Model: \(harness default\)/);
  await s.key('', { tab: true, shift: true }); await s.key('u', { ctrl: true }); await s.key('new-effort'); await s.key('', { return: true }); await s.key('', { return: true });
  assert.deepEqual(Object.keys(requests[1]).sort(), ['effort', 'name', 'revision']);
  own = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(own.routes.reviewer.effort, 'new-effort'); assert.equal(Object.hasOwn(own.routes.reviewer, 'model'), false);
  await s.activate('route:engineer'); await s.key('', { tab: true }); await s.key('u', { ctrl: true }); await s.key('', { return: true });
  assert.match(s.ui.message, /removing overrides is not supported/); assert.equal(requests.length, 2);
});

test('real answer, overrule and reopen retain each decision note with its original provenance', async t => {
  const { session: s, org, question, goal, cwd } = fixture(t);
  const answers = () => s.model.decided.filter(d => d.source === question);
  const assertNotes = () => {
    const item = JSON.parse(org(['show', question, '--json'])), notes = item.notes.filter(n => n.kind === 'answer');
    assert.deepEqual(answers().map(d => ({ seq: d.seq, at: d.at, by: d.by, detail: d.detail })),
      notes.toReversed().map(n => ({ seq: n.seq, at: n.at, by: n.by, detail: n.text })));
  };
  org(['answer', question, 'yes', '--note=First answer'], { ORG_ACTOR: 'first-operator', ORG_NOW: '2026-10-01T23:01:00Z' });
  await s.refresh(); assert.equal(answers().length, 1); assertNotes();
  org(['answer', question, 'no', '--overrule', '--note=Changed direction'], { ORG_ACTOR: 'second-operator', ORG_NOW: '2026-10-01T23:02:00Z' });
  await s.refresh(); assert.equal(answers().length, 2); assertNotes();
  org(['reopen', question]); await s.refresh(); assert.equal(answers().length, 2); assertNotes();
  assert.equal(s.model.asked[0].answerState, 'Waiting on you');
  await s.key('d'); assert.match(render(s), /First answer/); assert.match(render(s), /overruling yes/);
  await s.activate(`decision:${answers()[1].key}`); assert.match(render(s), /first-operator/); assert.match(render(s), /First answer/);
  assert.equal(render(s).match(/First answer/g).length, 1, 'the full answer evidence appears once in its reader');
  org(['answer', question, 'yes'], { ORG_ACTOR: 'third-operator', ORG_NOW: '2026-10-01T23:03:00Z' });
  await s.refresh(); assert.equal(answers().length, 3); assertNotes();
  const configFile = path.join(cwd, '.org/config.json'), config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.approvals = { categories: { tooling: 'auto' } }; fs.writeFileSync(configFile, JSON.stringify(config));
  const auto = org(['ask', 'Use defaults?', '--parent', goal, '--category=tooling', '--recommend=yes', '--why=Routine choice']);
  await s.refresh(); const decision = s.model.decided.find(d => d.source === auto);
  assert.equal(decision.by, 'fixture-agent'); assert.match(decision.text, /automatically/);
});

test('legacy answer summaries remain available without hiding unrelated earlier answer notes', () => {
  const facts = controlEntries({ items: [{ id: 'HUM-1', role: 'human', title: 'Use defaults?', meta: { answer: 'no', answered_by: 'human' },
    closed: { seq: 10, at: 'later' }, notes: [{ kind: 'answer', decision: true, seq: 2, at: 'earlier', by: 'agent', text: 'Answered yes' }] }] });
  assert.equal(facts.decided.length, 2); assert.equal(facts.decided[0].text, 'Use defaults? → no'); assert.equal(facts.decided[1].seq, 2);
});

test('partial route CLI edits preserve dispatch inheritance rather than pinning defaults', t => {
  const { cwd, org } = fixture(t), target = path.join(cwd, '.lane.json');
  fs.writeFileSync(target, JSON.stringify({ dispatch: { kind: 'opaque', model: 'shared-model', effort: 'shared-effort' },
    routes: { engineer: { model: 'named-model' }, reviewer: { effort: 'named-effort' } } }));
  org(['routes', 'set', 'engineer', '--model=new-model']); org(['routes', 'set', 'reviewer', '--effort=new-effort']);
  const own = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(own.routes.engineer, { model: 'new-model' }); assert.deepEqual(own.routes.reviewer, { effort: 'new-effort' });
  own.dispatch.model = 'next-shared-model'; own.dispatch.effort = 'next-shared-effort';
  fs.writeFileSync(target, JSON.stringify(own));
  const config = JSON.parse(org(['routes', '--json'])).config;
  assert.equal(resolveRoute(config, { route: 'engineer' }).effort, 'next-shared-effort');
  assert.equal(resolveRoute(config, { route: 'reviewer' }).model, 'next-shared-model');
});

test('unchanged configured route saves do not write or pin an omitted kind', async t => {
  const calls = [], f = fixture(t, { orgRouteSet: async (project, request) => { calls.push(request); return orgRouteSet(project, request); } }), s = f.session;
  const target = path.join(f.cwd, '.lane.json'), config = { dispatch: { kind: 'codex' }, routes: { engineer: { model: 'inherited-kind' } } };
  const bytes = JSON.stringify(config); fs.writeFileSync(target, bytes);
  await s.refresh(); await s.key('u'); await s.activate('route:engineer');
  const before = fs.statSync(target);
  await s.key('x'); await s.key('', { backspace: true });
  await s.key('', { return: true });
  assert.match(render(s), /Closing this review writes nothing/);
  await s.key('', { return: true });
  assert.equal(s.ui.routeEdit, null); assert.match(s.ui.message, /nothing written/); assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), bytes);
  const after = fs.statSync(target); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  config.dispatch.kind = 'claude'; fs.writeFileSync(target, JSON.stringify(config)); await s.refresh();
  assert.equal(resolveLaunchRoute(s.model.routes.config, { route: 'engineer' }).kind, 'claude');
  assert.equal(Object.hasOwn(s.model.routes.config.routes.engineer, 'kind'), false);
});

test('unchanged ancestor-only routes are never copied into project config', async t => {
  const calls = [], f = fixture(t, { orgRouteSet: async (project, request) => { calls.push(request); return orgRouteSet(project, request); } }), s = f.session;
  const ancestor = path.join(f.scratch, '.lane.json'), target = path.join(f.cwd, '.lane.json');
  const config = { routes: { engineer: { kind: 'codex', model: 'ancestor-model', args: ['-c', 'model_reasoning_effort=xhigh'] } } };
  const parentBytes = JSON.stringify(config); fs.writeFileSync(ancestor, parentBytes);
  for (const bytes of [null, JSON.stringify({ main: 'trunk', routes: {} })]) {
    if (bytes !== null) fs.writeFileSync(target, bytes);
    await s.refresh(); await s.key('u'); await s.activate('route:engineer');
    assert.equal(s.ui.routeEdit.suggested, false);
    await s.key('', { return: true }); await s.key('', { return: true });
    assert.equal(calls.length, 0); assert.equal(fs.readFileSync(ancestor, 'utf8'), parentBytes);
    assert.equal(fs.existsSync(target), bytes !== null);
    if (bytes !== null) assert.equal(fs.readFileSync(target, 'utf8'), bytes);
  }
  config.routes.engineer.model = 'next-ancestor-model'; fs.writeFileSync(ancestor, JSON.stringify(config)); await s.refresh();
  assert.equal(resolveLaunchRoute(s.model.routes.config, { route: 'engineer' }).model, 'next-ancestor-model');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).routes, {});
});

test('unchanged suggested presets are explicitly adopted once, then configured saves write nothing', async t => {
  const calls = [], f = fixture(t, { orgRouteSet: async (project, request) => { calls.push(request); return orgRouteSet(project, request); } }), s = f.session;
  const target = path.join(f.cwd, '.lane.json');
  await s.refresh(); await s.key('u'); await s.activate('route:engineer'); await s.key('', { return: true });
  assert.match(render(s), /Adopts the suggested routes/); assert.equal(fs.existsSync(target), false); assert.equal(calls.length, 0);
  await s.key('', { return: true });
  assert.equal(calls.length, 1); assert.equal(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8')).routes).length, 15);
  const bytes = fs.readFileSync(target, 'utf8');
  await s.activate('route:engineer'); await s.key('', { return: true }); await s.key('', { return: true });
  assert.equal(calls.length, 1); assert.equal(fs.readFileSync(target, 'utf8'), bytes);
});

test('console route display, editor and review use launch resolution for legacy route and dispatch arguments', async t => {
  const requests = [], f = fixture(t, { orgRouteSet: async (project, request) => { requests.push(request); return orgRouteSet(project, request); } }), s = f.session;
  const target = path.join(f.cwd, '.lane.json');
  const cases = [
    { kind: 'codex', route: { args: ['-c', 'model_reasoning_effort=xhigh'] } },
    { kind: 'codex', dispatch: { args: ['--config', 'model_reasoning_effort=high'] } },
    { kind: 'codex', route: { args: ['--config=model_reasoning_effort=medium'] } },
    { kind: 'codex', dispatch: { args: ['-cmodel_reasoning_effort=low'] } },
    { kind: 'claude', route: { args: ['--effort', 'high'] } },
    { kind: 'claude', dispatch: { args: ['--effort=xhigh'] } },
    { kind: 'codex', dispatch: { args: ['-c', 'model_reasoning_effort=high'] }, route: { args: [] } },
    { kind: 'codex', dispatch: { effort: 'high' }, route: { args: ['-c', 'model_reasoning_effort=xhigh'] } },
  ];
  for (const [index, example] of cases.entries()) {
    const config = { dispatch: { kind: example.kind, model: 'shared-model', ...example.dispatch }, routes: { engineer: { ...example.route } } };
    fs.writeFileSync(target, JSON.stringify(config)); await s.refresh(); await s.key('u');
    const launch = resolveLaunchRoute(config, { route: 'engineer' }), defaults = resolveLaunchRoute(config);
    const effort = launch.effort ?? 'harness default';
    const screen = render(s, 140);
    assert.ok(screen.includes(`${launch.kind} · shared-model · ${effort}`), `route effort matches launch case ${index}`);
    assert.ok(screen.includes(`Default: ${defaults.kind} · shared-model · ${defaults.effort ?? 'harness default'}`));
    assert.ok(screen.includes(`Launch args: ${JSON.stringify(launch.args)}`));
    await s.activate('route:engineer');
    assert.equal(s.ui.routeEdit.original.effort, resolveRoute(config, { route: 'engineer' }).effort, 'the write baseline stays raw');
    assert.ok(render(s, 140).includes(`Effective launch: ${launch.kind} · shared-model · ${effort}`));
    await s.key('', { tab: true }); await s.key('u', { ctrl: true }); await s.key(`new-model-${index}`); await s.key('', { return: true });
    assert.ok(render(s, 140).includes(`effort: ${launch.effort ?? '(harness default)'} → ${launch.effort ?? '(harness default)'}`));
    await s.key('', { return: true });
    assert.deepEqual(Object.keys(requests.at(-1)).sort(), ['model', 'name', 'revision']);
    const own = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(Object.hasOwn(own.routes.engineer, 'effort'), false, 'inferred/default effort is never pinned by another edit');
    assert.deepEqual(own.routes.engineer.args, config.routes.engineer.args);
    assert.equal(resolveLaunchRoute(own, { route: 'engineer' }).effort, launch.effort);
  }
  fs.writeFileSync(target, JSON.stringify({ routes: { engineer: { kind: 'codex', args: ['-c', 'model_reasoning_effort=xhigh'] } } }));
  await s.refresh(); await s.activate('route:engineer');
  await s.key('', { tab: true, shift: true }); await s.key('max'); await s.key('', { return: true });
  assert.match(render(s, 140), /effort: xhigh → max/);
  await s.key('', { return: true });
  const own = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(own.routes.engineer.effort, 'max'); assert.equal(resolveLaunchRoute(own, { route: 'engineer' }).effort, 'max');
  assert.deepEqual(own.routes.engineer.args, ['-c', 'model_reasoning_effort=xhigh']);
});
