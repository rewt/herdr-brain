import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { planRetirement, executeRetirement, laneRemovalReason } from '../lib/retire.mjs';
import { readDeclaredReferences, readLiveReferences } from '../supervisor/retire.mjs';

function fixture() {
  const events = [
    { type: 'item.added', id: 'ENG-1', kind: 'work', role: 'engineer' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: '/repo/lane', meta: {
      agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'terminal', agent_session_id: 'session', lane: 'topic' } },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: 'immutable' },
    { type: 'item.closed', id: 'ENG-1', as: 'done' },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2026-01-01T00:00:00Z' }));
  const record = fold(events);
  const snapshot = { common: '/repo/.git', record,
    git: [{ path: '/repo/lane', common: '/repo/.git', head: 'abc', clean: true, integrated: true, lane: 'topic' }],
    workspaces: [{ workspace_id: 'w', worktree: { checkout_path: '/repo/lane', repo_key: '/repo/.git', is_linked_worktree: true } }],
    tabs: [{ tab_id: 'w:t', workspace_id: 'w' }],
    panes: [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w', shellOnly: false,
      process_info: { shell_pid: 5, foreground_processes: [{ name: 'native', pid: 10 }], process_tree_complete: true, process_tree: [{pid:5,identity:'shell',state:'S',command:'[zsh]'},{pid:10,identity:'agent',state:'S',command:'[native]'}] } }],
    agents: [{ name: 'worker', agent: 'native', agent_status: 'done', pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w',
      cwd: '/repo/lane', terminal_id: 'terminal', agent_session: { value: 'session' }, state_change_seq: 4 }],
    references: [], handoffs: [], errors: [] };
  return snapshot;
}
const kept = s => { const p = planRetirement(s); assert.equal(p.close.length, 0); assert.equal(p.keep.length, 1); return p.keep[0].why; };

test('ingestion AND terminal chain plus clean integrated Git releases; no report or fold mutation', () => {
  const s = fixture(), before = JSON.stringify([...s.record.runs.values()]);
  const plan = planRetirement(s); assert.equal(plan.close.length, 1); assert.equal(plan.panes[0].decision, 'release');
  assert.equal(JSON.stringify([...s.record.runs.values()]), before);
  const actions = []; executeRetirement(plan, { observe: () => s, close: id => actions.push(id) });
  assert.deepEqual(actions, ['w:t']);
});

test('process state changes do not change identity tokens, but stopped processes still keep on fresh decision', () => {
  const s=fixture(), plan=planRetirement(s);
  s.panes[0].process_info.process_tree[1].state='R';
  assert.equal(planRetirement(s).close[0].token,plan.close[0].token);
  assert.equal(executeRetirement(plan,{observe:()=>s,close:()=>{}})[0].action,'closed');
  s.panes[0].process_info.process_tree[1].state='T';
  const refused=executeRetirement(plan,{observe:()=>s,close:()=>assert.fail('stopped process')});
  assert.equal(refused[0].action,'skip-close');assert.match(refused[0].why,/process/);
});

test('narrow watcher retirement keeps focus, extra occupants, jobs, missing ingestion and changed birth identities', () => {
  const base=fixture();base.agents=[];base.selfTab='w:t';base.selfRetirement={tab:'w:t',pane:'w:p',pid:10};
  base.callbacks=[{schema:'retirement-occupant/v1',kind:'watcher',common:base.common,cwd:'/repo/lane',workspace:'w',tab:'w:t',pane:'w:p',run:'R-1',
    shell:{pid:5,identity:'shell',command:'[zsh]'},process:{pid:10,identity:'agent',command:'[native]'},process_gone:false}];
  assert.equal(planRetirement(base).close.length,1);
  for(const variant of ['focus','extra-pane','extra-process','job','not-ingested','wrong-pid','wrong-birth','live-other-callback']) {
    const s=structuredClone(base);
    if(variant==='focus')s.tabs[0].focused=true;
    if(variant==='extra-pane')s.panes.push({...s.panes[0],pane_id:'w:q'});
    if(variant==='extra-process')s.panes[0].process_info.process_tree.push({pid:99,identity:'extra',command:'server',state:'S'});
    if(variant==='job')s.references.push({kind:'job',item:'ENG-1'});
    if(variant==='not-ingested')s.record.runs.get('R-1').report=null;
    if(variant==='wrong-pid')s.selfRetirement.pid=99;
    if(variant==='wrong-birth')s.callbacks[0].process.identity='replacement';
    if(variant==='live-other-callback')delete s.selfRetirement;
    assert.equal(planRetirement(s).close.length,0,variant);
  }
});

for (const variant of ['report-file-only', 'report-before-review', 'blocked', 'needs-human', 'working', 'unknown', 'wrong-common',
  'wrong-head', 'dirty', 'wrong-terminal', 'wrong-session', 'wrong-pane', 'wrong-cwd', 'new-shell', 'other-program',
  'focused', 'lab', 'persistent', 'operator', 'missing-process']) test(`keeps ${variant}`, () => {
  const s = fixture(), r = s.record.runs.get('R-1'), a = s.agents[0];
  if (variant === 'report-file-only') { r.report = null; r.report_path = '/exists/report.md'; }
  if (variant === 'report-before-review') s.record.items.get('ENG-1').closed = null;
  if (variant === 'blocked') r.report.outcome = 'blocked';
  if (variant === 'needs-human') r.report.outcome = 'needs_human';
  if (['working', 'unknown'].includes(variant)) a.agent_status = variant;
  if (variant === 'wrong-common') s.git[0].common = '/another/.git';
  if (variant === 'wrong-head') s.git[0].integrated = false;
  if (variant === 'dirty') s.git[0].clean = false;
  if (variant === 'wrong-terminal') a.terminal_id = 'reused';
  if (variant === 'wrong-session') a.agent_session.value = 'reused';
  if (variant === 'wrong-pane') r.meta.pane = 'w:q';
  if (variant === 'wrong-cwd') a.cwd = '/another/lane';
  if (variant === 'new-shell') s.panes.push({ ...s.panes[0], pane_id: 'w:q', shellOnly: true });
  if (variant === 'other-program') s.panes[0].process_info.foreground_processes.push({ name: 'server', pid: 99 });
  if (variant === 'focused') s.tabs[0].focused = true;
  if (variant === 'lab') s.workspaces[0].lab_owned = true;
  if (variant === 'persistent') s.workspaces[0].persistent = true;
  if (variant === 'operator') s.workspaces[0].operator = true;
  if (variant === 'missing-process') delete s.panes[0].process_info;
  assert.ok(kept(s));
});

test('pending review and NEEDS-WORK preserve the engineer across a fix gap', () => {
  const s = fixture(); s.record.items.set('REV-1', { id: 'REV-1', kind: 'work', role: 'reviewer', parent: 'ENG-1' });
  assert.match(kept(s), /review/);
  s.record.runs.set('R-2', { id: 'R-2', item: 'REV-1', started: { seq: 5 }, report: { seq: 6, outcome: 'done', extra: { verdict: 'NEEDS-WORK' } } });
  assert.match(kept(s), /PASS/);
  s.record.runs.get('R-2').report.extra.verdict = 'PASS'; assert.equal(planRetirement(s).close.length, 1);
  s.record.items.set('HUM-1', { id: 'HUM-1', role: 'human', parent: 'REV-1' }); assert.match(kept(s), /disposition/);
});

test('same native session new run keeps even after a rename and with immutable older report', () => {
  const s = fixture(), old = s.record.runs.get('R-1');
  s.record.runs.set('R-2', { ...old, id: 'R-2', started: { seq: 9 }, report: null, meta: { ...old.meta, agent: 'renamed' } });
  s.agents[0].name = 'renamed';
  assert.match(kept(s), /not ingested/); assert.equal(old.report.sha256, 'immutable');
});

test('confirmed supersession releases an older round only with a retained different successor', () => {
  const s = fixture(), old = s.record.runs.get('R-1'); old.report = null; s.record.items.get('ENG-1').closed = null;
  const newer = { ...old, id: 'R-2', started: { seq: 10 }, meta: { ...old.meta, agent: 'successor', pane: 'w:q', terminal_id: 'new-term', agent_session_id: 'new-session' } };
  s.record.runs.set(newer.id, newer);
  s.tabs.push({ tab_id: 'w:u', workspace_id: 'w' }); s.panes.push({ ...s.panes[0], pane_id: 'w:q', tab_id: 'w:u' });
  s.agents.push({ ...s.agents[0], name: 'successor', pane_id: 'w:q', tab_id: 'w:u', terminal_id: 'new-term', agent_session: { value: 'new-session' }, agent_status: 'working' });
  s.handoffs.push({ from: 'R-1', to: 'R-2', seq: 11, confirmed: true });
  assert.deepEqual(planRetirement(s).close.map(t => t.tab_id), ['w:t']);
  s.agents.pop(); assert.equal(planRetirement(s).close.length, 0);
});

test('all tab occupants must be independently eligible; metadata never releases', () => {
  const s = fixture(); s.panes.push({ ...s.panes[0], pane_id: 'w:q' }); s.agents.push({ ...s.agents[0], name: 'unrecorded', pane_id: 'w:q' });
  s.agents[1].session_metadata = { status: 'done', report: true, retired: true };
  assert.match(kept(s), /identity/);
});

for (const reference of [{ kind: 'promote', lane: 'topic' }, { kind: 'verify', item: 'ENG-1' }, { kind: 'host-check', run: 'R-1' },
  { kind: 'callback', pane: 'w:p' }, { kind: 'test-slot', cwd: '/repo/lane/subdir' }, { kind: 'waiter', label: 'checks in /repo/lane' },
  { kind: 'reconcile', global: true }]) test(`reference only keeps: ${reference.kind}`, () => {
  const s = fixture(); s.references.push(reference); assert.match(kept(s), /reference/);
  s.record.runs.get('R-1').report = null; assert.equal(planRetirement(s).close.length, 0);
});

for (const change of ['reactivated', 'native-session', 'head', 'record-reopened', 'reference', 'new-pane', 'read-error']) test(`executor rechecks ${change} and reports the fresh reason`, () => {
  const s = fixture(), plan = planRetirement(s), actions = [], logs = [];
  if (change === 'reactivated') s.agents[0].agent_status = 'working';
  if (change === 'native-session') s.agents[0].agent_session.value = 'new';
  if (change === 'head') s.git[0].head = 'changed-but-also-integrated';
  if (change === 'record-reopened') s.record.items.get('ENG-1').closed = null;
  if (change === 'reference') s.references.push({ run: 'R-1', kind: 'host-check', job: 'new' });
  if (change === 'new-pane') s.panes.push({ ...s.panes[0], pane_id: 'w:q' });
  const result = executeRetirement(plan, { observe: () => { if (change === 'read-error') throw Error('record unreadable'); return s; }, close: id => actions.push(id), log: e => logs.push(e) });
  assert.deepEqual(actions, []); assert.ok(result[0].why); assert.equal(logs[0].why, result[0].why);
  if (change === 'reactivated') assert.match(result[0].why, /working/);
});

test('restart/idempotency uses fresh authority; failures are cleanup failures', () => {
  const s = fixture(), plan = planRetirement(s);
  const failed = executeRetirement(plan, { observe: () => s, close: () => { throw Error('server unavailable'); } });
  assert.equal(failed[0].action, 'close-failed');
  s.tabs = []; s.panes = []; s.agents = [];
  assert.equal(executeRetirement(plan, { observe: () => s, close: () => assert.fail() })[0].action, 'already-gone');
  assert.equal(planRetirement(s).close.length, 0);
});

test('Git-only deletion rejects even a releasable pane until its removal is observed', () => {
  const s = fixture(); assert.match(laneRemovalReason(s, '/repo/lane'), /occupied/);
  s.tabs = []; s.panes = []; s.agents = []; assert.equal(laneRemovalReason(s, '/repo/lane'), null);
  s.references.push({ cwd: '/repo/lane', kind: 'host-check' }); assert.match(laneRemovalReason(s, '/repo/lane'), /reference/);
});

function referenceFixture(t) {
  const org = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-reference-')));
  t.after(() => fs.rmSync(org, { recursive: true, force: true })); fs.mkdirSync(path.join(org, 'references'));
  const file = path.join(org, 'references/job.json');
  const ref = { schema: 'herdr-reference/v1', owner: 'test', kind: 'host-check', job: 'job', state: 'running', item: 'ENG-1',
    created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-02T00:00:00Z' };
  return { org, file, ref, write: value => fs.writeFileSync(file, JSON.stringify(value)), now: Date.parse('2026-01-01T12:00:00Z') };
}
test('herdr-reference/v1 matches each declared key, expires visibly, and never releases', t => {
  const f = referenceFixture(t);
  for (const key of ['item', 'run', 'lane', 'cwd', 'pane']) {
    const ref = { ...f.ref, item: 'OTHER', [key]: { item: 'ENG-1', run: 'R-1', lane: 'topic', cwd: '/repo/lane', pane: 'w:p' }[key] };
    f.write(ref); const observed = readDeclaredReferences(f.org, f.now), s = fixture(); Object.assign(s, observed);
    assert.match(kept(s), /host-check reference job/);
    s.record.runs.get('R-1').report = null; assert.equal(planRetirement(s).close.length, 0);
  }
  f.write({ ...f.ref, expires_at: '2026-01-01T10:00:00Z' });
  const observed = readDeclaredReferences(f.org, f.now); assert.equal(observed.references.length, 0); assert.match(observed.diagnostics[0].reason, /expired/);
  const s = fixture(); Object.assign(s, observed); assert.equal(planRetirement(s).close.length, 1);
});
test('malformed, missing expiry, unknown schema, unreadable reference fail the whole project closed', t => {
  const f = referenceFixture(t);
  for (const value of [{ ...f.ref, schema: 'future/v2' }, { ...f.ref, expires_at: null }, { ...f.ref, state: 'done' }]) {
    f.write(value); const s = fixture(); Object.assign(s, readDeclaredReferences(f.org, f.now)); assert.match(kept(s), /project kept/);
  }
  fs.writeFileSync(f.file, '{'); assert.equal(readDeclaredReferences(f.org, f.now).errors.length, 1);
  fs.unlinkSync(f.file); fs.mkdirSync(f.file); assert.equal(readDeclaredReferences(f.org, f.now).errors.length, 1);
});
test('generic promote and trusted verify sources are read-only and include interrupted/reconcile holds', t => {
  const f = referenceFixture(t), common = path.join(f.org, 'common'), verifyStateDir = path.join(f.org, 'trusted');
  fs.mkdirSync(path.join(common, 'promote'), { recursive: true }); fs.mkdirSync(verifyStateDir);
  const file = path.join(common, 'promote/queue.json');
  const bytes = JSON.stringify({ identity: common, pending: [{ id: 'pending', topic: 'topic' }],
    current: { id: 'current', topic: 'topic' }, interrupted: [{ jobs: [{ id: 'interrupted', topic: 'topic' }] }],
    results: [{ id: 'reconcile', topic: 'topic', reconciliation: { state: 'pending' } }] }); fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(verifyStateDir, 'queue.json'), JSON.stringify({ schema: 'verify-queue/v1', identity: common,
    jobs: [{ id: 'verify', item: 'ENG-1', admission: {} }, { id: 'old', item: 'ENG-1', admission: {}, completed_at: 'then' }] }));
  const observed = readLiveReferences({ common, org: f.org, verifyStateDir, env: { MONITOR_TEST_SLOT_PATH: path.join(f.org, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(f.org, 'slot') } });
  assert.equal(observed.errors.length, 0); assert.deepEqual(observed.references.map(r => r.job), ['pending', 'interrupted', 'current', 'reconcile', 'verify']);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('pending settlement callbacks keep; completed receipts remain historical', t => {
  const f=referenceFixture(t), common=fs.realpathSync(f.org);
  fs.mkdirSync(path.join(f.org,'settle'));
  const file=path.join(f.org,'settle/R-1.json');
  fs.writeFileSync(file,JSON.stringify({common,run:'R-1',item:'ENG-1',lane:'topic',stage:'decide'}));
  const observe=()=>readLiveReferences({common,org:f.org,env:{MONITOR_TEST_SLOT_PATH:path.join(f.org,'slot'),MONITOR_TEST_SLOT_COMPAT_PATH:path.join(f.org,'slot')}});
  assert.equal(observe().references[0].kind,'settle callback');
  fs.writeFileSync(file,JSON.stringify({common,run:'R-1',stage:'complete'}));assert.deepEqual(observe().references,[]);
});
test('session display changes have no retirement authority', () => {
  const s=fixture(),plan=planRetirement(s),actions=[];
  s.agents[0].terminal_title='New display';s.agents[0].session_metadata={status:'working'};
  executeRetirement(plan,{observe:()=>s,close:id=>actions.push(id)});assert.deepEqual(actions,['w:t']);
});

test('background descendants and unknown kernel birth keep, and PID reuse invalidates a plan', () => {
  const s=fixture();s.panes[0].process_info.process_tree.push({pid:99,identity:'background',state:'S'});assert.match(kept(s),/process/);
  s.panes[0].process_info.process_tree.pop();const plan=planRetirement(s);s.panes[0].process_info.process_tree[1].identity='reused-pid';
  assert.equal(executeRetirement(plan,{observe:()=>s,close:()=>assert.fail()})[0].action,'skip-close');
});

test('older folds ignore the confirmed handoff event', () => {
  const events=[{type:'item.added',id:'ENG-1',role:'engineer',seq:1},{type:'run.started',id:'R-1',item:'ENG-1',seq:2},
    {type:'retirement.handoff',from:'R-1',to:'R-2',confirmed:true,seq:3}];
  assert.deepEqual([...olderFold(events).runs.values()],[...olderFold(events.slice(0,2)).runs.values()]);
});

test('a reported successor is reserved until the superseded pane is actually gone', () => {
  const s=fixture(),old=s.record.runs.get('R-1');
  const successor={...old,id:'R-2',started:{seq:10},meta:{...old.meta,agent:'successor',pane:'w:q',terminal_id:'next-term',agent_session_id:'next-session'}};
  s.record.runs.set('R-2',successor);s.tabs.push({tab_id:'w:u',workspace_id:'w'});s.panes.push({...s.panes[0],pane_id:'w:q',tab_id:'w:u'});
  s.agents.push({...s.agents[0],name:'successor',pane_id:'w:q',tab_id:'w:u',terminal_id:'next-term',agent_session:{value:'next-session'}});
  s.handoffs.push({from:'R-1',to:'R-2',seq:11,confirmed:true});
  const plan=planRetirement(s);assert.deepEqual(plan.close.map(t=>t.tab_id),['w:t']);assert.match(plan.keep[0].why,/retained successor/);
  s.tabs.shift();s.panes.shift();s.agents.shift();assert.deepEqual(planRetirement(s).close.map(t=>t.tab_id),['w:u']);
});

test('a native session without its launch receipt stays unknown even on the old terminal', () => {
  const s=fixture();delete s.record.runs.get('R-1').meta.agent_session_id;assert.match(kept(s),/identity/);
});

test('project reference damage is reported even when no tabs are present', () => {
  const s=fixture();s.tabs=[];s.panes=[];s.agents=[];s.errors=['malformed reference; project kept'];
  assert.deepEqual(planRetirement(s).diagnostics,[{reason:s.errors[0],scope:'project'}]);
});
