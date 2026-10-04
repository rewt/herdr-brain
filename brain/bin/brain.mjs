#!/usr/bin/env node
// brain — the smallest orchestrator that keeps the operator in the loop.
//
//   brain watch [--digest] [--every 5] [--include-unnamed]
//   brain queue [--all] [--json]
//   brain show <id|session>
//   brain answer <id> "<text>"        record what you decided
//   brain dismiss <id>
//   brain digest <id>                 run the recommendation pass by hand
//   brain start --cwd DIR --name NAME [--label TEXT] -- "brief"
//   brain explain --org DIR ID        an org item in plain words, with actions (cached)
//
// It watches Herdr, notices a session going done or blocked, reads what it
// said, and puts it in a queue. It never closes a session. It sends into one
// (send, key) or starts one (start) only when the operator asks.
import process from 'node:process';
import { agents, read, tabLabels, sendKeys, prompt, HerdrDown } from '../lib/herdr.mjs';
import { parseScreen, headline } from '../lib/capture.mjs';
import { append, bucketOf, fold, open as openRows, get, handleOf, loadSeen, saveSeen, LOG } from '../lib/queue.mjs';
import { digest as runDigest } from '../lib/digest.mjs';
import { classifyLocally } from '../lib/classify.mjs';
import { startSession } from '../lib/start.mjs';
import { explainItem } from '../lib/explain.mjs';
import * as service from '../lib/service.mjs';
import { loadProjects, withProject } from '../lib/projects.mjs';
import { parseArgs } from 'node:util';
import { recordDigest, renderDigest } from '../lib/signals.mjs';

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
  const parsed = parseScreen(text ?? '', { agent: agent.agent });
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}-${agent.name}`;
  const entry = {
    type: 'result',
    id,
    session: agent.name,
    agent: agent.agent ?? null,
    state: agent.agent_status,
    where: agent.cwd ?? null,
    workspace: agent.workspace_id ?? null,
    tab: agent.tab_id ?? null,
    pane: agent.pane_id ?? null,
    tab_label: labels.get(agent.tab_id) ?? null,
    title: agent.terminal_title_stripped ?? null,
    ...parsed,
  };
  entry.project = withProject(entry).project;
  entry.headline = headline(entry);
  append(entry);
  return entry;
}

async function watch() {
  const other = service.claim();
  if (other) {
    process.stderr.write(`another watcher is already running (pid ${other}); stop it first (brain service stop, or Ctrl-C in its tab)\n`);
    process.exit(1);
  }
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
    // The heartbeat the console reads to say whether the loop is alive.
    Object.assign(seen, { tick: new Date().toISOString(), pid: process.pid, every: every / 1000, digest: wantDigest });
    saveSeen(seen);
    await sleep(every);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue() {
  const projects = loadProjects();
  const rows = (has('--all') ? fold() : openRows()).map((r) => withProject(r, projects));
  if (has('--json')) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return; }
  if (!rows.length) { process.stdout.write('nothing waiting\n'); return; }

  // Stranded first: the operator already answered and it never got delivered.
  // Then real decisions, then things merely in the way, then finished work.
  const groups = { stranded: [], decision: [], suggested: [], obstacle: [], finished: [], later: [] };
  for (const r of rows) groups[bucketOf(r)].push(r);

  const section = (title, list) => {
    if (!list.length) return;
    process.stdout.write(`\n${title} (${list.length})\n`);
    for (const r of list) {
      const d = r.digest;
      process.stdout.write(`  ${cut(handleOf(r), 16).padEnd(17)}${ago(r.at).padStart(4)}  ${cut(r.project, 16).padEnd(17)}${cut(r.tab_label ?? r.session, 24).padEnd(25)}${cut(d?.question ?? d?.what_happened ?? r.headline, 62)}\n`);
      if (r.unsent) process.stdout.write(`                      you already typed: "${cut(r.unsent, 56)}"\n`);
      if (r.suggestion) process.stdout.write(`                      Claude drafted, not sent: "${cut(r.suggestion, 52)}"\n`);
      for (const o of d?.options ?? []) {
        process.stdout.write(`                      ${o.key}  ${cut(o.label, 28).padEnd(29)}${cut(o.causes, 50)}${d.recommend === o.key ? '  ← recommended' : ''}\n`);
      }
      if (!d && r.status === 'new') process.stdout.write('                      (not digested — brain digest <id>)\n');
    }
  };
  section('YOUR ANSWER NEVER LANDED', groups.stranded);
  section('DECISIONS — the work needs you', groups.decision);
  section('CLAUDE DRAFTED A REPLY — yours to accept or not', groups.suggested);
  section('IN THE WAY — clear these', groups.obstacle);
  section('FINISHED — nobody has read these', groups.finished);
  section('LATER', groups.later);
  process.stdout.write('\n  send <id> · key <id> 2 · later <id> · never <id> · show <id>\n');
}

function show(id) {
  const found = get(id);
  const r = found && withProject(found);
  if (!r) { process.stderr.write(`no such result: ${id}\n`); process.exit(1); }
  const d = r.digest;
  process.stdout.write(`${r.project}  ·  ${r.tab_label ?? r.session}  ·  ${r.state}  ·  ${hhmm(r.at)} (${ago(r.at)} ago)\n`);
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
    case 'later': case 'never': {
      const r = get(argv[1]);
      if (!r) { process.stderr.write('no such result\n'); process.exit(1); }
      append({ type: 'status', id: r.id, status: cmd === 'later' ? 'later' : 'never', note: argv.slice(2).join(' ') || null });
      process.stdout.write(cmd === 'later' ? 'moved to later; it stays in the queue under LATER\n' : 'marked never; it will not come back\n');
      return;
    }
    case 'key': {
      const r = get(argv[1]);
      const k = argv[2];
      if (!r || !k) { process.stderr.write('usage: brain key <id> <1|2|esc|y|n>\n'); process.exit(1); }
      process.stdout.write(`sending "${k}" to ${r.tab_label ?? r.session}\n`);
      const out = await sendKeys(r.session, [k]);
      append({ type: 'status', id: r.id, status: 'acted', note: `sent key ${k}` });
      process.stdout.write(`${out || 'sent'}\n`);
      return;
    }
    case 'send': {
      const r = get(argv[1]);
      if (!r) { process.stderr.write('no such result\n'); process.exit(1); }
      const text = argv.slice(2).join(' ') || r.unsent || r.suggestion;
      if (!text) { process.stderr.write('nothing to send: pass the text\n'); process.exit(1); }
      if (!r.unsent && r.suggestion && !argv[2]) {
        process.stderr.write(`that text is Claude's suggestion, not yours:\n  "${r.suggestion}"\nsend it with: brain send ${handleOf(r)} "${r.suggestion}"\n`);
        process.exit(1);
      }
      const res = await prompt(r.session, text);
      if (!res.ok) {
        process.stderr.write(res.blocked
          ? `${r.tab_label ?? r.session} is stuck at a dialog and refused the message. Clear it first:\n  brain key ${handleOf(r)} 2\n`
          : `could not send: ${res.error}\n`);
        process.exit(1);
      }
      append({ type: 'answer', id: r.id, text });
      process.stdout.write(`sent to ${r.tab_label ?? r.session}\n`);
      return;
    }
    case 'dismiss': {
      const r = get(argv[1]);
      if (!r) { process.stderr.write('no such result\n'); process.exit(1); }
      append({ type: 'status', id: r.id, status: 'dismissed' });
      process.stdout.write('dismissed\n');
      return;
    }
    case 'start': {
      // Everything after -- is the brief; flags come before it.
      const dash = argv.indexOf('--');
      const brief = dash >= 0 ? argv.slice(dash + 1).join(' ').trim() : '';
      const flags = dash >= 0 ? argv.slice(0, dash) : argv;
      const flag = (f) => { const i = flags.indexOf(f); return i >= 0 ? flags[i + 1] : undefined; };
      const addDirs = flags.flatMap((f, i) => (f === '--add-dir' && flags[i + 1] ? [flags[i + 1]] : []));
      try {
        const r = await startSession({
          cwd: flag('--cwd'), name: flag('--name'), label: flag('--label'), prompt: brief,
          model: flag('--model') ?? 'opus', effort: flag('--effort') ?? 'high', addDirs,
        });
        append({ type: 'started', id: r.name, session: r.name, where: flag('--cwd'), label: flag('--label') ?? null });
        process.stdout.write(`${has('--json') ? JSON.stringify({ ok: true, ...r }) : `started ${r.name}`}\n`);
      } catch (err) {
        if (has('--json')) process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
        else process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      return;
    }
    case 'status': {
      const st = service.status();
      if (has('--json')) { process.stdout.write(`${JSON.stringify(st)}\n`); return; }
      process.stdout.write(`${st.running ? `watching (pid ${st.pid}), last tick ${st.age}s ago` : 'not watching'} · service ${st.service ? 'on' : st.installed ? 'off' : 'not installed'}\n`);
      return;
    }
    case 'service': {
      const sub = argv[1];
      const r = sub === 'start' ? service.start() : sub === 'stop' ? service.stop() : sub === 'install' ? service.install() : sub === 'status' ? service.status() : null;
      if (!r) { process.stderr.write('usage: brain service start|stop|install|status\n'); process.exit(2); }
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return;
    }
    case 'explain': {
      const id = argv.slice(1).find((a, i, all) => !a.startsWith('--') && !['--org', '--org-bin', '--model'].includes(all[i - 1]));
      const orgDir = val('--org', process.env.ORG_DIR);
      if (!id || !orgDir) { process.stderr.write('usage: brain explain --org DIR [--org-bin BIN] [--refresh] [--cached-only] [--json] ID\n'); process.exit(2); }
      try {
        const r = await explainItem({ orgDir, id, orgBin: val('--org-bin', 'org'), model: val('--model', 'claude-sonnet-5'), refresh: has('--refresh'), cachedOnly: has('--cached-only') });
        if (has('--json')) { process.stdout.write(`${JSON.stringify(r ?? { id, missing: true })}\n`); return; }
        if (!r) { process.stdout.write('not explained yet\n'); return; }
        process.stdout.write(`${id} — "${r.gist ?? ''}"\n${r.explain ?? ''}\n`);
        for (const o of r.options ?? []) process.stdout.write(`  ${o.key}  ${o.label} — ${o.causes}${String(r.recommend) === String(o.key) ? '   ← recommended' : ''}\n`);
        if (r.why) process.stdout.write(`  why: ${r.why}\n`);
      } catch (err) {
        if (has('--json')) process.stdout.write(`${JSON.stringify({ id, error: err.message.split('\n')[0] })}\n`);
        else process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      return;
    }
    case 'digest': {
      if (argv[1]?.startsWith('--') || argv.length === 1) {
        const { values, positionals } = parseArgs({ args: argv.slice(1), options: {
          org: { type: 'string' }, limit: { type: 'string' }, 'max-chars': { type: 'string' },
          json: { type: 'boolean' }, ack: { type: 'string' },
        } });
        if (positionals.length) throw new Error('record digest takes no result ID');
        if (values.ack && (values.limit || values['max-chars'])) throw new Error('--ack cannot change digest bounds');
        const d = recordDigest({ orgDir: values.org ?? process.env.ORG_DIR,
          limit: values.limit === undefined ? undefined : Number(values.limit),
          maxChars: values['max-chars'] === undefined ? undefined : Number(values['max-chars']), ack: values.ack });
        process.stdout.write(values.json ? JSON.stringify(d, null, 2) + '\n' : renderDigest(d));
        return;
      }
      const r = get(argv[1]);
      if (!r) { process.stderr.write('no such result\n'); process.exit(1); }
      const d = await runDigest(r, { model: val('--model', 'claude-sonnet-5') });
      append({ type: 'digest', id: r.id, digest: d });
      return show(r.id);
    }
    default:
      process.stderr.write([
        'usage:',
        '  brain watch [--digest] [--catch-up]   keep the queue current',
        '  brain queue [--all] [--json]          what is waiting',
        '  brain show <id>                       one result in full',
        '  brain send <id> ["text"]              send a reply to that session',
        '  brain key <id> <1|2|esc|y|n>          answer the dialog it is stuck at',
        '  brain later <id> ["why"]              not now, keep it',
        '  brain never <id> ["why"]              drop it for good',
        '  brain answer <id> "…"                 record what you decided',
        '  brain digest <id>                     run the reading pass by hand',
        '  brain digest --org DIR [--json]        model-free record signals for distillation',
        '    [--limit N] [--max-chars N] [--ack PASS]  acknowledge only after the pass completes',
        '  brain explain --org DIR ID            an org item in plain words, with actions (cached)',
        '  brain status [--json]                 is the loop alive',
        '  brain service start|stop|install      the loop as an always-on LaunchAgent',
        '  brain start --cwd DIR --name NAME [--label TEXT] [--model opus] [--effort high] [--add-dir DIR]... -- "brief"',
        '                                        open a session in Herdr on the folder\'s account and give it the brief',
      ].join('\n') + '\n');
      process.exit(2);
  }
}

main().catch((e) => { process.stderr.write(`${e instanceof HerdrDown ? 'herdr: ' : ''}${e.message}\n`); process.exit(1); });
