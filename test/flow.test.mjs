import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const T0 = '2026-09-15T09:00:00Z';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-org-'));
  const dir = path.join(root, '.org');
  const org = (argv, { now = T0, env = {} } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...argv], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ORG_DIR: dir, ORG_NOW: now, TZ: 'UTC', ...env },
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
    title: Independent review of ENG-1`));
  ok(['sync'], { now: '2026-09-15T12:00:00Z' });

  const status = ok(['status'], { now: '2026-09-15T12:05:00Z' });
  assert.match(status, /G-1\s+Rate limiting shipped\s+2 done · 1 ready/);
  assert.match(status, /READY\n\s+REV-1\s+Independent review of ENG-1/);
  assert.match(status, /RECENTLY DONE[\s\S]*ENG-1/);

  const snap = ok(['snapshot'], { now: '2026-09-15T12:05:00Z' });
  assert.match(snap, /## Decisions\n- ARCH-1 .*SQLite for rate-limit state/);
  assert.match(snap, /## Recent learnings\n- The CI image has no Redis \(R-1 on ENG-1\)/);
  assert.equal(ok(['snapshot'], { now: '2026-09-15T12:05:00Z' }), snap, 'snapshots are deterministic');

  // Nothing but the directory is needed: a copy yields the same organization.
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-org-copy-')), '.org');
  fs.cpSync(dir, copy, { recursive: true });
  const fromCopy = spawnSync(process.execPath, [BIN, 'snapshot'], {
    encoding: 'utf8',
    env: { ...process.env, ORG_DIR: copy, ORG_NOW: '2026-09-15T12:05:00Z', TZ: 'UTC' },
  });
  assert.equal(fromCopy.stdout.replaceAll(copy, dir), snap);
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
  ok(['start', 'ARCH-1']);
  const brief = fs.readFileSync(path.join(dir, 'runs/R-2/brief.md'), 'utf8');
  assert.match(brief, /Related items \(same parent\)\n- \*\*RES-1\*\* Measure latency — ready/);
  assert.match(brief, /full report: `org show R-1`/);
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

test('concurrent writers never collide', async () => {
  const { dir } = setup();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'add', `Parallel ${i}`, '--role', 'engineer'], {
      env: { ...process.env, ORG_DIR: dir, TZ: 'UTC' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, id: stdout.trim() }));
  })));
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
