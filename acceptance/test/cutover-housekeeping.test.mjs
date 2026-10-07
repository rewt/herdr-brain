import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventory } from './cutover-fixture.mjs';
import { switches } from '../cutover.mjs';
import { copyProduct } from '../../lib/product-files.mjs';

test('switched external dispatch records launches and housekeeping previews only settled merged tabs', t => {
  const { root, copy, spec, edits } = inventory(t);
  copyProduct(path.resolve('.'), spec.candidate);
  for (const [key, file] of switches) fs.writeFileSync(path.join(copy, file), edits[key]);
  const bin = path.join(root, 'bin'), org = path.join(path.dirname(copy), '.org'); fs.mkdirSync(bin);
  const data = path.join(root, 'topology.json');
  const state = { agents: [], workspaces: [], tabs: [], panes: [], mutations: [] };
  const save = () => fs.writeFileSync(data, JSON.stringify(state)); save();
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'cutover-launch-test', PATH: bin + ':' + process.env.PATH,
    HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '', MAX_SESSIONS: '99' };
  const run = (exe, args, cwd = copy) => {
    const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${exe} ${args.join(' ')}\n${r.stderr}\n${r.stdout}`); return r.stdout;
  };
  const record = args => run(process.execPath, [path.join(spec.candidate, 'bin/org.mjs'), ...args]);
  run('git', ['init', '-b', 'main']); run('git', ['config', 'user.name', 'Test']); run('git', ['config', 'user.email', 'test@example.invalid']);
  // Lane launcher and Herdr are scripted, while dispatch, record and cleanup use the candidate.
  fs.writeFileSync(path.join(copy, 'scripts/lane/lane.mjs'), `import fs from 'node:fs';
const s=JSON.parse(fs.readFileSync(${JSON.stringify(data)})), topic=process.argv[3];
const a=s.agents.find(a=>a.name==='lane-worker-'+topic);if(!a)process.exit(1);
console.log("dispatched '"+a.name+"' (pane "+a.pane_id+")");
`);
  fs.writeFileSync(path.join(copy, '.lane/supervisor/arm-watch.sh'), '#!/bin/sh\nexit 0\n'); // no background process
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'org'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(spec.candidate, 'bin/org.mjs')}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';const file=${JSON.stringify(data)},s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2);
let result;
if(a[0]==='agent'&&a[1]==='get')result={agent:a[2]===${JSON.stringify(spec.target)}?{name:a[2]}:s.agents.find(v=>v.name===a[2])};
else if(a[0]==='agent'&&a[1]==='list')result={agents:s.agents};
else if(a[0]==='workspace'&&a[1]==='list')result={workspaces:s.workspaces};
else if(a[0]==='tab'&&a[1]==='list')result={tabs:s.tabs.filter(v=>v.workspace_id===a.at(-1))};
else if(a[0]==='pane'&&a[1]==='list')result={panes:s.panes.filter(v=>v.workspace_id===a.at(-1))};
else if(a[0]==='pane'&&a[1]==='process-info')result={process_info:{shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}]}};
else {s.mutations.push(a);fs.writeFileSync(file,JSON.stringify(s));process.exit(90);}
console.log(JSON.stringify({result}));
`, { mode: 0o755 });
  run('git', ['add', '.']); run('git', ['commit', '-m', 'switched fixture']); record(['init', org]);
  const common = fs.realpathSync(path.join(copy, '.git'));
  const outcomes = ['done', 'blocked', 'needs_human', 'open', 'working', 'legacy', 'unmerged'];
  for (const outcome of outcomes) {
    const topic = outcome, wt = path.join(spec.home, '.herdr/worktrees/bch-cloak', `lane-${topic}`);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    run('git', ['worktree', 'add', '-b', `lane/${topic}`, wt]);
    if (outcome === 'unmerged') { fs.writeFileSync(path.join(wt, 'change'), 'unmerged'); run('git', ['add', 'change'], wt); run('git', ['commit', '-m', 'unmerged'], wt); }
    state.workspaces.push({ workspace_id: topic, worktree: { checkout_path: wt, repo_root: copy, repo_key: common, is_linked_worktree: true } });
    state.tabs.push({ tab_id: topic, workspace_id: topic, label: 'worker' });
    state.panes.push({ pane_id: `${topic}:pane`, tab_id: topic, workspace_id: topic });
    const agent = { name: `lane-worker-${topic}`, pane_id: `${topic}:pane`, workspace_id: topic, tab_id: topic, cwd: wt,
      terminal_id: `${topic}:terminal`, agent_session: { value: `${topic}:session` }, agent_status: outcome === 'working' ? 'working' : 'idle' };
    state.agents.push(agent); save();
    const item = record(['add', `${outcome} worker`]).match(/^(\S+)/)[1], report = path.join(root, `${outcome}.md`);
    let id;
    if (outcome === 'legacy') {
      id = record(['start', item, '--workspace', wt, '--report', report, '--meta', `lane=${topic}`]).match(/^(R-\d+)/)[1];
      record(['set', id, `agent=${agent.name}`, `pane=${agent.pane_id}`]);
    } else {
      const brief = path.join(root, `ask-${topic}.md`); fs.writeFileSync(brief, 'Offline ask for R-RUN.\n');
      const output = run('/bin/zsh', ['-f', path.join(copy, '.lane/supervisor/dispatch.sh'), item, topic, 'engineer', 'codex', 'scripted', 'low', brief, report]);
      id = output.match(/(R-\d+) /)[1];
      const meta = JSON.parse(record(['show', id, '--json'])).meta;
      assert.equal(meta.worker_workspace, topic); assert.equal(meta.terminal_id, agent.terminal_id); assert.equal(meta.agent_session_id, agent.agent_session.value);
    }
    if (!['open', 'working'].includes(outcome)) {
      const result = ['legacy', 'unmerged'].includes(outcome) ? 'done' : outcome;
      fs.writeFileSync(report, `---\nrun: ${id}\noutcome: ${result}\nsummary: Offline cutover fixture.\nheadline: The worker finished\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
      record(['ingest', report]);
    }
  }
  const output = run(process.execPath, [path.join(spec.candidate, 'housekeeping/housekeeping.mjs'), '--cwd', copy,
    '--org', org, '--once', '--dry-run', '--state-dir', path.join(root, 'preview')]);
  const entries = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.filter(e => e.action === 'would-close').map(e => e.tab_id), ['done']);
  assert.deepEqual(entries.filter(e => e.action === 'keep').map(e => e.tab_id).sort(),
    ['blocked', 'legacy', 'needs_human', 'open', 'unmerged', 'working']);
  t.diagnostic(output.trim());
  assert.deepEqual(JSON.parse(fs.readFileSync(data)).mutations, []);
  // Installed one-shot cleanup shares identity checks and preserves legacy/blocked/open occupants.
  const tidy = run('/bin/sh', [path.join(copy, '.lane/supervisor/close-finished-agents.sh'), '--dry-run']);
  assert.match(tidy, /would close done/); assert.doesNotMatch(tidy, /would close (blocked|needs_human|open|working|legacy)/);
  for (const outcome of ['blocked', 'needs_human']) {
    assert.ok(tidy.split('\n').some(line => line.startsWith(`[dry-run] keep ${outcome} `) &&
      line.endsWith(`: no recorded report for lane-worker-${outcome}`)), `${outcome} must reach the recorded-outcome guard`);
  }
  assert.equal(state.tabs.length, outcomes.length);
  // Pin the adoption instruction without starting any project loop.
  assert.match(edits.protocol, /project supervisor starts housekeeping from the canonical checkout/);
  assert.match(edits.protocol, /housekeeping\/housekeeping.mjs' --start/);
  assert.match(edits.protocol, /never backfill.*session registry/);
});
