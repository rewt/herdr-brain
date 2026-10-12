// Installed CLI contract used by bch-cloak's dispatch, notify, review and settle scripts.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupOrg, report } from './helpers.mjs';
import { copyProduct } from '../lib/product-files.mjs';
import { fold } from '../lib/state.mjs';
import { completionFingerprint } from '../lib/completion.mjs';

test('bch-cloak subcommands, output parsers, event fields and compatibility paths remain usable', t => {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const actor = { env: { ORG_ACTOR: 'bch-contract' } };
  const ok = args => f.ok(args, actor), json = args => JSON.parse(ok(args));
  assert.equal(ok(['add', '--goal', 'Control project']).split(/\s/)[0], 'G-1');
  const added = ok(['add', 'Implement control', '--role', 'engineer', '--parent', 'G-1', '--priority', '42']);
  const item = added.split(/\s/)[0]; assert.equal(item, 'ENG-1');
  const file = path.join(f.dir, 'runs/R-1/report.md');
  ok(['start', item, '--harness', 'codex', '--model', 'M', '--effort', 'E', '--workspace', f.root, '--report', file,
    ...['agent=control-worker', 'lane=control', 'route=engineer', 'pane=p1', 'dispatch_token=token', 'start_head=' + 'a'.repeat(40), 'start_branch=lane/control'].flatMap(v => ['--meta', v])]);
  ok(['set', 'R-1', 'settled_by=control-reviewer']);
  assert.match(ok(['show', 'R-1']), /state: open/);
  assert.ok(ok(['show', 'R-1']).includes(`report path: ${file}`));
  assert.match(ok(['show', item]), /^ENG-1  Implement control\n/);
  assert.match(ok(['show', item]), /status: active/);
  let run = json(['show', 'R-1', '--json']);
  assert.equal(run.item, item); assert.equal(run.report_path, file); assert.equal(run.meta.harness, 'codex');
  assert.equal(run.meta.model, 'M'); assert.equal(run.meta.effort, 'E'); assert.equal(run.meta.settled_by, 'control-reviewer');
  assert.equal(fs.existsSync(run.brief_path), true);
  const view = json(['show', item, '--json']);
  assert.equal(view.role, 'engineer'); assert.equal(view.status, 'active'); assert.deepEqual(view.children, []);
  assert.deepEqual(json(['show', 'G-1', '--json']).children, [item]);
  ok(['note', item, 'Review evidence is ready']); assert.match(ok(['brief', 'R-1']), /Implement control/);
  const blocker = ok(['add', 'Dependency', '--role', 'engineer', '--parent', 'G-1', '--priority', '7']).split(/\s/)[0];
  ok(['block', item, '--by', blocker]); assert.deepEqual(json(['show', item, '--json']).blocked_by, [blocker]);
  ok(['unblock', item, '--by', blocker]);
  const question = ok(['ask', 'Proceed?', '--parent', 'G-1', '--category', 'design', '--recommend', 'yes', '--why', 'Control waits']).trim();
  ok(['answer', question, 'yes']); ok(['answer', question, 'no', '--overrule']);
  assert.equal(json(['show', question, '--json']).meta.answer, 'no');
  const product = path.join(f.root, 'product'); copyProduct(path.resolve(import.meta.dirname, '..'), product);
  const bin = path.join(f.root, 'fake-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(product, 'bin/org.mjs')}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
case "$1 $2" in
  "agent get") exit 1 ;;
  "workspace list") echo '${JSON.stringify({result:{workspaces:[{workspace_id:'w1',worktree:{is_linked_worktree:false,checkout_path:f.root}}]}})}' ;;
  *) echo '{"result":{"agents":[],"tabs":[],"panes":[]}}' ;;
esac
`, { mode: 0o755 });
  const checklist = path.join(f.root, 'CHECKLIST.md'); fs.writeFileSync(checklist, '# Review');
  const launcher = path.join(bin, 'launcher'), cmem = path.join(bin, 'cmem');
  fs.writeFileSync(launcher, `#!/bin/sh\necho CLAUDE_CONFIG_DIR=${f.root}/claude\n`, { mode: 0o755 });
  fs.writeFileSync(cmem, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const config = path.join(f.root, 'lane.json'); fs.writeFileSync(config, '{}');
  const watch = spawnSync(process.execPath, [path.join(product, 'contrib/settle-watch.mjs'), 'R-1', '--dry-run', '--lane-config', config, '--model', 'M', '--effort', 'E', '--org', f.dir, '--cwd', f.root, '--checklist', checklist, '--launcher', launcher, '--cmem-domain', cmem],
    { cwd: f.root, encoding: 'utf8', env: { ...process.env, HOME: f.root, ORG_DIR: f.dir, ORG_ACTOR: 'bch-contract', PATH: `${bin}:${process.env.PATH}` }, timeout: 10000 });
  assert.equal(watch.status, 0, watch.stdout + watch.stderr);
  assert.match(watch.stdout, /\[dry-run\] start agent:.*--model M.*--effort E/);
  const reconcile = spawnSync(process.execPath, [path.join(product, 'supervisor/reconcile.mjs')], { encoding: 'utf8', timeout: 10000 });
  assert.match(reconcile.stdout + reconcile.stderr, /usage: reconcile.mjs prepare\|finish/i);
  const doc = report('run: R-1\noutcome: done\nsummary: Control completed.\nheadline: Control completed');
  fs.writeFileSync(file, doc); assert.match(ok(['check', file]), /^ok:/);
  ok(['ingest', file, '--run', 'R-1']); ok(['sync']);
  ok(['close', item]); ok(['reopen', item, '--note', 'Follow-up control']);
  ok(['start', blocker]); ok(['abandon', 'R-2', '--note', 'No longer required']);
  const status = json(['status', '--json']);
  for (const field of ['report', 'abandoned', 'meta', 'report_path']) assert.ok(Object.hasOwn(status.runs[0], field), field);
  for (const field of ['id', 'status', 'priority', 'role', 'title', 'blocked_by', 'meta']) assert.ok(Object.hasOwn(status.items.find(i => i.id === item), field), field);
  assert.equal(status.runs.find(r => r.id === 'R-2').abandoned.note, 'No longer required');
  const state = fold(f.events()), receipt = path.join(f.root, 'completion.json');
  fs.writeFileSync(receipt, JSON.stringify({ version: 1, batch: 'control', org: fs.realpathSync(f.dir), identity: path.join(f.root, '.git'), base: 'a'.repeat(40), tip: 'b'.repeat(40),
    gate: { exit_code: 0, log: path.join(f.root, 'gate.log'), sha256: 'c'.repeat(64) },
    items: [{ item, run: 'R-1', head: 'b'.repeat(40), expected: completionFingerprint(state, item), why: 'Reviewed control', superseded: [] }], excluded: [] }));
  assert.deepEqual(json(['complete-batch', '--file', receipt]).items, [item]);
  assert.equal(json(['show', item, '--json']).status, 'done');
  const events = f.events();
  for (const type of ['run.started', 'run.updated', 'run.abandoned', 'item.added', 'item.closed', 'item.reopened', 'note.added']) assert.ok(events.some(e => e.type === type));
  for (const field of ['seq', 'at', 'by']) assert.ok(events.every(e => Object.hasOwn(e, field)));
  assert.equal(events.find(e => e.type === 'run.started').by, 'bch-contract');
  const started = events.find(e => e.type === 'run.started');
  for (const field of ['id', 'item', 'workspace', 'report_path', 'brief_path', 'meta']) assert.ok(Object.hasOwn(started, field));
});

test('old release events still fold and list, while release mutations are unavailable', t => {
  const f = setupOrg(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const events = [
    { type: 'release.cut', id: 'RC-1', identity: '/old/.git', tag: 'old', commit: 'a'.repeat(40), snapshot: '/old/snapshot' },
    { type: 'release.gate.started', id: 'RC-1' },
    { type: 'release.gate.finished', id: 'RC-1', gate: { result: 'failed', log: '/old/log' } },
    { type: 'future.unknown', opaque: true },
  ];
  fs.appendFileSync(path.join(f.dir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ ...e, seq: i + 2, at: '2026-09-15T09:00:00Z', by: 'legacy' })).join('\n') + '\n');
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl'), 'utf8');
  const rows = f.json(['releases', '--json']).candidates;
  assert.equal(rows[0].status, 'gate-failed'); assert.equal(rows[0].started.seq, 3);
  assert.match(f.ok(['releases']), /RC-1 old.*gate failed/);
  assert.match(f.fail(['release', 'cut']), /unknown command/i);
  assert.equal(fs.readFileSync(path.join(f.dir, 'events.jsonl'), 'utf8'), before);
});
