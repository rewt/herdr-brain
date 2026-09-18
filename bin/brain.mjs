#!/usr/bin/env node
// brain — the smallest orchestrator that keeps the operator in the loop.
//
//   brain watch [--digest] [--every 5] [--include-unnamed]
//   brain queue [--all] [--json]
//   brain show <id|session>
//   brain answer <id> "<text>"        record what you decided
//   brain dismiss <id>
//   brain digest <id>                 run the recommendation pass by hand
//
// It watches Herdr, notices a session going done or blocked, reads what it
// said, and puts it in a queue. It never starts, prompts, keys or closes a
// session.
import process from 'node:process';
import { agents, read, tabLabels, HerdrDown } from '../lib/herdr.mjs';
import { parseScreen, headline } from '../lib/capture.mjs';
import { append, fold, open as openRows, get, loadSeen, saveSeen, LOG } from '../lib/queue.mjs';
import { digest as runDigest } from '../lib/digest.mjs';
import { classifyLocally } from '../lib/classify.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'queue';
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// A session that stopped is interesting. Idle is not: an operator's own chat
// sits idle all day and is not a result.
const CAPTURE = new Set(['done', 'blocked']);

const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};
const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));

async function capture(agent, labels) {
  const text = await read(agent.name, 250);
  const parsed = parseScreen(text ?? '');
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}-${agent.name}`;
  const entry = {
    type: 'result',
    id,
    session: agent.name,
    state: agent.agent_status,
    where: agent.cwd ?? null,
    workspace: agent.workspace_id ?? null,
    tab: agent.tab_id ?? null,
    tab_label: labels.get(agent.tab_id) ?? null,
    title: agent.terminal_title_stripped ?? null,
    ...parsed,
  };
  entry.headline = headline(entry);
  append(entry);
  return entry;
}

async function watch() {
  const every = Number(val('--every', '5')) * 1000;
  const wantDigest = has('--digest');
  const includeUnnamed = has('--include-unnamed');
  let catchUp = has('--catch-up');
  const model = val('--model', 'claude-sonnet-5');
  const seen = loadSeen();
  let down = false;

  const line = (s) => process.stdout.write(`${new Date().toTimeString().slice(0, 8)}  ${s}\n`);
  line(`watching herdr every ${every / 1000}s · queue ${LOG}${wantDigest ? ` · digest via ${model}` : ' · no digest (--digest to turn on)'}`);

  for (;;) {
    let list;
    try {
      list = await agents();
      if (down) { line('herdr is back'); down = false; }
    } catch (err) {
      if (!down) { line(`herdr unavailable: ${err.message}`); down = true; }
      await sleep(every);
      continue;
    }

    const live = new Set();
    for (const a of list) {
      const name = a.name ?? (includeUnnamed ? a.pane_id : null);
      if (!name) continue;
      live.add(name);
      const was = seen.states[name];
      const now = a.agent_status;
      seen.states[name] = now;
      // The transition is the event: entering done or blocked from anything
      // else. A first sighting is not a transition, so a restart is quiet —
      // unless --catch-up, which takes whatever is already stopped right now.
      const first = was === undefined;
      if (!CAPTURE.has(now)) continue;
      if (first ? !catchUp : was === now) continue;
      const labels = tabLabels();
      const entry = await capture({ ...a, name }, labels);
      line(`${now.toUpperCase()}  ${name}  ${cut(entry.headline, 72)}`);
      if (entry.unsent) line(`      ↑ unsent text in its prompt box: ${cut(entry.unsent, 60)}`);
      const local = classifyLocally(entry);
      if (local) {
        append({ type: 'digest', id: entry.id, digest: local });
        line(`      read from its own screen, no model call`);
      } else if (wantDigest) {
        runDigest(entry, { model })
          .then((d) => { append({ type: 'digest', id: entry.id, digest: d }); line(`      digested: ${cut(d.question ?? d.next_step ?? d.what_happened ?? '', 70)}`); })
          .catch((e) => line(`      digest failed: ${e.message.split('\n')[0]}`));
      }
    }
    catchUp = false;   // only the first tick
    for (const name of Object.keys(seen.states)) if (!live.has(name)) delete seen.states[name];
    saveSeen(seen);
    await sleep(every);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue() {
  const rows = has('--all') ? fold() : openRows();
  if (has('--json')) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return; }
  if (!rows.length) { process.stdout.write('nothing waiting\n'); return; }

  // Stranded first: the operator already answered and it never got delivered.
  // Then real decisions, then things merely in the way, then finished work.
  const bucket = (r) => {
    if (r.unsent) return 'stranded';
    const k = r.digest?.kind;
    if (k === 'decision') return 'decision';
    if (k === 'obstacle') return 'obstacle';
    if (k === 'report') return 'finished';
    return r.state === 'blocked' ? 'obstacle' : 'finished';
  };
  const groups = { stranded: [], decision: [], obstacle: [], finished: [] };
  for (const r of rows) groups[bucket(r)].push(r);

  const section = (title, list) => {
    if (!list.length) return;
    process.stdout.write(`\n${title} (${list.length})\n`);
    for (const r of list) {
      const d = r.digest;
      process.stdout.write(`  ${r.id.slice(0, 13)}  ${ago(r.at).padStart(4)}  ${cut(r.tab_label ?? r.session, 24).padEnd(25)}${cut(d?.question ?? d?.what_happened ?? r.headline, 62)}\n`);
      if (r.unsent) process.stdout.write(`                      you already typed: "${cut(r.unsent, 56)}"\n`);
      for (const o of d?.options ?? []) {
        process.stdout.write(`                      ${o.key}  ${cut(o.label, 28).padEnd(29)}${cut(o.causes, 50)}${d.recommend === o.key ? '  ← recommended' : ''}\n`);
      }
      if (!d && r.status === 'new') process.stdout.write('                      (not digested — brain digest <id>)\n');
    }
  };
  section('YOUR ANSWER NEVER LANDED', groups.stranded);
  section('DECISIONS — the work needs you', groups.decision);
  section('IN THE WAY — clear these', groups.obstacle);
  section('FINISHED — nobody has read these', groups.finished);
  process.stdout.write(`\n  brain show <id> · brain answer <id> "…" · brain dismiss <id>\n`);
}

function show(id) {
  const r = get(id);
  if (!r) { process.stderr.write(`no such result: ${id}\n`); process.exit(1); }
  const d = r.digest;
  process.stdout.write(`${r.tab_label ?? r.session}  ·  ${r.state}  ·  ${hhmm(r.at)} (${ago(r.at)} ago)\n`);
  if (r.where) process.stdout.write(`${r.where}\n`);
  if (d) {
    process.stdout.write(`\n${d.what_happened ?? ''}\n`);
    if (d.question) process.stdout.write(`\nIt needs you to decide: ${d.question}\n`);
    for (const o of d.options ?? []) process.stdout.write(`  ${o.key}  ${o.label} — ${o.causes}${d.recommend === o.key ? '   ← recommended' : ''}\n`);
    if (d.why) process.stdout.write(`  why: ${d.why}\n`);
    if (d.next_step) process.stdout.write(`\nNext step: ${d.next_step}\n`);
  }
  if (r.unsent) process.stdout.write(`\nUNSENT in its prompt box:\n  ${r.unsent.split('\n').join('\n  ')}\n`);
  if (r.dialog) {
    process.stdout.write(`\nIt is stuck at: ${r.dialog.question ?? 'a dialog'}\n`);
    for (const o of r.dialog.options) process.stdout.write(`  ${o.key}. ${o.label}\n`);
  }
  process.stdout.write(`\n--- its last screen ---\n${r.screen ?? r.said ?? '(nothing captured)'}\n`);
}

async function main() {
  switch (cmd) {
    case 'watch': return watch();
    case 'queue': case 'ls': return queue();
    case 'show': return show(argv[1]);
    case 'answer': {
      const r = get(argv[1]);
      if (!r) { process.stderr.write('no such result\n'); process.exit(1); }
      append({ type: 'answer', id: r.id, text: argv.slice(2).join(' ') });
      process.stdout.write(`recorded against ${r.tab_label ?? r.session}\n`);
      return;
    }
    case 'dismiss': {
      const r = get(argv[1]);
      if (!r) { process.stderr.write('no such result\n'); process.exit(1); }
      append({ type: 'status', id: r.id, status: 'dismissed' });
      process.stdout.write('dismissed\n');
      return;
    }
    case 'digest': {
      const r = get(argv[1]);
      if (!r) { process.stderr.write('no such result\n'); process.exit(1); }
      const d = await runDigest(r, { model: val('--model', 'claude-sonnet-5') });
      append({ type: 'digest', id: r.id, digest: d });
      return show(r.id);
    }
    default:
      process.stderr.write('usage: brain watch [--digest] | queue | show <id> | answer <id> "…" | dismiss <id> | digest <id>\n');
      process.exit(2);
  }
}

main().catch((e) => { process.stderr.write(`${e instanceof HerdrDown ? 'herdr: ' : ''}${e.message}\n`); process.exit(1); });
