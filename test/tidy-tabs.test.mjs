import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { planTidy, isShellOnly, matchingRun, reportEvidenceFromRecords, reviewVerdict, reviewedAgentsFromRecords } from '../supervisor/tidy-tabs.mjs';
import { planRetirement } from '../lib/retire.mjs';

function fixture() {
  const agent = { name: 'lane-worker', agent: 'native', agent_status: 'done', pane_id: 'p', tab_id: 't', workspace_id: 'w', cwd: '/repo/lane', terminal_id: 'terminal' };
  const run = { id: 'R-1', item: 'ENG-1', started: { seq: 1 }, workspace: agent.cwd,
    meta: { agent: agent.name, pane: 'p', worker_workspace: 'w', terminal_id: agent.terminal_id, lane: 'topic' }, report: { seq: 2, outcome: 'done' } };
  return { common: '/repo/.git', workspaces: [{workspace_id:'w',worktree:{checkout_path:agent.cwd,repo_key:'/repo/.git',is_linked_worktree:true}}],
    record: { runs: [run], items: [{id:'ENG-1',role:'engineer',closed:{as:'done'}}] },
    git: [{path:agent.cwd,common:'/repo/.git',head:'head',clean:true,integrated:true,lane:'topic'}],
    tabs: [{tab_id:'t',workspace_id:'w'}], panes: [{pane_id:'p',tab_id:'t',workspace_id:'w',shellOnly:true,process_info:{shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}],process_tree_complete:true,process_tree:[{pid:1,identity:'shell',state:'S',command:'[zsh]'}]}}], agents:[agent] };
}
test('compatibility planner is the one shared pure policy', () => {
  const s=fixture(); assert.deepEqual(planTidy(s),planRetirement(s)); assert.equal(planTidy(s).close.length,1);
  s.record.items[0].closed=null;
  assert.deepEqual(planTidy(s),planRetirement(s)); assert.equal(planTidy(s).close.length,0);
  s.closeoutQueuePolicy=true;
  assert.deepEqual(planTidy(s),planRetirement(s)); assert.equal(planTidy(s).close.length,1);
  s.git[0].integrated=false;
  assert.deepEqual(planTidy(s),planRetirement(s)); assert.equal(planTidy(s).close.length,0);
});
test('labels, verdict files and session metadata cannot release an unknown occupant', () => {
  for(const label of ['watch R-1','deliver R-1','settle R-1','executive','plan','audit','review']) {
    const s=fixture();s.tabs[0].label=label;s.record.runs=[];
    s.reportedAgents=new Set(['lane-worker']);s.reviewedAgents=new Set(['lane-worker']);
    s.agents[0].session_metadata={status:'done',role:'review',verdict:'PASS'};
    assert.equal(planTidy(s).close.length,0,label);
  }
});
test('newer continuation on same pane defeats an old report even if its name changes', () => {
  const s=fixture(), old=s.record.runs[0];
  s.record.runs.push({...old,id:'R-2',started:{seq:3},report:null,meta:{...old.meta,agent:'renamed'}});
  assert.equal(matchingRun(s.agents[0],s.record.runs),null);
  assert.equal(planTidy(s).close.length,0);
});
test('tied launch identity is ambiguous and does not release', () => {
  const s=fixture();s.record.runs.push({...s.record.runs[0],id:'R-2'});
  assert.equal(matchingRun(s.agents[0],s.record.runs),null);
  assert.equal(planTidy(s).close.length,0);
  assert.equal(planTidy(s).keep[0].why,'ambiguous recorded launch identity for lane-worker');
  const evidence=reportEvidenceFromRecords(s.agents,s.record.runs,s.record.items);
  assert.equal(evidence.reportedAgents.size,0);
  assert.equal(evidence.reportKeepReasons.get('lane-worker'),'ambiguous recorded launch identity for lane-worker');
});
test('report keep reasons distinguish mismatched identity and missing report from ambiguity', () => {
  const s=fixture(), run=s.record.runs[0];
  run.meta.terminal_id='replacement';
  let evidence=reportEvidenceFromRecords(s.agents,s.record.runs,s.record.items);
  assert.equal(evidence.reportedAgents.size,0);
  assert.equal(evidence.reportKeepReasons.get('lane-worker'),'recorded launch identity does not match lane-worker');
  evidence=reportEvidenceFromRecords(s.agents,[],s.record.items);
  assert.equal(evidence.reportKeepReasons.get('lane-worker'),'no recorded report for lane-worker');
});
test('only a tie between newest candidate runs is ambiguous, including reused panes', () => {
  const s=fixture(), run=s.record.runs[0];
  s.record.runs.push({...run,id:'R-2',meta:{...run.meta,agent:'renamed'}});
  let evidence=reportEvidenceFromRecords(s.agents,s.record.runs,s.record.items);
  assert.equal(evidence.reportedAgents.size,0);
  assert.match(evidence.reportKeepReasons.get('lane-worker'),/^ambiguous/);
  const latest={...run,id:'R-3',started:{seq:3}};
  s.record.runs.push(latest);
  assert.equal(matchingRun(s.agents[0],s.record.runs),latest);
  evidence=reportEvidenceFromRecords(s.agents,s.record.runs,s.record.items);
  assert.deepEqual([...evidence.reportedAgents],['lane-worker']);
  assert.equal(evidence.reportKeepReasons.size,0);
});
test('verdict parsing remains evidence-only for compatibility readers', () => {
  assert.equal(reviewVerdict('\n**PASS**\n'),'PASS');assert.equal(reviewVerdict('heading\n**PASS**'),null);
  const reviewed=reviewedAgentsFromRecords([{name:'reviewer',role:'review-codex',topic:'topic',created_at:'2026-01-01T00:00:00Z'}],
    [{topic:'topic',verdict:'NEEDS-WORK',mtimeMs:Date.parse('2026-01-01T01:00:00Z')}]);
  assert.deepEqual([...reviewed],['reviewer']);
});
test('shell-only detection requires observed foreground processes', () => {
  assert.equal(isShellOnly({shell_pid:5,foreground_processes:[{name:'zsh',argv0:'zsh',pid:5}]}),true);
  assert.equal(isShellOnly({shell_pid:5,foreground_processes:[{name:'node',argv0:'node',pid:9}]}),false);
  assert.equal(isShellOnly(null),false);
});
