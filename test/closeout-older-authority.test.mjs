import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {fold} from '../lib/state.mjs';
import {planRetirement,executeRetirement} from '../lib/retire.mjs';

function fixture(){
  const native=(n,cwd)=>({agent:`worker-${n}`,pane:`w${n}:p`,worker_workspace:`w${n}`,terminal_id:`term-${n}`,agent_session_id:`session-${n}`,lane:`topic-${n}`});
  const es=[{type:'item.added',id:'ENG-1',role:'engineer'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:'/repo/old',meta:native(1)},
    {type:'report.ingested',run:'R-1',sha256:'old',report:{outcome:'done'}},
    {type:'run.started',id:'R-2',item:'ENG-1',workspace:'/repo/new',meta:native(2)}]
    .map((e,i)=>({...e,seq:i+1,at:'2026-01-01T00:00:00Z'}));
  const s={common:'/repo/.git',record:fold(es),reportCloseout:{run:'R-1',cwd:'/repo/old'},closeoutQueuePolicy:true,
    workspaces:[],tabs:[],panes:[],agents:[],git:[],references:[],errors:[],handoffs:[]};
  for(const [n,cwd] of [[1,'/repo/old'],[2,'/repo/new']]){
    s.workspaces.push({workspace_id:`w${n}`,worktree:{checkout_path:cwd,repo_key:s.common,is_linked_worktree:true}});
    s.tabs.push({tab_id:`w${n}:t`,workspace_id:`w${n}`});
    s.panes.push({pane_id:`w${n}:p`,tab_id:`w${n}:t`,workspace_id:`w${n}`,terminal_id:`term-${n}`,shellOnly:false,
      process_info:{shell_pid:n*10,process_tree_complete:true,foreground_processes:[{pid:n*10+1,name:'codex'}],
        process_tree:[{pid:n*10,identity:`shell-${n}`,state:'S',command:'[zsh]'},
          {pid:n*10+1,ppid:n*10,identity:`native-${n}`,state:'S',command:'[codex]'},
          {pid:n*10+2,ppid:n*10+1,identity:`helper-${n}`,state:'S',command:'[node]'}]}});
    s.agents.push({name:`worker-${n}`,agent:'codex',agent_status:n===1?'done':'working',pane_id:`w${n}:p`,tab_id:`w${n}:t`,workspace_id:`w${n}`,
      cwd,terminal_id:`term-${n}`,agent_session:{value:`session-${n}`}});
    s.git.push({path:cwd,common:s.common,head:`head-${n}`,clean:true,integrated:true,lane:`topic-${n}`});
  }
  return s;
}

test('finished older tab authority excludes its disjoint active successor native churn',()=>{
  const s=fixture(),before=planRetirement(s),candidate=before.close.find(c=>c.tab_id==='w1:t');
  assert.equal(candidate.decision,'exit');assert.equal(before.keep.find(c=>c.tab_id==='w2:t').decision,'keep');
  s.panes[1].terminal_title='successor typing';s.panes[1].process_info.process_tree[2].identity='new-helper';
  s.agents[1].state_change_seq=100;s.agents[1].agent_status='blocked';
  assert.equal(planRetirement(s).close.find(c=>c.tab_id==='w1:t').token,candidate.token);
  let exits=0,closes=0;
  const result=executeRetirement({...before,close:[candidate],workspaceClose:[]},{observe:()=>s,
    exit:()=>{exits++;s.agents=s.agents.filter(a=>a.pane_id!=='w1:p');const p=s.panes[0];p.shellOnly=true;
      p.process_info.foreground_processes=[{pid:10,name:'zsh'}];p.process_info.process_tree=p.process_info.process_tree.slice(0,1);
      s.exits=[{common:s.common,cwd:'/repo/old',workspace:'w1',tab:'w1:t',pane:'w1:p',run:'R-1',
        occupant:{name:'worker-1',agent:'codex',pane_id:'w1:p',workspace_id:'w1',cwd:'/repo/old',terminal_id:'term-1',agent_session_id:'session-1'},shell:candidate.shell}];},
    close:()=>{closes++;}});
  assert.equal(exits,1,JSON.stringify(result));assert.equal(closes,1,JSON.stringify(result));
});

for(const kind of ['working','terminal','birth','child','head','claim','reference','HOLD','shared-pane','shared-folder'])test(`older tab fresh authority retains ${kind}`,()=>{
  const s=fixture(),plan=planRetirement(s),candidate=plan.close.find(c=>c.tab_id==='w1:t');
  if(kind==='working')s.agents[0].agent_status='working';
  if(kind==='terminal')s.agents[0].terminal_id='replacement';
  if(kind==='birth')s.panes[0].process_info.process_tree[1].identity='replacement';
  if(kind==='child')s.panes[0].process_info.process_tree.push({pid:99,ppid:10,identity:'unowned',command:'[node]',state:'S'});
  if(kind==='head')s.git[0].head='changed';
  if(kind==='claim')s.record.runs.get('R-1').owner_generation=500;
  if(kind==='reference')s.references.push({kind:'pending job',run:'R-1'});
  if(kind==='HOLD')s.retirementHold='HOLD';
  if(kind==='shared-pane')s.record.runs.get('R-2').meta.pane='w1:p';
  if(kind==='shared-folder')s.record.runs.get('R-2').workspace='/repo/old';
  const results=executeRetirement({...plan,close:[candidate],workspaceClose:[]},{observe:()=>s,
    exit:()=>assert.fail('changed authority must not send input'),close:()=>assert.fail('changed authority must not close')});
  assert.ok(results.every(r=>['skip-close','held'].includes(r.action)),JSON.stringify(results));
});
