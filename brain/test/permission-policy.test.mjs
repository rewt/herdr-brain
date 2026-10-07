import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { permissionProject, permissionDecision } from '../lib/permission-policy.mjs';
import { auditPermission } from '../lib/permission-audit.mjs';
import { handlePermission, permissionHookArguments, servePermissionHook } from '../../supervisor/permission-hooks.mjs';
import { nativeSandboxLaunch } from '../../discovery/native-sandbox.mjs';
import { fallbackRequest, declineObserved } from '../lib/permission-fallback.mjs';
import { gitProject } from '../../lib/project.mjs';
import { parseScreen } from '../lib/capture.mjs';
const root = new URL('../../', import.meta.url).pathname;
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'sp-'));
  t.after(() => fs.rmSync(scratch, { force: true, recursive: true }));
  const repo = name => {
    const checkout = path.join(scratch, name); fs.mkdirSync(checkout);
    execFileSync('git', ['-C', checkout, 'init', '-q']);
    execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '--allow-empty', '-qm', 'seed']);
    const areas = Object.fromEntries(['record','worktrees','temp'].map(key => [key,path.join(scratch, `${name}-${key}`)]));
    Object.values(areas).forEach(dir => fs.mkdirSync(dir));
    return { checkout, identity: gitProject(checkout).identity, ...areas, layers: [] };
  };
  const own = repo('own'), peer = repo('peer'), fleet = path.join(scratch, 'fleet'); fs.mkdirSync(fleet);
  fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 6, projects: { own, peer } }));
  const env = { ...process.env, HERDR_MONITOR_FLEET: fleet, BRAIN_STATE: path.join(scratch, 'brain'), CODEX_HOME: path.join(scratch,'codex'), CLAUDE_CONFIG_DIR: path.join(scratch,'claude') };
  for (const key of ['HERDR_MONITOR_FLEET','BRAIN_STATE','CODEX_HOME','CLAUDE_CONFIG_DIR']) {
    const before = process.env[key]; process.env[key] = env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    fs.mkdirSync(env[key], { recursive: true });
  }
  fs.writeFileSync(path.join(env.BRAIN_STATE,'steward.json'), JSON.stringify({ alert_command: [process.execPath, '/unused-offline-alert'] }));
  const runTemp = path.join(own.temp, 'run'); fs.mkdirSync(runTemp);
  const binding = { kind: 'claude', workspace: own.checkout, canonical: own.checkout, identity: own.identity, org: own.record, runTemp, session: 'native-worker' };
  const file = (dir, name = 'report.md') => { const target = path.join(dir, name); fs.writeFileSync(target, 'report'); return target; };
  const event = target => ({ hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: target }, cwd: own.checkout, session_id: 'native-id' });
  return { scratch, own, peer, env, binding, runTemp, file, event, project: permissionProject(own.checkout, env) };
}
const decide = (f, event) => permissionDecision(event, { kind: 'claude', project: f.project, runTemp: f.runTemp });

test('native reads of checkout, record, lanes and this launch temp are the only approved class', t => {
  const f = fixture(t);
  for (const dir of [f.own.checkout, f.own.record, f.own.worktrees, f.runTemp]) assert.equal(decide(f, f.event(f.file(dir))).behavior, 'allow');
  const lane = path.join(f.own.worktrees,'linked'); execFileSync('git',['-C', f.own.checkout, 'worktree','add','-qb','lane', lane]);
  const event = { ...f.event(f.file(lane)), cwd: lane };
  assert.equal(decide(f, event).behavior, 'allow');
  assert.equal(permissionProject(lane, f.env).identity, f.own.identity);
  assert.equal(decide(f, f.event(f.file(f.own.temp))).behavior, 'deny', 'other run temps are excluded');
  assert.equal(permissionDecision(event, { kind: 'codex', project: f.project }).behavior,'deny');
});

test('foreign paths, traversal, symlink escapes, stale bindings and unknown input fail closed', async t => {
  const f = fixture(t), foreign = f.file(f.peer.checkout), safe = f.file(f.own.checkout);
  const link = path.join(f.own.checkout,'alias'); fs.symlinkSync(foreign,link);
  for (const target of [foreign, link, path.join(f.own.checkout,'../peer/report.md'), '/does/not/exist']) assert.equal(decide(f,f.event(target)).behavior,'deny');
  assert.equal(decide(f,{ ...f.event(safe), cwd: f.peer.checkout }).behavior,'deny');
  assert.equal(decide(f,{ ...f.event(safe), tool_input: { file_path:safe, command:'cat safe' } }).behavior,'deny');
  for (const tool_name of ['Bash','Glob','Grep','mcp__fs__Read','Write','apply_patch']) assert.equal(decide(f,{ ...f.event(safe), tool_name }).behavior,'deny');
  for (const event of [null, {}, {tool_input:null}, { ...f.event(safe),hook_event_name:'PreToolUse' }]) assert.equal(decide(f,event).behavior,'deny');
  const result = await handlePermission(f.event(safe),{ ...f.binding,identity:f.peer.identity },{env:f.env,home:f.env.BRAIN_STATE});
  assert.equal(result.output.hookSpecificOutput.decision.behavior,'deny');
});

test('never-list requests decline with an operator nudge and alert, including credential aliases', t => {
  const f = fixture(t);
  for (const command of ['cat .env','wallet payto fusion_chipnet','bitcoin-cli sendrawtransaction abc','git push','npm publish','deploy production','sudo cat report','chmod 777 file','trust hooks.json']) {
    const d = decide(f,{ ...f.event('ignored'),tool_name:'Bash',tool_input:{command} });
    assert.equal(d.behavior,'deny',command); assert.equal(d.alert,true,command); assert.match(d.message,/Do not work around/); assert.match(d.message,/record ask/);
  }
  const key = f.file(f.own.checkout,'.env'), alias = path.join(f.own.checkout,'ordinary'); fs.symlinkSync(key,alias);
  assert.equal(decide(f,f.event(alias)).alert,true);
  assert.equal(decide(f,{ ...f.event('ignored'),tool_name:'Bash',tool_input:{command:'cat report.md'} }).behavior,'deny');
});

test('audit precedes native decisions, persists repeated-request and launch approval circuit breakers', async t => {
  const f = fixture(t), event = f.event(f.file(f.own.checkout));
  for (let i = 0; i < 4; i++) {
    const result = await handlePermission(event,f.binding,{env:f.env,home:f.env.BRAIN_STATE,alert:async () => {}});
    assert.equal(result.output.hookSpecificOutput.decision.behavior,i<3?'allow':'deny');
    const data = JSON.parse(fs.readFileSync(path.join(f.env.BRAIN_STATE,'steward/permissions.json')));
    assert.equal(data.events.length,i+1);
  }
  const home = path.join(f.scratch,'other-brain');
  for (let i = 0; i < 33; i++) {
    const e = { ...event,session_id:String(i) };
    const result = auditPermission(home,f.binding,e,decide(f,e));
    assert.equal(result.decision.behavior,i<32?'allow':'deny');
  }
  for (let i = 0; i < 600; i++) auditPermission(home,f.binding,event,{behavior:'deny',reason:'declined',category:'security'});
  const bounded = JSON.parse(fs.readFileSync(path.join(home,'steward/permissions.json')));
  assert.equal(bounded.events.length,512);
  assert.equal(Object.values(bounded.sessions)[0].approvals,32,'compaction cannot reset approvals');
});

test('corrupt audit and disabled configuration deny rather than holding a dialog or granting access', async t => {
  const f = fixture(t), event = f.event(f.file(f.own.checkout));
  fs.writeFileSync(path.join(f.env.BRAIN_STATE,'steward.json'),'{"enabled":false}');
  assert.equal((await handlePermission(event,f.binding,{env:f.env,home:f.env.BRAIN_STATE})).output.hookSpecificOutput.decision.behavior,'deny');
  fs.writeFileSync(path.join(f.env.BRAIN_STATE,'steward/permissions.json'),'{');
  fs.writeFileSync(path.join(f.env.BRAIN_STATE,'steward.json'),'{}');
  assert.equal((await handlePermission(event,f.binding,{env:f.env,home:f.env.BRAIN_STATE})).output.hookSpecificOutput.decision.behavior,'deny');
});

test('Claude HTTP returns the same structured decisions with authentication and bounded malformed inputs', async t => {
  const f = fixture(t), alerts = [], server = servePermissionHook(f.binding,{env:f.env,home:f.env.BRAIN_STATE,alert:async p => alerts.push(p)}); t.after(server.close);
  const hook = await server.ready;
  const request = body => fetch(hook.url,{method:'POST',body:JSON.stringify(body)}).then(r=>r.json());
  const allowed = await request(f.event(f.file(f.own.checkout)));
  assert.deepEqual(allowed,{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}});
  const denied = await request({ ...f.event('unused'),tool_name:'Bash',tool_input:{command:'npm publish'} });
  assert.equal(denied.hookSpecificOutput.decision.behavior,'deny'); assert.match(denied.hookSpecificOutput.decision.message,/record ask/);
  assert.equal(alerts.length,1);
  assert.equal((await fetch(hook.url+'wrong',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(hook.url,{method:'POST',body:'x'.repeat(65537)}).then(r=>r.json())).hookSpecificOutput.decision.behavior,'deny');
  assert.equal((await fetch(hook.url,{method:'POST',body:'{'}).then(r=>r.json())).hookSpecificOutput.decision.behavior,'deny');
});

test('launch hooks stay per-session, retain other hooks and never bypass Codex hook trust', async t => {
  const f = fixture(t), binary = path.join(f.scratch,'native');
  fs.writeFileSync(binary,'#!/bin/sh\nif [ "$1" = --version ]; then echo 2.1.284; else echo "--sandbox --settings --add-dir --permission-profile"; fi\n',{mode:0o755});
  const context = { ...f.binding,tempRoot:f.own.temp,worktrees:f.own.worktrees,projects:[f.peer] };
  const old = {hooks:{PermissionRequest:[{hooks:[{type:'command',command:'existing'}]}],PreToolUse:[{matcher:'AskUserQuestion',hooks:[{type:'command',command:'question-hook'}]}]}};
  const launch = nativeSandboxLaunch({kind:'claude',binary,args:['--settings',JSON.stringify(old)],context,env:f.env}); t.after(launch.close);
  await launch.ready;
  const settings = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--settings')+1]));
  assert.deepEqual(settings.hooks.PermissionRequest[0],old.hooks.PermissionRequest[0]);
  assert.equal(settings.hooks.PermissionRequest.at(-1).hooks[0].type,'http');
  assert.deepEqual(settings.hooks.PreToolUse[0],old.hooks.PreToolUse[0]);
  const codex = permissionHookArguments('codex',context,root,f.runTemp,f.env);
  assert.match(codex.args[1],/hooks.PermissionRequest=/); assert.doesNotMatch(codex.args.join(' '),/bypass-hook-trust/);
  const next = permissionHookArguments('codex',context,root,path.join(f.own.temp,'other-run'),f.env);
  assert.equal(next.group.hooks[0].command,codex.group.hooks[0].command,'launch binding does not change hook trust fingerprint');
  const result = spawnSync('/bin/sh',['-c',codex.group.hooks[0].command],{env:{...f.env,...codex.env},input:JSON.stringify(f.event(f.file(f.own.checkout))),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior,'deny');
  for (const dir of [f.env.CODEX_HOME,f.env.CLAUDE_CONFIG_DIR]) assert.deepEqual(fs.readdirSync(dir),[],'no persistent settings/trust writes');
});

function observed() {
  const row = JSON.parse(fs.readFileSync(new URL('./fixtures/aggregator-gm-blocked.json',import.meta.url)));
  const parsed = parseScreen(row.screen,{agent:'claude'});
  return { ...row,...parsed,agent:'claude',terminal_id:'term',agent_session:'native' };
}
test('terminal fallback declines only the exact recorded read prompt after fresh occupant and screen checks', async () => {
  const row = observed(), agent = { agent:'claude',agent_status:'blocked',pane_id:row.pane,terminal_id:row.terminal_id,agent_session:row.agent_session,cwd:row.where };
  const calls = [], command = async (bin,args) => { calls.push(args); return { stdout: args[1]==='get'?JSON.stringify({result:{agent}}):args[1]==='read'?row.screen:'{}' }; };
  assert.equal(fallbackRequest(row).behavior,'deny');
  assert.equal((await declineObserved(row,agent,{command})).ok,true);
  assert.deepEqual(calls.at(-1),['agent','send-keys',row.session,'3']);
  assert.equal(calls.filter(a=>a[1]==='get').length,3);
  for (const mutation of ['occupant','screen']) {
    const effects = [];
    const changed = async (bin,args) => { effects.push(args); return {stdout:args[1]==='get'?JSON.stringify({result:{agent:mutation==='occupant'?{...agent,terminal_id:'other'}:agent}}):row.screen.replace('Read(', 'Write(')}; };
    assert.equal((await declineObserved(row,agent,{command:changed})).ok,false);
    assert.ok(effects.every(a=>a[1]!=='send-keys'));
  }
  assert.equal(fallbackRequest({...row,terminal_id:null}),null);
  assert.equal(fallbackRequest({...row,dialog:{...row.dialog,options:row.dialog.options.slice(0,3)}}),null);
});
