// Shared offline native CLI and explicitly enrolled, operator-authorized fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from '../../sessions/sessions.mjs';
import { plan } from '../../sessions/plan.mjs';
import { apply } from '../../sessions/apply.mjs';
import { authorize, ACTIONS } from '../../sessions/authorization.mjs';
import { recordStandardSlot } from '../../sessions/receipts.mjs';
import { readControllerJournal } from '../../sessions/runtime.mjs';
import { digest, persistHandoff } from '../../sessions/lifecycle-evidence.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export const fake = `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const file = process.env.SESSION_FAKE_STATE, s = JSON.parse(fs.readFileSync(file)), a = process.argv.slice(2);
s.calls.push(a);
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const out = result => {
  if (s.captureObservations && ['workspace list','agent list'].includes(a.slice(0,2).join(' ')))
    (s.observations ??= []).push({command:a.slice(0,2).join(' '),result});
  save(); console.log(JSON.stringify({result}));
};
const value = f => a[a.indexOf(f)+1];
// Mutate display fields on every CLI call, as a busy server does.
if (s.churn) for (const [rows, ids, key] of [[s.workspaces, s.churn.workspaces, 'workspace_id'], [s.agents, s.churn.agents, 'name']]) for (const row of rows) {
  if (!ids?.includes(row[key])) continue;
  row.title = 'spinner-' + s.calls.length; row.status = s.calls.length % 2 ? 'working' : 'idle';
  row.revision = s.calls.length; row.focused = s.calls.length % 2 === 0;
  if (row.name) row.agent_status = row.status;
}
if (s.changeOnCall?.command === a.slice(0, 2).join(' ')) {
  s.changeOnCall.seen = (s.changeOnCall.seen || 0) + 1;
  if (s.changeOnCall.seen === s.changeOnCall.at) Object.assign(s, s.changeOnCall.patch);
}
if (a[0] === 'workspace' && a[1] === 'list') out({workspaces:s.workspaces});
else if (a[0] === 'tab' && a[1] === 'list') out({tabs:s.tabs.filter(t=>t.workspace_id===value('--workspace'))});
else if (a[0] === 'pane' && a[1] === 'list') out({panes:s.panes.filter(p=>p.workspace_id===value('--workspace'))});
else if (a[0] === 'agent' && a[1] === 'list') { if(s.emptyAgentList) { save();process.exit(0); } out({agents:s.agents}); }
else if (a[0] === 'agent' && a[1] === 'get') out({agent:s.agents.find(g=>g.name===a[2])});
else if (a[0] === 'pane' && a[1] === 'get') {
  const pane=s.panes.find(p=>p.pane_id===a[2]);out({pane:pane && {...pane,...s.paneGetFields}});
}
else if (a[0] === 'pane' && a[1] === 'process-info') {
  if(s.stopAfterMarkerProcess && s.calls.some(c=>c[0]==='pane'&&c[1]==='run')) fs.writeFileSync(s.stopAfterMarkerProcess,'STOP');
  out({process_info:s.processInfo ?? {shell_pid:12,foreground_processes:[{pid:s.busy?13:12}]}});
}
else if (a[0] === 'pane' && a[1] === 'read') { save(); console.log(s.screen || 'fixture % '); }
else if (a[0] === 'pane' && a[1] === 'run') {
  if(a[3].startsWith('printf ')) { const parts = [...a[3].matchAll(/'([^']*)'/g)]; s.screen = parts.slice(-2).map(m=>m[1]).join('')+'\\nfixture % '; }
  else { s.viewer = a[3]; s.viewerOutput = execFileSync('/bin/sh', ['-c', a[3]], {encoding:'utf8'}); s.screen = s.viewerOutput+'\\nfixture % '; }
  if(s.stopOnMarker) fs.writeFileSync(s.stopOnMarker,'STOP');
  if(s.removeOnMarker) fs.unlinkSync(s.removeOnMarker);
  if(s.replaceOnMarker) s.panes.find(p=>p.pane_id===a[2]).terminal_id='other-terminal';
  save();process.stdout.write(s.paneRunOutput ?? '');process.exit(s.paneRunExit ?? 0);
} else if(a[0]==='tab' && a[1]==='create') {
  if(s.reuseCreate) { s.screen='fixture % ';out({tab:s.tabs.find(t=>t.tab_id==='keep-tab'),root_pane:s.panes.find(p=>p.pane_id==='keep-pane')}); }
  else {
  const n=++s.counter, tab={tab_id:'new-tab-'+n,workspace_id:value('--workspace')};
  const pane={pane_id:'new-pane-'+n,tab_id:tab.tab_id,workspace_id:tab.workspace_id,terminal_id:'new-term-'+n,foreground_cwd:value('--cwd')};
  s.tabs.push(tab);s.panes.push(pane);s.screen='fixture % ';
  if(s.lostCreate) { save();console.error('lost create acknowledgement');process.exit(1); }
  out({tab,root_pane:pane});
  }
} else if(a[0]==='tab' && a[1]==='close') {
  const workspace=s.tabs.find(t=>t.tab_id===a[2])?.workspace_id;
  const ids=s.panes.filter(p=>p.tab_id===a[2]).map(p=>p.pane_id);
  s.tabs=s.tabs.filter(t=>t.tab_id!==a[2]);s.panes=s.panes.filter(p=>!ids.includes(p.pane_id));s.agents=s.agents.filter(g=>!ids.includes(g.pane_id));
  if(!s.tabs.some(t=>t.workspace_id===workspace)) s.workspaces=s.workspaces.filter(w=>w.workspace_id!==workspace);
  out({});
} else if(a[0]==='agent' && a[1]==='start') {
  const argv=a.includes('--')?a.slice(a.indexOf('--')+1):[];
  if(argv.some(arg=>/[\\x00-\\x1f\\x7f-\\x9f]/u.test(arg))) {
    save();console.error(JSON.stringify({error:{code:'invalid_agent_argument',message:'agent arguments cannot be encoded safely for the target shell'}}));process.exit(1);
  }
  s.instructionsAtStart=value('--kind')==='claude'?fs.readFileSync(argv.at(-1),'utf8')
    :JSON.parse(argv.at(-1).slice('developer_instructions='.length));
  s.launchEnvironment={role:process.env.MONITOR_SESSION_ROLE,name:process.env.HERDR_AGENT_NAME,actor:process.env.ORG_ACTOR,record:process.env.ORG_DIR};
  const p=s.panes.find(p=>p.pane_id===value('--pane')), n=++s.counter;
  const idx=a.indexOf('--resume'), ri=a.indexOf('resume'), native=idx>=0?a[idx+1]:ri>=0?a[ri+1]:'native-'+n;
  if(idx>=0||ri>=0) p.terminal_id='resumed-term-'+n;
  s.agents.push({name:a[2],agent:value('--kind'),pane_id:p.pane_id,tab_id:p.tab_id,workspace_id:p.workspace_id,
    terminal_id:p.terminal_id,cwd:p.foreground_cwd,agent_session:{value:native},agent_status:'idle'});
  if(s.lostStart) { save(); console.error('lost acknowledgement');process.exit(1); }
  out({});
} else { save();console.error('unexpected fake CLI '+JSON.stringify(a));process.exit(1); }
`;
export const document = m => `## Manifest\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\`\n`;
export function fixture(t, role = 'chat', kind = 'claude') {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-session-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const cwd = path.join(scratch, 'repo'); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, 'seed'), 'fixture'); git('add', '.'); git('commit', '-qm', 'fixture');
  const org = path.join(scratch, 'record'); fs.mkdirSync(org);
  fs.writeFileSync(path.join(org, 'events.jsonl'), [
    { seq: 1, at: '2026-10-16T18:00:00Z', by: 'fixture-supervisor', type: 'item.added', id: 'ENG-1', title: 'Disposable fixture', role: 'engineer' },
    { seq: 2, at: '2026-10-16T18:00:01Z', by: 'fixture-supervisor', type: 'item.added', id: 'HUM-1', title: 'Approve the scoped fixture experiment?', role: 'human', parent: 'ENG-1',
      meta: { category:'security', session_authorization:JSON.stringify({schema:'session-authorization-scope/v1',common:path.join(cwd,'.git'),
        server:path.join(scratch,'native.sock'),workspace:'w',checkout:cwd,actions:ACTIONS}) } }
  ].map(JSON.stringify).join('\n') + '\n');
  const bin = path.join(scratch, 'fake-herdr.mjs'), state = path.join(scratch, 'native.json');
  fs.writeFileSync(bin, fake, { mode: 0o755 });
  const env = { ...process.env, ORG_DIR: org, LANE_CONFIG: undefined, HERDR_BIN_PATH: bin, SESSION_FAKE_STATE: state,
    CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'),
    HERDR_SOCKET_PATH: path.join(scratch, 'native.sock'), HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'), BRAIN_SHADOW_ROOT: path.join(scratch, 'shadow'), BRAIN_IDENTITY:'fixture' };
  // Use the real operator-answer producer, with an explicit simulated human.
  execFileSync(process.execPath,[path.join(root,'bin/org.mjs'),'answer','HUM-1','yes'],{cwd,env:{...env,ORG_ACTOR:'human'},stdio:['ignore','pipe','pipe']});
  const m = JSON.parse(fs.readFileSync(path.join(root, `sessions/templates/${role === 'logs' ? 'logs-viewer' : role}.md`), 'utf8').split('```json')[1].split('```')[0]);
  m.spec.workspaceRef = 'w';
  if (kind === 'codex') m.spec.route = 'engineer';
  const file = path.join(scratch, 'manifest.md'); fs.writeFileSync(file, document(m));
  const inspection = inspect({ cwd, files: [file], env }), project = inspection.project;
  assert.equal(inspection.valid, true, JSON.stringify(inspection.diagnostics));
  const native = { server: env.HERDR_SOCKET_PATH, complete: true, workspaces: [{workspace_id:'w',worktree:{repo_key:project.common,checkout_path:cwd}}],
    tabs:[{tab_id:'tab',workspace_id:'w'},{tab_id:'keep-tab',workspace_id:'w'}],
    panes:[{pane_id:'pane',tab_id:'tab',workspace_id:'w',terminal_id:'term',foreground_cwd:cwd},
      {pane_id:'keep-pane',tab_id:'keep-tab',workspace_id:'w',terminal_id:'keep-term',foreground_cwd:cwd}],agents:[],receipts:[],errors:[],counter:0,calls:[] };
  if (role === 'logs') native.panes.push({pane_id:'triage-pane',tab_id:'tab',workspace_id:'w',terminal_id:'triage-term',foreground_cwd:cwd});
  fs.writeFileSync(state, JSON.stringify(native));
  const read = () => JSON.parse(fs.readFileSync(state)), change = fn => { const s = read(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  recordStandardSlot({ cwd, action: 'adopt', uid: 'fixture-slot', actor: 'fixture', why: 'disposable offline test', slot: {
    server: env.HERDR_SOCKET_PATH, workspace: 'w', checkout: cwd, tab: 'tab', standardSlot: role,
    panes: role === 'logs' ? [{pane:'pane',paneSlot:'viewer'},{pane:'triage-pane',paneSlot:'triage'}] : [{pane:'pane',paneSlot:'primary'}] } });
  const evidence = path.join(scratch, 'evidence.json');
  fs.writeFileSync(evidence, JSON.stringify({schema:'session-experiment-evidence/v1',common:project.common,server:env.HERDR_SOCKET_PATH,workspace:'w',resetRequests:{},recovery:{},quiescence:{},losses:[]}));
  const updateEvidence = fn => { const e = JSON.parse(fs.readFileSync(evidence)); fn(e); fs.writeFileSync(evidence,JSON.stringify(e)); };
  const observer = { observe: async () => read(), close() {} };
  const options = {cwd,files:[file],workspace:'w',env,observer,evidence};
  const f = {scratch,cwd,git,org,env,state,read,change,project,file,evidence,updateEvidence,options,uid:m.metadata.uid,role};
  f.events = () => fs.readFileSync(path.join(org,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  f.writeEvents = events => fs.writeFileSync(path.join(org,'events.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
  f.auth = changes => authorize({cwd,workspace:'w',actions:ACTIONS,operatorDecision:{id:'HUM-1',seq:3},expiresAt:new Date(Date.now()+3600000).toISOString(),role:'supervisor',actor:'fixture-supervisor',env,...changes});
  f.plan = () => plan(options);
  f.apply = async (authorization = f.auth().file) => {
    const planFile=path.join(scratch,'plan.json'); fs.writeFileSync(planFile,JSON.stringify(await f.plan()));
    return apply({...options,authorization,planFile});
  };
  f.binding = () => { const j=readControllerJournal(project.common); return j.incarnations.at(-1)?.binding ?? j.operations.findLast(op=>op.state==='acknowledged')?.receipt?.binding; };
  f.transcript = (b = f.binding(), config = env.CLAUDE_CONFIG_DIR) => path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${b.nativeSessionId}.jsonl`);
  f.persistConversation = (b = f.binding()) => {
    const file = f.transcript(b); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'opaque fixture conversation; not valid JSON\n', { mode: 0o000 }); return file;
  };
  f.loss = () => {
    const b = f.binding(), source = readControllerJournal(project.common).operations[0];
    const contextRef = path.join(project.common, 'sessions/contexts', source.id + '.json');
    const route = inspect(options).entries[0].resolvedSpec.resolvedRoute;
    change(s => { s.agents = []; s.screen = 'fixture % '; });
    updateEvidence(e => {
      e.losses = [{ binding: b, state: 'confirmed-exit', ref: 'exit-receipt', processConfirmedGone: true,
        restore: { state: 'none' }, failures: 0, backoffReady: true }];
      e.recovery[f.uid] = { mode: 'resume', contextRef, contextVerified: true,
        contextHash: digest(JSON.parse(fs.readFileSync(contextRef))), nativeSessionId: b.nativeSessionId, route };
    });
    return b;
  };
  f.boundary = async (pending = []) => {
    const b=f.binding(), h=persistHandoff({file:path.join(scratch,'handoff.md'),markdown:'# Handoff\nPreserve fixture question.\n',recordRefs:['ENG-1'],unresolvedMessageIds:pending,inboxCursor:'transport:0'});
    updateEvidence(e=>{
      e.resetRequests[f.uid]={boundary:{kind:'handoff',ref:'boundary-1',declared:true,draft:'complete'},handoff:h};
      e.quiescence[f.uid]={ref:'q-1',binding:b,recordSeq:5,callbacksQuiesced:true,openWork:[],openReviews:[],inFlightDeliveries:[],pendingInboxIds:pending,recordRefs:h.recordRefs,unresolvedMessageIds:pending,inboxCursor:h.inboxCursor};
    });
  };
  return f;
}
