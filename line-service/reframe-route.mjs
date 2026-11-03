// One fresh other-family reframe, requested in a run's own report. The line
// picks its route, or holds with a reason and owner, before spending a session.
// Configured routes only; existing item.updated and note.added events only.
import {resolveLaunchRoute,selectRoute} from '../lanes/routes.mjs';
import {roleIs} from '../lib/roles.mjs';

const asks=/other[- ]family\b.*\brefram|\brefram.*\bother[- ]family\b/is;
const settled=/\b(already|completed|no longer|not (?:needed|required))\b/i;
const kindOf=(config,route)=>{try{return route?resolveLaunchRoute(config,{route}).kind:null;}catch{return null;}};
const familyOf=(run,config)=>run.meta?.harness??kindOf(config,run.meta?.route);
const reported=run=>Boolean(run?.report&&!run.abandoned);

// Blockers and decisions state what this run needs. Summaries, learnings and
// challenges also describe earlier reframes, so they are not requests.
export function reportRequestsReframe(report) {
  if(!['failed','blocked'].includes(report?.outcome))return false;
  const decisions=report.extra?.decisions??report.decisions??[];
  return [...(report.blockers??[]),...decisions.map(d=>d?.text)].some(text=>typeof text==='string'&&asks.test(text)&&!settled.test(text));
}

const outside=(config,route,family)=>{const kind=kindOf(config,route);return Boolean(kind&&kind!==family);};

function otherFamilyRoute({item,config,family,defaultRoute}) {
  const policy=()=>{try{return selectRoute(config,'reframe-other-family',family);}catch{return null;}};
  // An owner's explicit other-family route stands; the policy then the role default follow.
  return [()=>item.meta.route,policy,defaultRoute].map(pick=>pick()).find(route=>outside(config,route,family))??null;
}

export function reframeDisposition({item,state,events,config,defaultRoute=()=>null}) {
  if(!item||item.closed||item.kind==='goal'||roleIs(item,'REV')||roleIs(item,'DEC')||item.meta.exception_triage)return null;
  const runs=item.runs.map(id=>state.runs.get(id)),last=runs.at(-1);
  if(!reported(last)||!['failed','blocked'].includes(last.report.outcome))return null;
  if(!runs.some(run=>reported(run)&&reportRequestsReframe(run.report)))return null;
  // A reshape or a finished run starts a new trajectory.
  const reshaped=events.findLast(e=>e.id===item.id&&e.by!=='line-service'&&(e.type==='item.acceptance-amended'||e.type==='item.updated'&&Object.keys(e.fields??{}).some(k=>['accept','title'].includes(k))))?.seq??0;
  let first=-1;
  runs.forEach((run,index)=>{
    if(run?.report?.outcome==='done')first=-1;
    else if(first<0&&reported(run)&&(run.report.seq??0)>reshaped&&reportRequestsReframe(run.report))first=index;
  });
  if(first<0)return null;
  const request=runs[first],family=familyOf(request,config);
  const base={item:item.id,request_run:request.id,run:last.id,report_sha256:last.report.sha256,family:family??null};
  // Clearing a hold changes no input: the request stands until a route qualifies or the item is reshaped.
  const hold=(reason,next_action)=>({...base,action:'hold',reason,next_action});
  if(!family)return hold(`The requesting run ${request.id} has no recorded model family, so the line cannot tell which route is other-family.`,'Reshape the title or acceptance, then clear meta.hold.');
  const reframed=runs.slice(first+1).findLast(run=>reported(run)&&familyOf(run,config)&&familyOf(run,config)!==family);
  if(reframed)return last.report.outcome==='failed'||reportRequestsReframe(last.report)
    ?hold(`The one other-family reframe was already spent on ${reframed.id}; a failed reframe reshapes the item.`,'Reshape the title or acceptance, then clear meta.hold.'):null;
  // A saved route may wait on capacity across a configuration change, so its family is read afresh.
  if(item.meta.reframe?.report_sha256===last.report.sha256&&item.meta.reframe.route===item.meta.route&&outside(config,item.meta.route,family))return null;
  const route=otherFamilyRoute({item,config,family,defaultRoute});
  if(route)return{...base,action:'route',route};
  return hold(`No configured engineering route is outside the ${family} family for the reframe requested by ${request.id}.`,`Configure selection_policy.by_task_class["reframe-other-family"].${family} or an other-family meta.route, then clear meta.hold.`);
}

export function reframeEvents(disposition,{owner}) {
  const {item:id,action,request_run,run,report_sha256,family,route,reason,next_action}=disposition;
  if(action==='route')return[
    {type:'item.updated',id,fields:{meta:{route,reframe:{request_run,run,report_sha256,family,route}}}},
    {type:'note.added',id,text:`Line: ${request_run} requested one fresh other-family reframe after stopping on ${family}. The next run uses route ${route}. Start from the contract and failure ledger, not the old trajectory. A done report that delivers no source is advice and leaves this item open.`,decision:false}];
  return[
    {type:'item.updated',id,fields:{meta:{hold:true,hold_reason:reason,owner,next_action}}},
    {type:'note.added',id,text:`Line held the requested other-family reframe: ${reason} Owner: ${owner}. Next: ${next_action}`,decision:false}];
}

// The line's own recorded route is the changed input that restarts a blocked
// report; a same-family or edited route never is.
export function routedReframe({events,item,run}) {
  const marker=item.meta?.reframe;
  if(marker?.run!==run.id||marker.report_sha256!==run.report.sha256||marker.route!==item.meta.route)return null;
  return events.findLast(e=>e.type==='item.updated'&&e.by==='line-service'&&e.id===item.id&&e.seq>(run.report.seq??0)&&e.fields?.meta?.reframe?.report_sha256===run.report.sha256)??null;
}

// The run started on the line's recorded route. Only this run can be advice;
// later runs on the item are ordinary work.
export function reframeRun({item,run}) {
  const marker=item.meta?.reframe,at=item.runs.indexOf(marker?.run);
  return at>=0&&item.runs[at+1]===run.id&&run.meta?.route===marker.route;
}

// Its done report with no delivered source advises the item without finishing
// it. Reopening clears the done outcome so dependents stay blocked; the hold
// gives the advice an owner before another session is spent.
export function reframeAdviceEvents({item,run,owner}) {
  const reason=`${run.id} finished the reframe without delivering source, so its advice leaves the original work open.`;
  const next_action=`Read ${run.id}'s report, then clear meta.hold to start the implementation on meta.route, after setting another route or reshaping if the advice calls for it.`;
  return[
    {type:'item.reopened',id:item,note:reason},
    {type:'item.updated',id:item,fields:{meta:{hold:true,hold_reason:reason,reframe_advice:run.report.sha256,owner,next_action}}},
    {type:'note.added',id:item,text:`Line kept the item open: ${reason} Owner: ${owner}. Next: ${next_action}`,decision:false}];
}
