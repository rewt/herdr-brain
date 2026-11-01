// Positive terminal evidence for workers gated on an explicit session binding.
// A successful dispatcher is not delivery qualification for this protocol.
import {timingEvent,readTiming} from './run-timing.mjs';
import {workerReceipt,sameReceipt} from './worker-identity.mjs';

export function endedUnboundRun(run,events){
  if(!run||run.report||run.abandoned||events.some(e=>e.type==='run.session_bound'&&(e.run??e.id)===run.id))return null;
  try{
    const end=timingEvent(JSON.parse(run.meta.process_end));
    if(end.kind!=='process_end'||!['done','gone'].includes(end.outcome)||end.run!==run.id||end.item!==run.item||
        end.lane!==run.meta.lane||Date.parse(end.at)<Date.parse(run.started.at))return null;
    const source=events.findLast(e=>e.type==='run.updated'&&e.id===run.id&&e.meta?.process_end===run.meta.process_end);
    return source?{event:end,source:{seq:source.seq,type:source.type}}:null;
  }catch{return null;}
}

export function unboundEndedProof(job,run,events,state,journal){
  const end=endedUnboundRun(run,events),b=job.sessionBinding;
  const expired=['native session observation deadline expired','native session not established within the saved delivery deadline'].includes(b?.reason),
    unavailable=b?.reason==='native process continuity unavailable at launch',
    failed=typeof b?.reason==='string'&&b.reason.startsWith('native session observation failed: ');
  // Missing launch continuity can prove only absence, never an occupant's birth.
  const process=unavailable?!b.process&&!job.launchProcess:
    Number.isSafeInteger(job.launchProcess?.pid)&&b?.process?.pid===job.launchProcess.pid&&
      b.process.identity&&b.process.identity===job.launchProcess.identity;
  if(!end||job.native_launch_attempted!==true||!job.worker?.agentName||!process||
      job.workerSessionWaitProtocol!==2||job.resumeSession||job.resumeDeliveryProtocol||job.reuse||
      !['complete','prompt'].includes(job.stage)||job.stage==='prompt'&&job.launchSessionBindProtocol!==1||
      b?.status!=='unbound'||b.proposed||b.record_refusal||b.commit_attempts?.length||
      !(expired||unavailable||failed)||
      /EPERM|EACCES|native refusal|operation not permitted|permission denied|identity|ownership|unsafe|process changed|session changed|occupant|\bSTOP\b|\bHOLD\b/i.test(b.reason)||
      !sameReceipt(workerReceipt(run,state),b.receipt))return null;
  const start=Date.parse(b.prompted_at),deadline=Date.parse(b.deadline);
  if(!Number.isFinite(start)||!Number.isFinite(deadline)||deadline<=start||deadline-start>60000||
      Date.parse(end.event.at)<(expired?deadline:start)||!readTiming(journal).some(e=>JSON.stringify(e)===JSON.stringify(end.event)))return null;
  return{kind:'original-unbound-ended',process_end:end,missing_session_binding:true,
    delivery:'unqualified-binding-gated-worker',binding:{status:b.status,reason:b.reason,deadline:b.deadline}};
}
