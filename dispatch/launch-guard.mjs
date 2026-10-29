// Read current launch inputs at the effect boundary, not an admission snapshot.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {loadEvents} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {assertOwner,readOwnedRun} from '../lib/run-owner-guard.mjs';
import {gitProject} from '../lib/project.mjs';
import {bundleRelease} from '../lib/releases.mjs';
import {dispatchInput} from '../line-service/phase1.mjs';
import {itemLaunchHold} from '../lib/item-launch-hold.mjs';
import {correctionSource} from '../lib/report-closeout.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {resumeSource} from './resume-source.mjs';

export const launchDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const changed = (reason, input) => {
  throw Object.assign(Error(`dispatch launch input changed: ${reason}`), {code:'DISPATCH_INPUT_CHANGED',launch_input:input});
};

function checkCorrectionAllocation(job, refuse) {
  const actual=gitProject(job.workspace),git=args=>execFileSync('git',['-C',job.workspace,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const entry=git(['worktree','list','--porcelain']).split('\n\n').find(e=>e.split('\n').includes(`branch refs/heads/lane/${job.lane}`));
  const registered=entry?.split('\n').find(l=>l.startsWith('worktree '))?.slice(9);
  if(actual.identity!==job.common||actual.checkout!==job.workspace||actual.canonical!==job.repo||job.workspace===job.repo||
      registered!==job.workspace||git(['rev-parse','HEAD'])!==job.base||git(['status','--porcelain=v1']))
    refuse('launched fresh fix source changed before prompt or launch');
}

export function checkDispatchEligibility(job, journal, {boundary='launch'}={}) {
  if(!['launch','prompt'].includes(boundary))throw Error('unknown dispatch input boundary');
  const {events,tornTail}=loadEvents(job.org),state=fold(events);
  const input={journal,token:job.token,item:job.item,run:job.run??null,project:job.common,
    release:job.release,observed_seq:events.at(-1)?.seq??0};
  const refuse=(reason,subject=job.item)=>changed(reason,{...input,subject});
  if(tornTail)refuse('incomplete record input');
  if(events.some(e=>e.journal===journal&&(e.type==='dispatch.allocation-finalized'||e.type==='closeout.allocation-effect')))
    refuse('original stopped allocation has entered final disposition; retain its original request');
  const item=state.items.get(job.item),hold=itemLaunchHold(state,job.item,events);
  if(hold)refuse(hold.reason,hold.subject);
  if(job.resumeSession && [...state.runs.values()].some(r=>r.id!==job.run&&!r.report&&!r.abandoned&&
    effectiveWorkerIdentity(r,state).agent_session_id===job.resumeSession))
    refuse('an active run owns the requested native conversation');
  if(job.run){
    const run=assertOwner(readOwnedRun(job.org,job.run,events),job.ownership);
    if(item.runs.at(-1)!==job.run||run.report||run.abandoned)refuse('current run was superseded or finished');
    if(run.item!==job.item||run.meta.dispatch_journal!==journal||run.meta.dispatch_attempt!==job.token||
        run.meta.dispatch_project!==job.common||run.meta.dispatch_record!==job.org||
        fs.realpathSync(run.workspace)!==job.workspace||run.meta.route!==job.route||
        Object.entries(job.declared).some(([key,value])=>(run.meta[key]??null)!==value))
      refuse('run/intent no longer matches the saved request');
  }
  if(job.correction) {
    if(boundary==='launch') {
      const source=correctionSource({item,state,events,repo:job.repo,org:job.org,request:{job,journal}});
      // New main-based fixes own the selected commit, including when their
      // retained author lane is already integrated. Concurrent FF landings do
      // not change that input. Kept unlanded refs and older saved requests keep
      // their exact source CAS; a rewind or newly unlanded author still refuses.
      if(job.correctionLaunchProtocol===1&&!job.correction.ref&&!source?.ref&&source) {
        if(job.base!==job.correction.base)refuse('saved author source changed before fresh fix launch');
        try { execFileSync('git',['-C',job.repo,'merge-base','--is-ancestor',job.base,source.base],{stdio:'pipe'}); }
        catch(error) { if(error.status!==1)throw error;refuse('saved author source changed before fresh fix launch'); }
        if(job.workspace)checkCorrectionAllocation(job,refuse);
      } else if(source?.base!==job.correction.base||source?.ref!==job.correction.ref)
        refuse('saved author source changed before fresh fix launch');
    } else {
      // Mutable author refs/main select the source BEFORE native launch. Once
      // launched, this allocation owns the frozen commit; unrelated landings or
      // removal of an integrated author ref must not strand its idle worker.
      // Keep the prompt bound to the actual registered, unchanged allocation.
      if(!job.run||!job.worker||job.native_launch_attempted!==true||job.base!==job.correction.base)
        refuse('fresh fix has no owned launched source before prompt');
      checkCorrectionAllocation(job,refuse);
    }
  }
  if (job.resume) {
    if (boundary === 'launch') {
      const source = resumeSource({ events, session: job.resumeSession, item, lane: job.lane,
        harness: job.declared.harness, repo: job.repo });
      if (source.base !== job.resume.base || source.workspace !== job.resume.workspace)
        refuse('saved resume source changed before launch');
    }
    if (job.workspace) {
      const actual = gitProject(job.workspace);
      const git = args => execFileSync('git', ['-C', job.workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (actual.identity !== job.common || actual.checkout !== job.resume.workspace ||
          git(['symbolic-ref', '--short', 'HEAD']) !== job.resume.branch || git(['rev-parse', 'HEAD']) !== job.base || git(['status', '--porcelain=v1']))
        refuse('resumed allocation source or worktree path changed');
    }
  }
  if(job.lineInput){
    // Exclude only this request's own admission. Its original predecessor and
    // all unrelated events remain intact, including qualified pending effects.
    if(job.run){
      state.items.set(item.id,{...item,runs:item.runs.filter(id=>id!==job.run)});
      state.runs.delete(job.run);
    }
    if(dispatchInput({events,state,item:state.items.get(job.item),org:job.org,identity:job.common})!==job.lineInput)
      refuse('readiness or genuine changed input differs from its frozen request');
  }
  return input;
}

// The parent holds its existing request/admission locks. Bind the child to the
// exact pending intent bytes; these checks confer no new launch authority.
export function checkDispatchLaunch({journal,sha256,repo,workspace,topic}) {
  if(!fs.lstatSync(journal).isFile()||fs.realpathSync(journal)!==path.resolve(journal))throw Error('dispatch request is redirected');
  const bytes=fs.readFileSync(journal);
  if(!/^[a-f0-9]{64}$/.test(sha256??'')||launchDigest(bytes)!==sha256)
    changed('pending request bytes differ from the captured launch',{journal,request_sha256:sha256});
  const job=JSON.parse(bytes),actual=gitProject(repo),target=gitProject(workspace);
  if(job.common!==actual.identity||target.identity!==actual.identity||job.repo!==repo||
      target.checkout!==workspace||job.workspace!==workspace||job.lane!==topic||
      fs.realpathSync(job.org)!==job.org||path.dirname(journal)!==path.join(job.org,'dispatch')||
      job.release?.root!==bundleRelease().root||job.stage!=='launching'||job.native_launch_attempted!==true||job.worker)
    throw Error('dispatch source/project/pending-effect identity changed');
  if (job.resumeDeliveryProtocol && (!job.resumeSession || !job.resumeDelivery ||
      job.resumeDelivery.session !== job.resumeSession || job.resumeDelivery.cwd !== workspace ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(job.resumeDelivery.agentName ?? '') ||
      typeof job.resumeDelivery.template !== 'string' || !job.resumeDelivery.template.trim() ||
      typeof job.resumeDelivery.marker !== 'string' || !job.resumeDelivery.marker ||
      !Number.isFinite(Date.parse(job.resumeDelivery.started_at)) ||
      Date.now() >= Date.parse(job.resumeDelivery.started_at) + 60000))
    throw Error('resume delivery intent is missing, changed or expired; retain the original attempt');
  const directory=path.join(actual.canonical,'.lane/supervisor');
  const stops=[path.join(directory,'STOP'),path.join(directory,'HOLD')];
  if(job.detached||job.detachedRequested)stops.push(path.join(job.org,'line-service',launchDigest(JSON.stringify(job.common)).slice(0,20),'STOP'));
  if(stops.some(file=>fs.existsSync(file)))throw Object.assign(Error('STOP/HOLD prevents native dispatch effect'),{code:'DISPATCH_STOPPED'});
  return {...checkDispatchEligibility(job,journal),request_sha256:sha256,resumeSession:job.resumeSession??null,
    ...(job.resumeDeliveryProtocol ? {resumeDelivery:job.resumeDelivery} : {})};
}
