import test from './helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold, itemStatus, openRuns } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';

const BIN = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const T0 = '2026-09-15T09:00:00Z';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-org-'));
  const dir = path.join(root, '.org');
  const org = (argv, { now = T0, env = {}, cwd = root } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...argv], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ORG_ACTOR: '', ORG_DIR: dir, ORG_NOW: now, TZ: 'UTC', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const ok = (argv, opts) => {
    const r = org(argv, opts);
    assert.equal(r.code, 0, `org ${argv.join(' ')}\n${r.err}${r.out}`);
    return r.out;
  };
  ok(['init', dir]);
  return { dir, org, ok };
}

function report(fields) {
  return `---\n${fields}\n---\nDetails.\n`;
}

function briefWorkspace(t) {
  const f = setup(), root = path.dirname(f.dir), workspace = path.join(root, 'project');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(workspace);
  const git = args => {
    const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-qb', 'main']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'seed']);
  const env = { LANE_CONFIG: undefined, HERDR_MONITOR_FLEET: path.join(root, 'fleet') };
  return { ...f, root, workspace, env };
}

test('CLI ingest publishes no report after exhausted planning conflicts and recovers once', t => {
  const f = briefWorkspace(t), { dir, ok, org, root, workspace, env } = f;
  const item = ok(['add', 'Report publication control'], { env }).trim();
  ok(['start', item, '--workspace', workspace], { env });
  const incoming = path.join(root, 'incoming.md'), stored = path.join(dir, 'reports/R-1.md');
  const text = report('run: R-1\noutcome: done\nsummary: Publication recovered.');
  fs.writeFileSync(incoming, text);
  const events = path.join(dir, 'events.jsonl'), before = fs.readFileSync(events);
  const hook = path.join(root, 'race.mjs');
  // Inject an independent append at every lock acquisition in the real CLI.
  // Exhaust the bounded pure-plan retries before its immutable commit hook.
  fs.writeFileSync(hook, `import fs from 'node:fs';
const mkdir = fs.mkdirSync, lock = ${JSON.stringify(path.join(dir, 'lock'))}, events = ${JSON.stringify(events)};
fs.mkdirSync = function(file, ...args) {
  const result = mkdir.call(this, file, ...args);
  if (file === lock) {
    const rows = fs.readFileSync(events, 'utf8').trim().split('\\n').map(JSON.parse);
    fs.appendFileSync(events, JSON.stringify({seq: rows.at(-1).seq + 1, type: 'future.racer'}) + '\\n');
  }
  return result;
};
`);
  const refused = org(['ingest', incoming], { env: { ...env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(hook)}` } });
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.err, /record planning conflict/);
  assert.equal(fs.existsSync(stored), false, 'a losing plan leaves no immutable report');
  const raced = fs.readFileSync(events);
  assert.deepEqual(raced.subarray(0, before.length), before);
  const additions = raced.subarray(before.length).toString().trim().split('\n').map(JSON.parse);
  assert.equal(additions.length, 32, 'the CLI stops at its bounded retry limit');
  assert.ok(additions.every(e => e.type === 'future.racer'), 'no intake or proposal event escaped');
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
  assert.equal(fold(raced.toString().trim().split('\n').map(JSON.parse)).runs.get('R-1').report, null);
  ok(['ingest', incoming], { env });
  assert.equal(fs.readFileSync(stored, 'utf8'), text);
  const committed = fs.readFileSync(events);
  assert.equal(committed.toString().trim().split('\n').map(JSON.parse).filter(e => e.type === 'report.ingested').length, 1);
  ok(['ingest', incoming], { env });
  assert.deepEqual(fs.readFileSync(events), committed, 'same report intake is idempotent');
});

test('generated briefs use land-first queue review instructions and preserve saved legacy brief bytes',t=>{
  const {dir,ok,workspace,env}=briefWorkspace(t),first=ok(['add','Saved legacy work'],{env}).trim();ok(['start',first,'--workspace',workspace],{env});
  const saved=path.join(dir,'runs/R-1/brief.md'),legacy='Saved immutable brief\nReviewer proposals hold their parent regardless of blocking; promotion requires PASS.\n';fs.writeFileSync(saved,legacy);
  const next=ok(['add','New source work'],{env}).trim();ok(['start',next,'--workspace',workspace],{env});const fresh=fs.readFileSync(path.join(dir,'runs/R-2/brief.md'),'utf8');
  assert.match(fresh,/self-land OWN finished source before checks\/review/);assert.match(fresh,/ONE async record-queue review: cap1, zero reviewer suites/);assert.match(fresh,/do not hold finished source or its parent/);assert.match(fresh,/Fix Majors and check their corrections before final release/);assert.doesNotMatch(fresh,/Reviewer proposals hold their parent|promotion requires PASS/);
  assert.equal(ok(['brief','R-1'],{env}),legacy);assert.equal(fs.readFileSync(saved,'utf8'),legacy);
});

for (const declared of [true, false]) test(`record start and regenerated brief show durable locations ${declared ? 'with an archive' : 'without an archive'}`, t => {
  const { dir, ok, root, workspace, env } = briefWorkspace(t);
  if (declared) fs.writeFileSync(path.join(workspace, '.lane.json'), JSON.stringify({ archive: { dirs: ['docs/reports'] } }));
  // Start outside the workspace and pass a routing-only snapshot, like dispatch.
  // Neither the caller's config nor the frozen route config supplies the archive.
  const route = path.join(root, 'routes.json');
  fs.writeFileSync(route, JSON.stringify({ routes: { engineer: { kind: 'codex' } } }));
  const id = ok(['add', 'Save durable results'], { env }).trim();
  ok(['start', id, '--workspace', workspace, '--route', 'engineer', '--route-config', route], { env });
  const file = path.join(dir, 'runs/R-1/brief.md'), first = fs.readFileSync(file, 'utf8');
  const check = text => {
    assert.match(text, /## Durable locations\n/);
    assert.ok(text.indexOf('## Durable locations') < text.indexOf('## When you stop: write one report'));
    if (declared) {
      assert.ok(text.includes(path.join(workspace, 'docs/reports')));
      assert.match(text, /Durable results go to the archive before the lane closes/);
    } else assert.match(text, /## Durable locations\nNo archive directories resolved\.\n/);
  };
  check(first);
  assert.equal(ok(['brief', 'R-1'], { env }), first);
  fs.unlinkSync(file);
  check(ok(['brief', 'R-1'], { env }));
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

for (const [name, config, reason] of [
  ['malformed JSON', '{\n  "archive":', /invalid lane config/],
  ['invalid archive directories', '{"archive":{"dirs":42}}', /archive\.dirs must be an array/],
  ['invalid routing fields', '{"routes":{"engineer":{"kind":42}}}', /routes\.engineer\.kind/],
]) test(`archive lookup with ${name} cannot block record start or brief regeneration`, t => {
  const { dir, org, ok, workspace, env } = briefWorkspace(t);
  const layer = path.join(workspace, '.lane.json');
  fs.writeFileSync(layer, config);
  const id = ok(['add', 'Work despite unavailable archive'], { env }).trim();
  const started = org(['start', id, '--workspace', workspace], { env });
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /^R-1 started/);
  assert.doesNotMatch(started.err, /\n\s+at /);
  const file = path.join(dir, 'runs/R-1/brief.md');
  const check = text => {
    const section = text.split('## Durable locations\n')[1].split('\n\n')[0];
    assert.equal(section.split('\n').length, 1, 'archive errors occupy one line');
    assert.match(section, /^Archive unavailable: /);
    assert.match(section, reason);
    assert.match(text, /## When you stop: write one report/);
  };
  check(fs.readFileSync(file, 'utf8'));
  assert.equal(JSON.parse(ok(['show', 'R-1', '--json'], { env })).workspace, workspace);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'));
  fs.unlinkSync(file);
  check(ok(['brief', 'R-1'], { env }));
  fs.writeFileSync(layer, JSON.stringify({ archive: { dirs: ['recovered-archive'] } }));
  fs.unlinkSync(file);
  const recovered = ok(['brief', 'R-1'], { env });
  assert.ok(recovered.includes(path.join(workspace, 'recovered-archive')));
  assert.doesNotMatch(recovered, /Archive unavailable/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'events.jsonl')), events, 'brief rendering never appends record events');
});

test('relative LANE_CONFIG uses the caller for routed start and brief regeneration outside the workspace', t => {
  const { dir, ok, root, workspace, env } = briefWorkspace(t);
  const config = { routes: { engineer: { kind: 'codex' } }, archive: { dirs: ['caller-archive'] } };
  fs.writeFileSync(path.join(root, 'explicit.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(workspace, 'explicit.json'), JSON.stringify({ ...config, archive: { dirs: ['wrong-workspace-archive'] } }));
  env.LANE_CONFIG = 'explicit.json';
  const id = ok(['add', 'Use the caller configuration'], { env }).trim();
  ok(['start', id, '--workspace', workspace, '--route', 'engineer'], { env });
  const file = path.join(dir, 'runs/R-1/brief.md');
  const check = text => {
    assert.ok(text.includes(path.join(root, 'caller-archive')));
    assert.doesNotMatch(text, /wrong-workspace-archive|Archive unavailable/);
  };
  check(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(file);
  check(ok(['brief', 'R-1'], { env }));
});

function outcomeEvents(entries) {
  return [{ type: 'item.added', id: 'ENG-1', title: 'Outcome ordering' }, ...entries]
    .map((entry, index) => ({ seq: index + 1, at: T0, by: 'test', ...entry }));
}
const startRun = (id) => ({ type: 'run.started', id, item: 'ENG-1' });
const ingestReport = (run, outcome) => ({ type: 'report.ingested', run, report: { outcome }, sha256: run, file: `${run}.md` });

test('in-order reports keep the newest reported outcome while an unreported run stays active', () => {
  const events = outcomeEvents([
    startRun('R-9'), ingestReport('R-9', 'failed'),
    startRun('R-2'), ingestReport('R-2', 'done'), startRun('R-1'),
  ]);
  const state = fold(events);
  assert.deepEqual(state.items.get('ENG-1').outcome, olderFold(events).items.get('ENG-1').outcome);
  assert.equal(state.items.get('ENG-1').outcome.run, 'R-2');
  assert.equal(state.runs.get('R-9').report.late, false);
  assert.equal(state.runs.get('R-2').report.late, false);
  assert.equal(itemStatus(state, 'ENG-1'), 'active');
  assert.deepEqual(openRuns(state, 'ENG-1').map((run) => run.id), ['R-1']);
});

test('all report ingestion orders select the newest started reported run and retain older late reports', () => {
  for (const order of [
    ['R-9', 'R-2', 'R-1'], ['R-9', 'R-1', 'R-2'],
    ['R-2', 'R-9', 'R-1'], ['R-2', 'R-1', 'R-9'],
    ['R-1', 'R-9', 'R-2'], ['R-1', 'R-2', 'R-9'],
  ]) {
    const starts = ['R-9', 'R-2', 'R-1'];
    const outcomes = { 'R-9': 'needs_human', 'R-2': 'blocked', 'R-1': 'done' };
    const events = outcomeEvents([
      ...starts.map((id, index) => ({ ...startRun(id), at: `2026-09-15T09:00:0${2 - index}Z` })),
      ...order.map((id) => ingestReport(id, outcomes[id])),
    ]);
    for (let count = 1; count <= order.length; count++) {
      const state = fold(events.slice(0, starts.length + 1 + count));
      const seen = order.slice(0, count);
      const winner = starts.findLast((id) => seen.includes(id));
      const winnerEvent = events.find((event) => event.run === winner);
      assert.deepEqual(state.items.get('ENG-1').outcome,
        { value: outcomes[winner], run: winner, at: winnerEvent.at, seq: winnerEvent.seq }, order.join(', '));
      for (const id of seen) {
        const record = state.runs.get(id).report;
        const previous = order.slice(0, order.indexOf(id));
        assert.equal(record.late, previous.some((other) => starts.indexOf(other) > starts.indexOf(id)));
        assert.equal(record.outcome, outcomes[id]);
        assert.equal(record.sha256, id);
        assert.equal(record.file, `${id}.md`);
      }
    }
    assert.equal(itemStatus(fold(events), 'ENG-1'), 'done');
  }
});

test('abandonment leaves the last reported outcome intact and historical abandoned reports still fold', () => {
  const events = outcomeEvents([
    startRun('R-1'), ingestReport('R-1', 'done'), startRun('R-2'),
    { type: 'run.abandoned', id: 'R-2', note: 'session stopped' },
  ]);
  const state = fold(events);
  assert.deepEqual(state.items.get('ENG-1').outcome, olderFold(events).items.get('ENG-1').outcome);
  assert.equal(state.runs.get('R-2').report, null);
  assert.equal(itemStatus(state, 'ENG-1'), 'done');
  assert.deepEqual(openRuns(state, 'ENG-1'), []);
  // Historical logs may contain accepted late reports from abandoned runs.
  const historical = [...events, { ...ingestReport('R-2', 'blocked'), seq: 6, at: T0, late: true }];
  assert.deepEqual(fold(historical).items.get('ENG-1').outcome, olderFold(historical).items.get('ENG-1').outcome);
  assert.equal(fold(historical).runs.get('R-2').report.late, true);
  const corrected = [...historical, { ...startRun('R-3'), seq: 7, at: T0 },
    { ...ingestReport('R-3', 'done'), seq: 8, at: T0 }];
  assert.equal(fold(corrected).items.get('ENG-1').outcome.run, 'R-3');
  const lateAbandoned = outcomeEvents([
    startRun('R-1'), { type: 'run.abandoned', id: 'R-1' },
    startRun('R-2'), ingestReport('R-2', 'done'), { ...ingestReport('R-1', 'blocked'), late: true },
  ]);
  assert.equal(fold(lateAbandoned).items.get('ENG-1').outcome.run, 'R-2');
  assert.ok(fold(lateAbandoned).runs.get('R-1').abandoned);
  assert.equal(fold(lateAbandoned).runs.get('R-1').report.late, true);
});

test('reopening still clears completion and unknown events are ignored by current and older folds', () => {
  const events = outcomeEvents([startRun('R-1'), ingestReport('R-1', 'done'), { type: 'item.reopened', id: 'ENG-1' }]);
  const unknown = { type: 'future.unknown', seq: 5, at: T0, item: 'ENG-1', outcome: 'failed' };
  for (const readFold of [fold, olderFold]) {
    const state = readFold([...events, unknown]);
    assert.equal(state.items.get('ENG-1').outcome, null);
    assert.deepEqual(state.items, readFold(events).items);
    assert.deepEqual(state.runs, readFold(events).runs);
  }
  const next = outcomeEvents([...events.slice(1), startRun('R-2'), ingestReport('R-2', 'blocked')]);
  assert.equal(fold(next).items.get('ENG-1').outcome.run, 'R-2');
  const staleAfterReopen = outcomeEvents([
    startRun('R-1'), startRun('R-2'), ingestReport('R-2', 'done'),
    { type: 'item.reopened', id: 'ENG-1' }, ingestReport('R-1', 'failed'),
  ]);
  assert.equal(fold(staleAfterReopen).items.get('ENG-1').outcome, null);
  assert.equal(itemStatus(fold(staleAfterReopen), 'ENG-1'), 'ready');
  assert.equal(fold(staleAfterReopen).runs.get('R-1').report.late, true);
  const afterRework = outcomeEvents([
    ...staleAfterReopen.slice(1), startRun('R-3'), ingestReport('R-3', 'blocked'),
  ]);
  assert.deepEqual(fold(afterRework).items.get('ENG-1').outcome,
    { value: 'blocked', run: 'R-3', at: T0, seq: 8 });
  assert.equal(itemStatus(fold(afterRework), 'ENG-1'), 'blocked');
  // The newest run's own report may arrive after a reopen even if it started
  // before that reopen; only the older report must leave the reopen intact.
  const newestAfterReopen = outcomeEvents([
    startRun('R-1'), ingestReport('R-1', 'done'), startRun('R-2'),
    { type: 'item.reopened', id: 'ENG-1' }, ingestReport('R-2', 'needs_human'),
  ]);
  assert.equal(fold(newestAfterReopen).items.get('ENG-1').outcome.run, 'R-2');
  assert.equal(itemStatus(fold(newestAfterReopen), 'ENG-1'), 'needs_human');
});

// Operator priorities (P-n, --serves) were retired. Records that used them must
// keep loading: the fold ignores their events and views show only the type name.
test('a record with retired priority events and run alignment still loads in every view', () => {
  const t = setup();
  const id = t.ok(['add', 'Keep working']).trim();
  t.ok(['start', id, '--harness', 'h', '--model', 'm', '--effort', 'e', '--meta', 'serves=P-1']);
  const file = path.join(t.dir, 'events.jsonl');
  const seq = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  fs.appendFileSync(file, [
    { seq: seq + 1, at: T0, by: 'human', type: 'priority.added', id: 'P-1', title: 'Old outcome', why: 'History' },
    { seq: seq + 2, at: T0, by: 'human', type: 'priorities.ranked', order: ['P-1'], previous: [], why: 'History' },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  const status = JSON.parse(t.ok(['status', '--json']));
  assert.equal(status.events, seq + 2); assert.equal(Object.hasOwn(status, 'priorities'), false);
  assert.equal(status.runs[0].meta.serves, 'P-1', 'alignment stays opaque run metadata');
  assert.match(t.ok(['log']), /priority\.added[\s\S]*priorities\.ranked/);
  for (const view of [['status'], ['show', id], ['show', 'R-1', '--json'], ['today', '--json'], ['snapshot'], ['brief', 'R-1']]) {
    assert.doesNotMatch(t.ok(view), /operator priorit/i, view.join(' '));
  }
  for (const retired of [['priorities'], ['recap'], ['digest'], ['console']]) {
    const r = t.org(retired); assert.equal(r.code, 1); assert.match(r.err, /unknown command/);
  }
  const start = t.org(['start', id, '--serves', 'P-1']); assert.equal(start.code, 1);
  t.ok(['note', id, 'Still writable']);
});

test('ingesting an older report after a correction records it as late without displacing the correction', () => {
  const { dir, ok } = setup();
  ok(['add', 'Correct the implementation', '--role', 'engineer']);
  ok(['start', 'ENG-1']);
  ok(['start', 'ENG-1']);
  const oldFile = path.join(dir, 'runs/R-1/report.md');
  const newFile = path.join(dir, 'runs/R-2/report.md');
  fs.writeFileSync(oldFile, report('run: R-1\noutcome: needs_human\nsummary: Original implementation needs judgment.'));
  fs.writeFileSync(newFile, report('run: R-2\noutcome: done\nsummary: Correction completed.'));
  ok(['ingest', newFile]);
  assert.match(ok(['ingest', oldFile]), /late: a newer run already has a report/);
  const item = JSON.parse(ok(['show', 'ENG-1', '--json']));
  assert.equal(item.outcome.run, 'R-2');
  assert.equal(item.status, 'done');
  assert.equal(JSON.parse(ok(['show', 'R-1', '--json'])).report.late, true);
  const event = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .findLast((event) => event.type === 'report.ingested');
  assert.equal(event.run, 'R-1');
  assert.equal(event.late, true);
  assert.equal(fs.readFileSync(path.join(dir, 'reports/R-1.md'), 'utf8'), fs.readFileSync(oldFile, 'utf8'));
  assert.match(ok(['ingest', oldFile]), /report already recorded/);
});

test('a blocked worker decomposes its own blocker and fresh runs pick up the thread', () => {
  const { dir, ok } = setup();
  assert.equal(ok(['add', '--goal', 'Rate limiting shipped']).trim(), 'G-1');
  assert.equal(ok(['add', 'Persist rate-limit state', '--parent', 'G-1', '--role', 'engineer',
    '--capability', 'deep', '--accept', 'survives restart']).trim(), 'ENG-1');

  const started = ok(['start', 'ENG-1', '--harness', 'claude-code', '--model', 'opus'], { now: '2026-09-15T09:05:00Z' });
  assert.match(started, /^R-1 started on ENG-1/);
  const brief1 = fs.readFileSync(path.join(dir, 'runs/R-1/brief.md'), 'utf8');
  assert.match(brief1, /Persist rate-limit state/);
  assert.match(brief1, /survives restart/);
  assert.match(brief1, /run: R-1/);

  fs.writeFileSync(path.join(dir, 'runs/R-1/report.md'), report(`run: R-1
outcome: blocked
summary: Cannot choose between SQLite and Redis without an architecture decision.
blockers:
  - storage backend is undecided
proposals:
  - role: architect
    title: Decide the rate-limit storage backend
    why: ENG-1 needs it
learnings:
  - The CI image has no Redis`));
  const first = ok(['sync'], { now: '2026-09-15T09:40:00Z' });
  assert.match(first, /R-1 → blocked on ENG-1/);
  assert.match(first, /\+ ARCH-1 "Decide the rate-limit storage backend" \(architect\) blocks ENG-1/);
  assert.match(first, /ENG-1 is now blocked/);
  assert.match(ok(['sync']), /nothing to record/);

  ok(['set', 'ARCH-1', 'meta.queue_selected=true']);
  ok(['start', 'ARCH-1', '--harness', 'codex', '--model', 'gpt-5'], { now: '2026-09-15T10:00:00Z' });
  const brief2 = fs.readFileSync(path.join(dir, 'runs/R-2/brief.md'), 'utf8');
  assert.match(brief2, /ENG-1 needs it/);
  assert.match(brief2, /Parent item[\s\S]*Cannot choose between SQLite and Redis/);
  assert.match(brief2, /learned: The CI image has no Redis/);
  fs.writeFileSync(path.join(dir, 'runs/R-2/report.md'), report(`run: R-2
outcome: done
summary: Chose SQLite; ADR-7 records why Redis was rejected.
artifacts:
  - docs/adr/0007-storage.md`));
  assert.match(ok(['sync'], { now: '2026-09-15T10:30:00Z' }), /ENG-1 is no longer blocked by ARCH-1 \(now ready\)/);
  ok(['note', 'ARCH-1', '--decision', 'SQLite for rate-limit state (ADR-7)'], { now: '2026-09-15T10:31:00Z' });

  ok(['start', 'ENG-1', '--harness', 'gemini'], { now: '2026-09-15T11:00:00Z' });
  const brief3 = fs.readFileSync(path.join(dir, 'runs/R-3/brief.md'), 'utf8');
  assert.match(brief3, /Earlier runs on this item[\s\S]*R-1/);
  assert.match(brief3, /The CI image has no Redis/);
  assert.match(brief3, /Chose SQLite/);
  assert.match(brief3, /SQLite for rate-limit state/);
  fs.writeFileSync(path.join(dir, 'runs/R-3/report.md'), report(`run: R-3
outcome: done
summary: Rate-limit state persisted in SQLite and survives restart.
proposals:
  - role: reviewer
    title: Independent review of ENG-1
    blocking: false`));
  const reviewIngest = ok(['sync'], { now: '2026-09-15T12:00:00Z' });
  assert.match(reviewIngest, /\+ REV-1 "Independent review of ENG-1" \(reviewer\)/);
  assert.doesNotMatch(reviewIngest, /blocks ENG-1/);

  const status = ok(['status'], { now: '2026-09-15T12:05:00Z' });
  assert.match(status, /G-1\s+Rate limiting shipped\s+2 done · 1 proposed/);
  assert.match(status, /PROPOSAL NOTES\n\s+REV-1\s+Independent review of ENG-1/);
  assert.doesNotMatch(status, /BLOCKED\n\s+ENG-1/);

  const snap = ok(['snapshot'], { now: '2026-09-15T12:05:00Z' });
  assert.match(snap, /## Decisions\n- ARCH-1 .*SQLite for rate-limit state/);
  assert.match(snap, /## Recent learnings\n- The CI image has no Redis \(R-1 on ENG-1\)/);
  assert.equal(ok(['snapshot'], { now: '2026-09-15T12:05:00Z' }), snap, 'snapshots are deterministic');

  // Nothing but the directory is needed: a copy yields the same organization.
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-org-copy-')), '.org');
  fs.cpSync(dir, copy, { recursive: true });
  const fromCopy = spawnSync(process.execPath, [BIN, 'snapshot'], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: '', ORG_DIR: copy, ORG_NOW: '2026-09-15T12:05:00Z', TZ: 'UTC' },
  });
  assert.equal(fromCopy.stdout.replaceAll(copy, dir), snap);
});

test('record start resolves a named route without copied harness metadata', () => {
  const { dir, org, ok } = setup();
  ok(['add', 'Implement routing', '--role', 'engineer']);
  const routeConfig = path.join(path.dirname(dir), 'routes.json');
  fs.writeFileSync(routeConfig, JSON.stringify({
    dispatch: { kind: 'claude', model: 'default', effort: 'medium' },
    routes: {
      engineer: { kind: 'codex', model: 'gpt-route', effort: 'xhigh' },
    },
  }));

  const started = ok(['start', 'ENG-1', '--route', 'engineer', '--route-config', routeConfig]);
  assert.match(started, /\[codex · gpt-route · xhigh\]/);
  const event = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse).findLast((entry) => entry.type === 'run.started');
  assert.deepEqual(
    { route: event.meta.route, harness: event.meta.harness, model: event.meta.model, effort: event.meta.effort },
    { route: 'engineer', harness: 'codex', model: 'gpt-route', effort: 'xhigh' },
  );

  const copied = org(['start', 'ENG-1', '--route', 'engineer', '--route-config', routeConfig, '--model', 'other']);
  assert.equal(copied.code, 1);
  assert.match(copied.err, /--route cannot be combined with --model/);
  const orphanConfig = org(['start', 'ENG-1', '--route-config', routeConfig]);
  assert.equal(orphanConfig.code, 1);
  assert.match(orphanConfig.err, /--route-config requires --route/);

  // The core may copy declared metadata but may not interpret native CLI args.
  fs.writeFileSync(routeConfig, JSON.stringify({ routes: {
    legacy: { kind: 'codex', model: 'gpt-route', args: ['-c', 'model_reasoning_effort=high'] },
  } }));
  ok(['start', 'ENG-1', '--route', 'legacy', '--route-config', routeConfig]);
  const legacy = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse).findLast((entry) => entry.type === 'run.started');
  assert.equal(legacy.meta.harness, 'codex');
  assert.equal(legacy.meta.effort, undefined);
});

test('record start discovers canonical parent and repository routes from a linked worktree', (t) => {
  const { dir, ok } = setup();
  const root = path.dirname(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const linked = path.join(root, 'elsewhere', 'linked');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: {
      ...process.env, ORG_ACTOR: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Route Tests', GIT_AUTHOR_EMAIL: 'routes@example.invalid',
      GIT_COMMITTER_NAME: 'Route Tests', GIT_COMMITTER_EMAIL: 'routes@example.invalid',
    } });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  git(['-C', repo, 'add', 'tracked.txt']);
  git(['-C', repo, 'commit', '-m', 'initial']);
  git(['-C', repo, 'worktree', 'add', '-b', 'lane/test', linked]);
  fs.writeFileSync(path.join(root, '.lane.json'), JSON.stringify({
    dispatch: { kind: 'opaque-harness', model: 'parent-model', effort: 'parent-effort' },
    routes: { inherited: {}, engineer: { model: 'replaced-parent-model' } },
  }));
  // Written after worktree creation: reading the linked copy cannot pass this.
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({
    routes: { engineer: { model: 'repo-model', effort: 'repo-effort' } },
  }));
  fs.writeFileSync(path.join(root, 'elsewhere', '.lane.json'), JSON.stringify({
    dispatch: { kind: 'wrong-harness' }, routes: { inherited: {}, engineer: {} },
  }));
  ok(['add', 'Test discovery', '--role', 'engineer']);
  for (const [route, model, effort] of [
    ['engineer', 'repo-model', 'repo-effort'], ['inherited', 'parent-model', 'parent-effort'],
  ]) {
    ok(['start', 'ENG-1', '--route', route], { cwd: linked, env: { LANE_CONFIG: undefined } });
    const event = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse).findLast((entry) => entry.type === 'run.started');
    assert.deepEqual(event.meta, { route, harness: 'opaque-harness', model, effort });
  }
});

test('record start discovers the nearest route config from a non-Git record root', (t) => {
  const { dir, ok } = setup();
  const root = path.dirname(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.lane.json'), JSON.stringify({
    dispatch: { kind: 'opaque', model: 'root-model', effort: 'root-effort' },
    routes: { engineer: {} },
  }));
  ok(['add', 'Test record root', '--role', 'engineer']);
  for (const cwd of [root, dir]) {
    ok(['start', 'ENG-1', '--route', 'engineer'], { cwd, env: { LANE_CONFIG: undefined } });
    const event = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse).findLast((entry) => entry.type === 'run.started');
    assert.equal(event.meta.effort, 'root-effort');
    assert.equal(event.meta.model, 'root-model');
  }
});

test('budgets are advisory: exceeding them is surfaced, never refused', () => {
  const { dir, ok } = setup();
  ok(['add', 'Explore caching', '--role', 'researcher', '--budget', 'max_children=1', '--budget', 'max_runs=1']);
  ok(['start', 'RES-1']);
  fs.writeFileSync(path.join(dir, 'runs/R-1/report.md'), report(`run: R-1
outcome: failed
summary: The obvious approach did not pan out, but three directions look promising.
proposals:
  - researcher: Try an LRU in front of the store
  - researcher: Measure hit rates in production logs
  - researcher: Survey CDN-level caching`));
  const synced = ok(['sync']);
  assert.match(synced, /\+ RES-4 "Survey CDN-level caching"/);
  assert.match(synced, /note: RES-1 3 child items \(expected ≤ 1\); recorded, not refused/);

  const again = ok(['start', 'RES-1']);
  assert.match(again, /^R-2 started on RES-1/);
  assert.match(again, /note: RES-1 2 runs \(expected ≤ 1\)/);
  assert.match(ok(['status']), /ATTENTION\n\s+RES-1\s+2 runs \(expected ≤ 1\)\n\s+RES-1\s+3 child items/);
});

test('only record consistency is refused', () => {
  const { dir, ok, org } = setup();
  ok(['add', 'A', '--role', 'engineer']);
  ok(['add', 'B', '--role', 'engineer', '--blocked-by', 'ENG-1']);
  let r = org(['block', 'ENG-1', '--by', 'ENG-2']);
  assert.equal(r.code, 1);
  assert.match(r.err, /blocking cycle/);
  assert.equal(org(['add', 'C', '--parent', 'NOPE-9']).code, 1);
  assert.match(org(['set', 'ENG-1', 'budget.max_kids=2']).err, /unknown budget key/);

  ok(['start', 'ENG-1']);
  const file = path.join(dir, 'runs/R-1/report.md');
  fs.writeFileSync(file, report('run: R-1\noutcome: done\nsummary: First.'));
  ok(['ingest', file]);
  assert.match(ok(['ingest', file]), /already recorded/);
  fs.writeFileSync(file, report('run: R-1\noutcome: failed\nsummary: A different story.'));
  r = org(['ingest', file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already has a report/);
  r = org(['ingest', file, '--run', 'R-9']);
  assert.equal(r.code, 1);
  assert.match(r.err, /says run R-1 but --run is R-9/);
  assert.match(ok(['status']), /READY\n\s+ENG-2/);
});

test('record set refuses to change a run start fact but may add keys or repeat one', () => {
  const { dir, ok, org } = setup();
  ok(['add', 'A', '--role', 'engineer']);
  ok(['start', 'ENG-1', '--harness', 'h', '--model', '5', '--effort', 'true', '--meta', 'receipt=none', '--meta', 'lane=topic']);
  for (const pair of ['receipt=full', 'meta.receipt=full', 'model=6', 'lane=']) {
    const r = org(['set', 'R-1', pair]);
    assert.equal(r.code, 1, pair);
    assert.match(r.err, /R-1 was started with (receipt|model|lane); start facts cannot change/);
  }
  assert.match(ok(['set', 'R-1', 'receipt=none', 'model=5', 'effort=true']), /^R-1 unchanged$/m);
  ok(['set', 'R-1', 'receipt=none', 'lane=topic', 'model=5', 'agent=w1', 'tokens_in=12']);
  ok(['set', 'R-1', 'agent=w2']);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((e) => e.type === 'run.updated').map((e) => e.meta), [{ agent: 'w1', tokens_in: 12 }, { agent: 'w2' }]);
  assert.deepEqual(fold(events).runs.get('R-1').meta, { receipt: 'none', lane: 'topic', harness: 'h', model: '5', effort: 'true', agent: 'w2', tokens_in: 12 });
});

test('dropping a blocker unblocks the work it was blocking', () => {
  const { ok } = setup();
  ok(['add', 'Ship it', '--role', 'engineer']);
  ok(['add', 'Maybe needed', '--role', 'researcher']);
  ok(['block', 'ENG-1', '--by', 'RES-1']);
  assert.match(ok(['status']), /BLOCKED\n\s+ENG-1\s+Ship it\s+← RES-1 ready/);
  ok(['close', 'RES-1', '--dropped', '--note', 'not needed after all']);
  assert.match(ok(['status']), /READY\n\s+ENG-1/);
});

test('a brief shows sibling work and points at full reports', () => {
  const { dir, ok } = setup();
  ok(['add', 'Parent', '--role', 'engineer']);
  ok(['start', 'ENG-1']);
  fs.writeFileSync(path.join(dir, 'runs/R-1/report.md'), report(`run: R-1
outcome: blocked
summary: Two open questions.
proposals:
  - architect: Decide storage
  - researcher: Measure latency`));
  ok(['sync']);
  ok(['set', 'ARCH-1', 'meta.queue_selected=true']);
  ok(['start', 'ARCH-1']);
  const brief = fs.readFileSync(path.join(dir, 'runs/R-2/brief.md'), 'utf8');
  assert.match(brief, /Related items \(same parent\)\n- \*\*RES-1\*\* Measure latency — proposed/);
  assert.match(brief, /full report: `record show R-1`/);
});

test('an abandoned run frees its item and a late report is not ingested', () => {
  const { dir, ok } = setup();
  ok(['add', 'Flaky investigation', '--role', 'researcher']);
  ok(['start', 'RES-1', '--harness', 'codex']);
  assert.match(ok(['status']), /ACTIVE\n\s+RES-1.*R-1 \(codex\)/);
  assert.match(ok(['abandon', 'R-1', '--note', 'session died']), /a later report will not be ingested/);
  assert.match(ok(['status']), /READY\n\s+RES-1/);
  ok(['start', 'RES-1', '--harness', 'claude-code']);
  const late = path.join(dir, 'runs/R-1/report.md');
  fs.writeFileSync(late, report('run: R-1\noutcome: done\nsummary: Finished after all.'));
  assert.match(ok(['ingest', late, '--run', 'R-1']), /R-1: report skipped because the run was abandoned/);
  fs.writeFileSync(late, 'not even a valid report\n');
  assert.match(ok(['sync']), /R-1: report skipped because the run was abandoned; it will not be ingested/);
  assert.match(ok(['show', 'RES-1']), /R-1 .*abandoned/);
  assert.equal(fs.existsSync(path.join(dir, 'reports/R-1.md')), false);
});

test('an interrupted write is ignored on read and repaired on the next write', () => {
  const { dir, ok } = setup();
  ok(['add', 'First']);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":2,"at":"2026-09');
  assert.match(ok(['status']), /W-1\s+First/);
  assert.equal(ok(['add', 'Second']).trim(), 'W-2');
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
});

test('concurrent writers never collide', async (t) => {
  const { dir } = setup();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => {
    const child = spawnChild(t, process.execPath, [BIN, 'add', `Parallel ${i}`, '--role', 'engineer'], {
      env: { ...process.env, ORG_ACTOR: '', ORG_DIR: dir, TZ: 'UTC' },
    });
    return waitForExit(child).then(({ code, stdout }) => ({ code, id: stdout.trim() }));
  }));
  assert.ok(results.every((r) => r.code === 0));
  assert.equal(new Set(results.map((r) => r.id)).size, 12);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 12 }, (_, i) => i + 1));
});

test('log filters by time and starting closed work reopens it', () => {
  const { ok } = setup();
  ok(['add', 'Old'], { now: '2026-09-15T08:00:00Z' });
  ok(['add', 'New'], { now: '2026-09-15T10:00:00Z' });
  const since = ok(['log', '--since', '09:00'], { now: '2026-09-15T11:00:00Z' });
  assert.doesNotMatch(since, /Old/);
  assert.match(since, /added W-2 "New"/);
  assert.match(ok(['log', '--since', '2h'], { now: '2026-09-15T11:00:00Z' }), /W-2/);
  ok(['close', 'W-1']);
  assert.match(ok(['start', 'W-1']), /W-1 was closed; reopened/);
});
