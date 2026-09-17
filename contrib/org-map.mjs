#!/usr/bin/env node
// org-map: what an organization is working on, and how its gates shape that.
//
// Answers, in one screen: which stage is open, what sits in each stage, what is
// running right now and under which stage, what the open stage is waiting on,
// and what is waiting on the operator. Read-only; it never writes.
//
//   contrib/org-map.mjs --org <dir> [--stage N] [--json] [--no-herdr]
//
// The read model for the console's structure screen (spec-waiting-on-you-0.0.3).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const orgDir = value('--org', process.env.ORG_DIR);
if (!orgDir) {
  process.stderr.write('org-map: pass --org <dir> or set ORG_DIR\n');
  process.exit(2);
}
const orgBin = process.env.HERDR_ORG_BIN
  ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'org.mjs');

function run(bin, argv) {
  return execFileSync(bin, argv, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ORG_DIR: orgDir },
  });
}

const status = JSON.parse(run(orgBin, ['status', '--json']));

// Herdr's live agents, so a run can be shown as a session the operator can go to.
let agents = [];
if (!flag('--no-herdr')) {
  try {
    agents = JSON.parse(execFileSync('herdr', ['agent', 'list'], { encoding: 'utf8' })).result.agents;
  } catch { agents = []; }
}
const agentByName = new Map(agents.filter((a) => a.name).map((a) => [a.name, a]));

const items = new Map(status.items.map((i) => [i.id, i]));
const open = status.items.filter((i) => !i.closed);
const stageOf = (i) => (i?.meta?.stage == null ? null : String(i.meta.stage));

// The open stage: whichever goal carries stage_now.
const ladderSource = status.items.find((i) => i.meta?.stage_now != null);
const openStage = ladderSource ? String(ladderSource.meta.stage_now) : null;

// Stage names come from the goal that owns each stage.
const stageName = new Map();
for (const i of status.items) {
  const s = stageOf(i);
  if (s && i.kind === 'goal') stageName.set(s, i.title.replace(/^Stage\s+\S+\s*[—-]\s*/i, '').trim());
}

// Runs still open: started, no report, not abandoned.
const openRuns = status.runs.filter((r) => !r.report && !r.abandoned);
const runsByItem = new Map();
for (const r of openRuns) {
  if (!runsByItem.has(r.item)) runsByItem.set(r.item, []);
  runsByItem.get(r.item).push(r);
}

// A decision waiting on the operator: an open role=human item.
const decisions = open.filter((i) => i.role === 'human');

const buckets = new Map();
for (const i of open) {
  if (i.kind === 'goal') continue;
  const key = stageOf(i) ?? 'unstaged';
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(i);
}

const ORDER = ['1', '2', '3', '4', 'keys', 'parked', 'unstaged'];
const stageKeys = [...new Set([...ORDER.filter((k) => buckets.has(k)), ...buckets.keys()])];

// The same rules as lib/state.mjs itemStatus, over the JSON view. A blocker that
// reported done no longer blocks, even though its item is still open — counting
// unclosed blockers instead inflates "blocked" badly (13 against 2 on 2026-09-17).
const RESOLVED = new Set(['done', 'dropped']);
const statusCache = new Map();
function statusOf(id, visiting = new Set()) {
  if (statusCache.has(id)) return statusCache.get(id);
  const item = items.get(id);
  if (!item) return 'unknown';
  const value = (() => {
    if (item.closed) return item.closed.as;
    if (runsByItem.has(id)) return 'active';
    if (item.kind === 'goal') return 'open';
    if (visiting.has(id)) return 'blocked';
    visiting.add(id);
    const unresolved = (item.blocked_by ?? []).filter((b) => !RESOLVED.has(statusOf(b, visiting)));
    visiting.delete(id);
    if (unresolved.length) return 'blocked';
    switch (item.outcome?.value) {
      case 'done': return 'done';
      case 'needs_human': return 'needs_human';
      case 'blocked': return (item.blocked_by ?? []).length ? 'ready' : 'blocked';
      default: return 'ready';
    }
  })();
  if (!visiting.size) statusCache.set(id, value);
  return value;
}

// Only blockers that are genuinely unresolved.
function blockersOf(id) {
  return (items.get(id)?.blocked_by ?? []).filter((b) => !RESOLVED.has(statusOf(b)));
}

const model = {
  org: status.org,
  as_of: status.as_of,
  open_stage: openStage,
  open_stage_name: openStage ? stageName.get(openStage) ?? null : null,
  stages: stageKeys.map((key) => {
    const list = buckets.get(key) ?? [];
    const running = list.filter((i) => runsByItem.has(i.id));
    return {
      stage: key,
      name: key === 'unstaged' ? 'not governed by the stage rule'
        : key === 'parked' ? 'parked by the operator'
        : stageName.get(key) ?? null,
      open: list.length,
      running: running.length,
      decisions: list.filter((i) => i.role === 'human').length,
      is_open_stage: key === openStage,
    };
  }),
  running: openRuns.map((r) => {
    const item = items.get(r.item);
    const agentName = r.meta?.agent ?? null;
    const live = agentName ? agentByName.get(agentName) : null;
    return {
      run: r.id, item: r.item, title: item?.title ?? 'unknown item',
      stage: stageOf(item), role: item?.role ?? null,
      // `started` is an envelope ({ at, by, seq }), not a timestamp.
      started: r.started?.at ?? r.started ?? null,
      lane: r.meta?.lane ?? null,
      agent: agentName, session_state: live?.agent_status ?? (agentName ? 'gone' : null),
      doing: live?.terminal_title_stripped ?? null,
      workspace: r.workspace ?? null,
      in_open_stage: stageOf(item) === openStage,
    };
  }),
  // With no stage rule, every unstaged item is the working set.
  open_stage_items: (buckets.get(openStage ?? 'unstaged') ?? []).map((i) => ({
    id: i.id, title: i.title, role: i.role, priority: i.priority,
    status: statusOf(i.id),
    running: (runsByItem.get(i.id) ?? []).map((r) => r.id),
    blocked_by: blockersOf(i.id).map((b) => ({ id: b, title: items.get(b)?.title ?? null, stage: stageOf(items.get(b)) })),
  })),
  decisions: decisions.map((i) => ({
    id: i.id, title: i.title, stage: stageOf(i),
    category: i.meta?.category ?? null, recommend: i.meta?.recommend ?? null,
    has_options: Boolean(i.meta?.on_yes || i.meta?.['option.1']),
    blocks: (i.blocks ?? []).filter((b) => !items.get(b)?.closed),
  })),
};

if (flag('--json')) {
  process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
  process.exit(0);
}

// ---- plain text ----
const W = 100;
const out = (s = '') => process.stdout.write(`${s}\n`);
const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');
const hhmm = (iso) => {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const ago = (iso) => {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

out(`${path.basename(path.dirname(model.org))} · ${model.as_of.slice(0, 10)} · as of ${hhmm(model.as_of)}`);
out();
out(`THE LADDER${model.open_stage ? `    open stage: ${model.open_stage}${model.open_stage_name ? ` — ${model.open_stage_name}` : ''}` : '    no stage rule configured'}`);
for (const s of model.stages) {
  const here = s.is_open_stage ? '▶' : ' ';
  const label = s.stage === 'unstaged' ? 'no stage' : s.stage === 'parked' ? 'parked' : `stage ${s.stage}`;
  const counts = [`${String(s.open).padStart(3)} open`,
    s.running ? `${s.running} running` : '          ',
    s.decisions ? `${s.decisions} waiting on you` : ''].join('  ');
  out(` ${here} ${label.padEnd(9)} ${counts}  ${cut(s.name ?? '', 44)}${s.is_open_stage ? '   ← work happens here' : ''}`);
}
out();
out(`RUNNING NOW (${model.running.length})`);
if (!model.running.length) out('   nothing');
for (const r of model.running.sort((a, b) => (a.in_open_stage === b.in_open_stage ? 0 : a.in_open_stage ? -1 : 1))) {
  const where = r.stage == null ? 'no stage' : `stage ${r.stage}`;
  const warn = r.in_open_stage ? '' : '  ⚠ outside the open stage';
  out(`   ${ago(r.started).padStart(4)}  ${where.padEnd(9)} ${(r.session_state ?? 'no session').padEnd(8)} ${cut(r.doing ?? r.title, 52).padEnd(53)}${warn}`);
  out(`         ${r.lane ? `lane ${r.lane}` : 'no lane'}${r.agent ? ` · ${r.agent}` : ''}  (${r.run} · ${r.item})`);
}
out();
out(`WHAT THE OPEN STAGE IS WAITING ON (${model.open_stage_items.length} open)`);
const blocked = model.open_stage_items.filter((i) => i.blocked_by.length);
const moving = model.open_stage_items.filter((i) => i.running.length);
const idle = model.open_stage_items.filter((i) => !i.running.length && !i.blocked_by.length && i.role !== 'human');
out(`   ${moving.length} moving · ${blocked.length} blocked · ${idle.length} ready and untouched`);
for (const i of blocked.slice(0, 8)) {
  out(`   blocked  ${cut(i.title, 66)}  (${i.id})`);
  for (const b of i.blocked_by.slice(0, 3)) out(`            waits on ${cut(b.title, 56)} (${b.id}${b.stage && b.stage !== model.open_stage ? `, stage ${b.stage}` : ''})`);
}
for (const i of idle.slice(0, 6)) out(`   ready    ${cut(i.title, 66)}  (${i.id})`);
out();
const inStage = model.decisions.filter((d) => d.stage === model.open_stage);
const later = model.decisions.filter((d) => d.stage !== model.open_stage);
out(`WAITING ON YOU (${inStage.length} in the open stage, ${later.length} in later or no stage)`);
for (const d of inStage) {
  out(`   ${cut(d.title, 72)}  (${d.id})`);
  out(`      ${d.category ?? 'no category'} · ${d.recommend ? `recommend ${d.recommend}` : 'no recommendation'} · ${d.has_options ? 'options recorded' : 'no options — nothing to press'}${d.blocks.length ? ` · holds up ${d.blocks.length}` : ''}`);
}
if (later.length) out(`   …plus ${later.length} in later or no stage, not your problem yet`);
out();
if (status.attention?.length) out(`ATTENTION (${status.attention.length}): ${status.attention.slice(0, 3).map((a) => `${a.text} (${a.id})`).join(' · ')}${status.attention.length > 3 ? ' …' : ''}`);
