// One grouped notice uses the existing durable project-supervisor inbox. A
// started, refused or uncertain delivery remains with that original attempt.
import {createHash} from 'node:crypto';
import path from 'node:path';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {outcomeFailure} from '../lib/uncertain-outcome.mjs';

export function routeCloseoutAlarm({project,org,env,cli,state,save,guard,scopes}) {
  if(!scopes.length)return;
  const signature=JSON.stringify([project.identity,org,scopes]);
  const id=`line-closeout-alarm:${createHash('sha256').update(signature).digest('hex')}`;
  state.alarm_notices??={};
  const notice=state.alarm_notices[id]??={id,state:'pending'};
  if(notice.state!=='pending')return notice;
  let to;
  try{to=readProjectPolicy(project.canonical,'promote',env,{canonical:project.canonical}).config.to;}
  catch(error){notice.reason=error.message;save();return notice;}
  if(!to){notice.reason='recorded project supervisor binding is missing';save();return notice;}
  guard();
  notice.to=to;notice.state='started';delete notice.reason;save();
  const groups={};for(const scope of scopes)groups[scope.kind]=(groups[scope.kind]??0)+1;
  const directory=path.join(org,'line-service',createHash('sha256').update(JSON.stringify(project.identity)).digest('hex').slice(0,20));
  const message=`[closeout-alarm] ${scopes.length} finished allocations remain held; groups=${JSON.stringify(groups)}; evidence=${path.join(directory,'closeout.log')}; held-action=original closeout effects; next-owner=recorded PROJECT SUPERVISOR to disposition missing evidence with the original owners recorded in each scope. No refusal clearance, rebinding or replay is authorized.`;
  try{
    notice.receipt=JSON.parse(cli('supervisor/prompt-supervisor.mjs',[
      to,message,'--org',org,'--id',id,'--project-supervisor'
    ],{environment:{SUPERVISOR_INPUT_WAIT_SECONDS:'0'}}));
    notice.state=notice.receipt.delivered?'delivered':'queued';
  }catch(error){
    notice.receipt=error.receipt??null;
    let reply;try{reply=JSON.parse(error.receipt?.stdout);}catch{}
    if(error.receipt?.status===3&&reply?.queued===true&&reply.id===id){notice.receipt=reply;notice.state='queued';}
    else{notice.state='held';notice.reason=error.message;notice.failure=outcomeFailure(error);}
  }
  save();return notice;
}
