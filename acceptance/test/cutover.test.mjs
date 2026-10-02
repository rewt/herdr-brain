import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { relocate } from '../security.mjs';
import { switches, capture, restore, callers, retireContrib, switchedFiles, callerFiles, callerInventory } from '../cutover.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [, file] of switches) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `# original ${file}\n`, { mode: file.endsWith('.sh') ? 0o751 : 0o640 });
  }
  return root;
}
test('rollback restores every file byte and executable mode', (t) => {
  const root = fixture(t), original = capture(root);
  for (const [, file] of switches) { fs.writeFileSync(path.join(root, file), 'switched'); fs.chmodSync(path.join(root, file), 0o600); }
  restore(root, original);
  assert.deepEqual(capture(root), original);
});
test('contrib cannot retire with an extra executable caller, and scans refuse symlinks', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility');
  const caller = path.join(root, '.lane/supervisor/extra.sh');
  fs.writeFileSync(caller, '# historical contrib/settle-watch.mjs\nnode "$CURRENT/contrib/settle-watch.mjs"\n');
  assert.equal(callers(root, 'contrib/settle-watch.mjs').length, 1);
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
  assert.equal(fs.readFileSync(compat, 'utf8'), 'compatibility');
  fs.unlinkSync(caller); fs.symlinkSync(compat, caller);
  assert.throws(() => retireContrib(root, compat), /symlink/);
  fs.unlinkSync(caller); retireContrib(root, compat);
  assert.equal(fs.existsSync(compat), false);
});

function inventory(t) {
  const root = fixture(t), copy = path.join(root, 'existing/bch-cloak'), candidate = path.join(root, 'candidate');
  const kit = path.resolve(import.meta.dirname, '../../kit/bch-cloak-20261001');
  const spec = { copy, candidate, workspace: 'owned-workspace', target: 'new-target', legacyTarget: 'legacy-target', home: path.join(root, 'home') };
  for (const [, file] of switches) {
    const source = file.replace('.lane/supervisor/', 'supervisor/').replace('scripts/lane/', 'lane/');
    let text = fs.readFileSync(path.join(kit, source), 'utf8');
    if (file.endsWith('launch-supervisor.mjs')) text = text.replace(/const SETTLE_WATCH = .*;/, `const SETTLE_WATCH = ${JSON.stringify(path.join(candidate, 'contrib/settle-watch.mjs'))};`);
    text = relocate(text, { live: '/Users/rewt/development/bastian/bch-cloak', home: '/Users/rewt', scratchHome: spec.home, copy, candidate, root })
      .replaceAll('wFN', spec.workspace).replaceAll('supervisor-opus', spec.legacyTarget);
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.writeFileSync(path.join(copy, file), text);
  }
  return { root, copy, spec, edits: switchedFiles(spec) };
}
test('all eleven edits apply to relocated inventory scripts and refuse premise drift', (t) => {
  const { copy, spec, edits } = inventory(t);
  assert.equal(Object.keys(edits).length, 11);
  assert.ok(edits.dispatch.includes('arm-watch.sh $RUN'));
  assert.ok(!edits.dispatch.includes('notify-watch.sh'));
  for (const [key, file] of switches) fs.writeFileSync(path.join(copy, file), edits[key]);
  assert.deepEqual(callers(copy, 'contrib/settle-watch.mjs'), []);
  assert.deepEqual(callers(copy, 'notify-watch.sh'), []);
  assert.throws(() => switchedFiles(spec), /premise drift/);
});

test('retirement scans nested Python, executable extensionless and notify entry callers', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility');
  for (const rel of ['.lane/supervisor/nested/caller.py', 'scripts/lane/deeper/caller', '.lane/supervisor/notify-watch.sh']) {
    const file=path.join(root,rel); fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file, '# historical contrib/settle-watch.mjs\nnode "$CURRENT/contrib/settle-watch.mjs"\n', {mode:0o755});
    assert.ok(callerFiles(root).includes(file));
    assert.ok(callers(root,'contrib/settle-watch.mjs').some(v=>v.file===file));
    assert.throws(()=>retireContrib(root,compat),/retirement refused/);
    assert.equal(fs.readFileSync(compat,'utf8'),'compatibility'); fs.unlinkSync(file);
  }
  retireContrib(root,compat); assert.equal(fs.existsSync(compat),false);
});

test('installed copied cleanup uses recorded outcomes, latest runs and whole-tab eligibility', (t) => {
  const {root,copy,spec,edits}=inventory(t), bin=path.join(root,'bin'); fs.mkdirSync(bin);
  const reportFile=path.join(root,'unrecorded-report.md'); fs.writeFileSync(reportFile,'outcome: done');
  const names=['done','blocked','needs_human','open','unrecorded','unknown','abandoned','fixed','regressed','shared-done','shared-blocked','supervisor','foreign'];
  const runs=[];
  for (const name of names) {
    if(name==='unrecorded')continue;
    const outcome=['blocked','needs_human','shared-blocked'].includes(name)?(name==='needs_human'?name:'blocked'):'done';
    runs.push({meta:{agent:name},started:{seq:runs.length+1},report:['open','abandoned'].includes(name)?null:{outcome},abandoned:name==='abandoned'?{}:null,report_path:reportFile});
  }
  runs.push({meta:{agent:'fixed'},started:{seq:0},report:{outcome:'blocked'}});
  runs.push({meta:{agent:'regressed'},started:{seq:999},report:{outcome:'needs_human'}});
  const agents=names.map(name=>({name,agent_status:name==='unknown'?'unknown':'idle',tab_id:name.startsWith('shared-')?'shared':name,workspace_id:name==='supervisor'?spec.workspace:'owned-worker',cwd:name==='foreign'?root:path.join(spec.home,'.herdr/worktrees/bch-cloak/lane-'+name)}));
  fs.writeFileSync(path.join(root,'record.json'),JSON.stringify({runs}));
  fs.writeFileSync(path.join(root,'agents.json'),JSON.stringify({result:{agents}}));
  const shim = (name,code)=>{const file=path.join(bin,name);fs.writeFileSync(file,`#!${process.execPath}\n${code}`,{mode:0o755});};
  shim('org',`import fs from 'node:fs';console.log(fs.readFileSync(${JSON.stringify(path.join(root,'record.json'))},'utf8'));`);
  shim('herdr',`import fs from 'node:fs';if(process.argv[2]==='agent')console.log(fs.readFileSync(${JSON.stringify(path.join(root,'agents.json'))},'utf8'));else if(process.argv[2]==='tab'&&process.argv[3]==='close')fs.appendFileSync(${JSON.stringify(path.join(root,'closed'))},process.argv[4]+'\\n');else process.exit(90);`);
  const script=path.join(copy,'.lane/supervisor/close-finished-agents.sh');fs.writeFileSync(script,edits.cleanup);
  const invoke=(args=[])=>spawnSync('/bin/zsh',['-f',script,...args],{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8'});
  const dry=invoke(['--dry-run']);assert.equal(dry.status,0,dry.stderr);assert.ok(!fs.existsSync(path.join(root,'closed')));
  const result=invoke();assert.equal(result.status,0,result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(root,'closed'),'utf8').trim().split('\n').sort(),['abandoned','done','fixed']);
  // A failed record read must never degrade into "no protected agents".
  fs.writeFileSync(path.join(root,'closed'),''); shim('org','process.exit(1);');
  assert.notEqual(invoke().status,0);assert.equal(fs.readFileSync(path.join(root,'closed'),'utf8'),'');
});

test('installed tidy recovers a bounded tail from each log including a late older run', (t) => {
  const {root,copy,edits}=inventory(t),bin=path.join(root,'bin');fs.mkdirSync(bin);
  for(const name of ['org','herdr'])fs.writeFileSync(path.join(bin,name),`#!/bin/sh\necho '{"runs": [], "result": {"tabs": [], "workspaces": [], "agents": []}}'\n`,{mode:0o755});
  const logs=path.join(copy,'.lane/supervisor/watch-logs');fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs,'R-1.log'),'old\nlate-from-old-run\n');
  fs.writeFileSync(path.join(logs,'R-2.log'),('old-newer-log\n').repeat(100));
  fs.mkdirSync(path.join(root,'existing/.org'),{recursive:true});fs.writeFileSync(path.join(root,'existing/.org/events.jsonl'),'');
  fs.writeFileSync(path.join(copy,'.lane/supervisor/tidy-tabs.sh'),edits.tidy);
  fs.writeFileSync(path.join(copy,'.lane/supervisor/close-finished-agents.sh'),edits.cleanup);fs.chmodSync(path.join(copy,'.lane/supervisor/close-finished-agents.sh'),0o755);
  const result=spawnSync('/bin/zsh',['-f',path.join(copy,'.lane/supervisor/tidy-tabs.sh'),'--dry-run','--log-lines','2'],{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/late-from-old-run/);
  assert.equal(result.stdout.split('old-newer-log').length-1,2);
});

test('only unreferenced timestamped script backups qualify as historical material', (t) => {
  const root=fixture(t), backup=path.join(root,'.lane/supervisor/old.sh.bak-20261001-copy');
  fs.writeFileSync(backup,'node "$CURRENT/contrib/settle-watch.mjs"\n',{mode:0o755});
  assert.ok(callerInventory(root).historical.includes(backup));
  const active=path.join(root,'scripts/lane/caller.py');
  fs.writeFileSync(active,`import subprocess\nsubprocess.run(['sh', '${backup}'])\n`);
  assert.ok(callerInventory(root).active.includes(backup));
  assert.ok(!callerInventory(root).historical.includes(backup));
  const nested=path.join(root,'.lane/supervisor/nested.py.bak-20261001-copy');
  fs.writeFileSync(nested,'node contrib/settle-watch.mjs\n',{mode:0o755});
  fs.appendFileSync(backup,`python3 ${nested}\n`);
  assert.ok(callerInventory(root).active.includes(nested));
  // Retirement itself has no backup or notify-file exemption.
  const compat=path.join(root,'compat.mjs');fs.writeFileSync(compat,'blob');
  assert.throws(()=>retireContrib(root,compat),/retirement refused/);
});

test('executable shell case arms cannot hide contrib callers or references to historical backups', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility blob');
  const script = path.join(root, '.lane/supervisor/case-caller.sh');
  fs.writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  *) node "$CURRENT/contrib/settle-watch.mjs" --open ;;\nesac\n', { mode: 0o755 });
  const active = callers(root, 'contrib/settle-watch.mjs');
  assert.ok(active.some((v) => v.file === script && v.line === 3));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
  assert.equal(fs.readFileSync(compat, 'utf8'), 'compatibility blob');
  const backup = path.join(root, '.lane/supervisor/old.py.bak-20261002-copy');
  fs.writeFileSync(backup, 'subprocess.run(["node", "contrib/settle-watch.mjs"])\n', { mode: 0o755 });
  fs.writeFileSync(script, `#!/bin/sh\ncase "$1" in\n  *) python3 ${backup} ;;\nesac\n`);
  assert.ok(callerInventory(root).active.includes(backup));
  assert.ok(!callerInventory(root).historical.includes(backup));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
});

test('referenced mode-0644 script backups are enumerated, retained transitively and prevent retirement', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility blob');
  const backup = path.join(root, '.lane/supervisor/old.py.bak-20261002-copy');
  const nested = path.join(root, '.lane/supervisor/nested.mjs.bak-20261002-copy');
  const unused = path.join(root, '.lane/supervisor/unused.sh.bak-20261002-copy');
  fs.writeFileSync(backup, `import subprocess\nsubprocess.run(['node', '${nested}'])\n`);
  fs.writeFileSync(nested, 'invoke("contrib/settle-watch.mjs");\n');
  fs.writeFileSync(unused, 'node contrib/settle-watch.mjs\n');
  for (const file of [backup, nested, unused]) fs.chmodSync(file, 0o644);
  fs.writeFileSync(path.join(root, 'scripts/lane/active.sh'), `#!/bin/sh\npython3 '${backup}'\n`);
  for (const file of [backup, nested, unused]) assert.ok(callerFiles(root).includes(file));
  const inventory = callerInventory(root);
  for (const file of [backup, nested]) {
    assert.ok(inventory.active.includes(file)); assert.ok(!inventory.historical.includes(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  }
  assert.deepEqual(inventory.historical, [unused]);
  assert.ok(callers(root, 'contrib/settle-watch.mjs').some(v => v.file === nested));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
  assert.equal(fs.readFileSync(compat, 'utf8'), 'compatibility blob');
  // The shared inventory used by the copier must retain the readable Python
  // backup's own compatibility call too, not only the transitive variant.
  fs.writeFileSync(backup, 'invoke("contrib/settle-watch.mjs");\n');
  assert.ok(callers(root, 'contrib/settle-watch.mjs').some(v => v.file === backup));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
});
