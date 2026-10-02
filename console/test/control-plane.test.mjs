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
import { resolveRoute } from '../../lanes/routes.mjs';

const bin = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'console-control-'));
  const cwd = path.join(scratch, 'project'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'New project\n'); git(['add', '.']); git(['commit', '-m', 'New project']);
  const env = { ...process.env, ORG_DIR: path.join(cwd, '.org'), ORG_ACTOR: 'fixture-agent' };
  const org = args => execFileSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  org(['init']);
  const goal = org(['add', 'Ship useful work', '--goal']);
  org(['set', goal, 'meta.block=now']);
  org(['note', goal, 'Agents keep routine decisions.', '--decision', '--summary=Agents own implementation choices.']);
  const question = org(['ask', 'Publish this project?', '--parent', goal, '--category=publish', '--recommend=yes', '--why=Operator authority is required.', '--wait']);
  const session = createModernSession({ config: { projects: [{ name: 'Fresh project', cwd }], refresh_seconds: 60 }, env: { HERDR_ENV: '1' }, deps: {
    herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), herdrRead: async () => ({ ok: true, text: '' }),
    brainQueue: async () => ({ rows: [], off: true }),
  } });
  t.after(() => session.stop());
  return { scratch, cwd, git, org, goal, question, session };
}
const render = (s, cols = 100, rows = 40) => s.frame(cols, rows).lines.map(lineText).join('\n');

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
  assert.match(s.model.decided[0].text, /Publish this project\? → yes/);
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
    { cwd: linked, encoding: 'utf8', env: { ...process.env, LANE_CONFIG: path.join(scratch, 'external.json') } });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).config.routes.engineer.model, model);
  assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(path.join(linked, '.lane.json')), false);
  assert.equal(fs.existsSync(path.join(cwd, '.lane.json')), true); assert.equal(fs.existsSync(path.join(scratch, 'external.json')), false);
});

test('decisions include older notes and automatic answers, retain provenance, and never mine narrative', () => {
  const facts = controlEntries({ items: [{ id: 'HUM-1', role: 'human', kind: 'work', title: 'Use defaults?', created: { seq: 1, by: 'agent' },
    closed: { seq: 4, at: '2020-01-01T00:00:00Z' }, meta: { answer: 'yes', answered_by: 'auto', recommend: 'yes' }, notes: [{ kind: 'answer', decision: true, seq: 3, text: 'Answered automatically.' }] },
  { id: 'ENG-1', role: 'engineer', notes: [{ text: 'Narrative asks a question but is not structured.', decision: false }] }],
  runs: [{ id: 'R-1', item: 'ENG-1', notes: [{ decision: true, seq: 5, by: 'agent', at: '2020-01-02T00:00:00Z', summary: 'Use the established design.', text: 'Full reasoning.' }] }] });
  assert.equal(facts.asked.length, 1); assert.equal(facts.decided.length, 2);
  assert.equal(facts.decided[0].source, 'R-1'); assert.equal(facts.decided[0].item, 'ENG-1');
  assert.equal(facts.decided[1].by, 'auto'); assert.equal(facts.asked[0].answerState, 'yes · auto');
});

test('--print stays read only even when keys confirm an answer or a route change', t => {
  const { scratch, cwd, question } = fixture(t);
  const config = path.join(scratch, 'console.json'), herdr = path.join(scratch, 'herdr');
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: 'Fresh project', cwd }] }));
  fs.writeFileSync(herdr, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{agents:[],workspaces:[],tabs:[],panes:[]}}));`, { mode: 0o755 });
  const log = path.join(cwd, '.org/events.jsonl'), before = fs.readFileSync(log, 'utf8');
  for (const keys of ['c\\ny\\n', 'u\\n\\n\\n']) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../app.mjs', import.meta.url)), '--modern', '--config', config, '--print', '100x40', '--keys', keys],
      { cwd, env: { ...process.env, HERDR_BIN_PATH: herdr }, encoding: 'utf8' });
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
