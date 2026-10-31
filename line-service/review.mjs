// Conservative automatic-review eligibility. Receipts are evidence, not launch authority.
import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { reviewScope } from '../settle/review-range.mjs';
import { gitProject } from '../lib/project.mjs';
import { fileURLToPath } from 'node:url';
import { projectPin, selectRelease, bundleRelease } from '../lib/releases.mjs';
import {probationRuntime} from './probation.mjs';
import { roleIs } from '../lib/roles.mjs';
import {reviewResolution,archivedReviewFile,reviewDigest} from './review-resolutions.mjs';
import {producerGroupKey,queueProducerGroup,sameProducerQueue,capturedReviewCommits,sameCapturedTarget} from './review-group.mjs';
import {canonical} from '../messages/schema.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';
import {additionalTarget,disjointCapture,captureEvidence} from './review-targets.mjs';
import {producerReviewObservation} from './review-observation.mjs';
import {producerReportHandoff,resolvedReference} from './review-reference-proof.mjs';

const codeRoot = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const capabilityFiles = ['line-service/review.mjs','line-service/review-reference-proof.mjs','line-service/review-observation.mjs','line-service/review-targets.mjs','line-service/review-group.mjs', 'settle/settle.mjs', 'supervisor/supervisor.mjs'];
const capability = capabilityFiles.map(file => createHash('sha256').update(fs.readFileSync(path.join(codeRoot, file))).digest('hex'));

const sha = value => createHash('sha256').update(value).digest('hex');
const commit = value => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value ?? '');
const read = (file, missing = null) => {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return missing;
  if (!stat.isFile() || fs.realpathSync(file) !== path.resolve(file)) throw Error(`review inventory is redirected: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const missingJournal = Symbol('missing service journal');
// A path/name is a locator, not a native attempt. Only readable typed content
// can retain its captured subject. Current effect-journal loading stays strict.
export const typedReviewAttempt = v => Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&(
  // Producer handoffs remain fenced until their guarded disposition. Their
  // producing worker is attributed by type when proving no queue was attempted.
  producerReportHandoff(v)||
  v.native_launch_attempted===true||v.worker||v.reviewer||v.launchProcess||
  ['settle','review','reviewer'].includes(v.kind)||
  typeof v.stage==='string'&&(v.run||v.item||v.head)||
  (v.qualification||v.native_qualification||v.verdict)&&(v.run||v.item)));
const reference = file => {try{return read(file);}catch{return null;}};
export function readServiceJournal(file) {
  const saved = read(file, missingJournal);
  if (saved === missingJournal) return null;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
      !saved.actions || typeof saved.actions !== 'object' || Array.isArray(saved.actions))
    throw Error(`unrecognized service review inventory; absence UNKNOWN: ${file}`);
  return saved;
}
function entries(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`review inventory is redirected: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true });
}
const contains = (value, tokens) => {
  if (typeof value === 'string') return tokens.has(value);
  if (Array.isArray(value)) return value.some(v => contains(v, tokens));
  return value && typeof value === 'object' && Object.values(value).some(v => contains(v, tokens));
};

// A decision can describe reviews without directing a hold. Only an explicit
// directive holds, and only for a full commit it names exactly. Known commits
// are checked against the text; no token is extracted (labels such as head or
// base end in hex letters and run straight into the hash).
const holdDirective=/^(?:(?:new\s+)?(?:independent\s+)?review\s+hold\b|hold\s+(?:the\s+)?(?:independent\s+)?review\b|independent\s+(?:post-code\s+)?review\s+(?:attempt\s+)?held\b|(?:C\d+\s+)?retain(?:ed)?\s+(?:the\s+)?(?:independent\s+)?review(?:er|\s+attempt)\b)/i;
export const explicitReviewHold=e=>e.type==='note.added'&&Boolean(e.decision)&&holdDirective.test((e.text??'').trim());
const namesCommit=(text,head)=>{
  for(let i=text.indexOf(head);i>=0;i=text.indexOf(head,i+1)){
    const before=text.slice(0,i);
    const startsCommit=!/[a-f0-9]$/i.test(before)||/(?:^|\W)(?:head|base)$/i.test(before);
    if(startsCommit&&!/[a-f0-9]/i.test(text[i+head.length]??''))return true;
  }
  return false;
};

function changeReviewAttempt(item,{org,identity,events,state,repo,effects,target,ignoreService,ignoreQueue,capturedRun,capturedOriginal=false,ignoreQueues=[],references=[],ignoredReferences=[]}) {
  const reference=file=>{if(ignoredReferences.includes(file))return null;references.push(file);try{return read(file);}catch{return null;}};
  const resolution=reviewResolution({events,org,item:item.id,head:target.head}),archivedItems=new Set(resolution?.event.archived_review_items??[]);
  capturedRun??=target.source_group?.run;
  const disposed=file=>resolvedReference({events,state,repo,org,identity,item:item.id,run:capturedRun,target,file});
  // Missing/untyped/progressed originals must not make a granted disposition
  // disappear from validation just because the inventory no longer matches.
  for(const e of events)if(e.type==='review.reference-resolved'&&e.project===identity&&e.org===org&&e.item===item.id&&e.run===capturedRun&&sameCapturedTarget(e.target,target))disposed(e.reference);
  const runs=new Set(capturedRun?[capturedRun]:item.runs.filter(id=>(state.runs.get(id)?.report?.artifacts??[]).some(a=>typeof a==='string'&&a.includes(target.head)))),group=producerGroupKey(item.id,capturedRun,target.reportHash),covered=new Set(capturedReviewCommits(target));
  const sourceRun=state.runs.get(capturedRun),worker=effectiveWorkerIdentity(sourceRun,state),nativeHeads=new Set(events.filter(e=>e.type==='change.landed'&&e.project===identity&&e.item===item.id&&e.run===capturedRun&&e.landed_at&&e.producer?.agent&&e.producer?.session&&!worker.identity_conflict&&e.producer.agent===worker.agent&&e.producer.pane===worker.pane&&e.producer.terminal===worker.terminal_id&&e.producer.session===worker.agent_session_id&&e.producer.ownership_generation===sourceRun?.owner_generation).map(e=>e.head)),ownerEvidence=path.join(org,'evidence',item.id,capturedRun??'UNKNOWN'),proofCache=new Map();
  const runtimeAttempt=v=>['stage','review','reviewer','verdict','qualification','native_launch_attempted','worker','launchProcess','deliveryRange','review_item','review_run'].some(k=>Object.hasOwn(v,k));
  const producerProof=(file,seen=new Set())=>{
    if(!file.startsWith(ownerEvidence+path.sep)||seen.has(file))return false;if(proofCache.has(file))return proofCache.get(file);seen.add(file);
    const v=reference(file);if(!v||runtimeAttempt(v))return false;
    if(producerReviewObservation(v,{events,state,item:item.id,run:capturedRun,identity,nativeHeads})){proofCache.set(file,true);return true;}
    if(v.run!==capturedRun)return false;
    // A copied foreign reviewer outcome is an observation, not an attempt for
    // its observer's build. Bind every copied row to the actual existing record.
    const t=v.target,q=state.items.get(t?.item),judgment=events.find(e=>e.seq===t?.review?.seq&&e.type==='change.reviewed'&&e.review_run===t?.run&&e.review_item===t?.item&&e.item===t?.review?.item&&e.head===t?.review?.head);
    if(judgment&&q?.meta.review_source_item&&!(q.meta.review_source_item===item.id&&q.meta.review_source_run===capturedRun)&&Array.isArray(v.native_effects)&&v.native_effects.length&&v.native_effects.every(row=>row.type==='closeout.effect'&&row.run===t.run&&row.identity===identity&&events.some(e=>e.seq===row.seq&&canonical(e)===canonical(row)))&&v.source_binding&&events.some(e=>e.seq===v.source_binding.seq&&canonical(e)===canonical(v.source_binding))){proofCache.set(file,true);return true;}
    const gates=[v.gate,v.body_verdict?.gate,...(Array.isArray(v.checks)?v.checks.map(c=>c.file??c.gate):Object.entries(v.checks??{}).filter(([k])=>/^gate\d+$/.test(k)).map(([,x])=>x))].filter(x=>typeof x==='string'),declared=[v.head,v.source,v.correction,v.body_verdict?.source].flat().filter(commit);
    if(gates.length&&(v.focused&&typeof v.focused==='object'||v.checks&&typeof v.checks==='object'||v.body_verdict&&typeof v.body_verdict==='object')&&(!v.native_effects||typeof v.native_effects==='string')&&gates.every(file=>{
      if(!file.startsWith(ownerEvidence+path.sep))return false;const gate=read(file);
      // Receipt identity, not green readiness: red and explicitly unrun source
      // validation are both producer evidence, never independent verdicts.
      return gate?.schema==='lane-validation/v1'&&/^[a-f0-9]{64}$/.test(gate.key??'')&&nativeHeads.has(gate.head)&&declared.includes(gate.head)&&gate.branch===`lane/${sourceRun.meta.lane}`&&typeof gate.executed==='boolean'&&typeof gate.node_version==='string';
    })){proofCache.set(file,true);return true;}
    const diagnostic=typeof v.scope==='string'&&v.scope.startsWith('read-only ')&&t?.evidence_kind==='native-landings/v1'&&nativeHeads.has(t.head)&&Array.isArray(v.scoped_evidence_reads)&&v.scoped_evidence_reads.length&&v.scoped_evidence_reads.every(f=>typeof f==='string'&&producerProof(f,new Set(seen)));
    proofCache.set(file,Boolean(diagnostic));return Boolean(diagnostic);
  };
  const producerEvidence=file=>{
    for(const q of state.items.values())if(q.meta.review_target?.evidence===file&&(sameProducerQueue(q,item.id,capturedRun)||q.meta.review_source_selector===item.id)){
      if(file===target.evidence||disjointCapture({repo,target,peer:q.meta.review_target})){captureEvidence(q.meta.review_target);return true;}
    }
    if(additionalTarget(target)&&file===target.evidence){captureEvidence(target);return true;}
    if(target.evidence_kind!=='native-landings/v1'||file!==target.evidence)return producerProof(file);
    const value=read(file);if(value?.schema!=='native-landings/v1'||JSON.stringify(value)!==JSON.stringify(target.landed_evidence)||sha(fs.readFileSync(file))!==target.reportHash)throw Error('bound native producer evidence changed; retain it');
    return true;
  };
  const tokens=new Set([item.id,...item.runs]);
  const heads=value=>{
    const out=new Set();const visit=(v,key='')=>{if(typeof v==='string'&&/head|commit|reviewed/i.test(key)&&!/^base$/i.test(key)&&commit(v))out.add(v);else if(Array.isArray(v))for(const x of v)visit(x,key);else if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))visit(x,k);};visit(value);return out;
  };
  const matches=(value,runHint)=>{
    if(!value)return false;const named=heads(value);
    const sameGroup=contains(value,new Set(runs))||value.reportHash===target.reportHash||value.review_target?.reportHash===target.reportHash;
    if(named.size)return item.id.startsWith('canonical:')?[...named].some(h=>covered.has(h)):named.has(target.head)&&(contains(value,tokens)||item.runs.includes(runHint))||sameGroup&&[...named].some(h=>covered.has(h));
    const run=value.run??value.source_run??runHint;
    return runs.has(run);
  };
  for(const q of state.items.values())if(q.id!==ignoreQueue&&!ignoreQueues.includes(q.id)&&!archivedItems.has(q.id)&&roleIs(q,'REV')&&(q.meta.review_source_selector===item.id||q.meta.review_source_item===item.id&&(q.meta.review_target?.head===target.head||capturedRun&&sameProducerQueue(q,item.id,capturedRun)))){
    if(disjointCapture({repo,target,peer:q.meta.review_target}))continue;
    return 'existing whole producer/same-change record review';
  }
  for(const id of runs)for(const artifact of state.runs.get(id)?.report?.artifacts??[]){
    // Read producer-named review locators, including outside-org manual receipts.
    // Only readable, typed, subject-bound content is attempt evidence; missing,
    // unreadable or untyped locators do not establish an attempt.
    if(typeof artifact==='string'&&/review|settle/i.test(artifact)&&/\.json(?:$|[ #])/.test(artifact)&&path.isAbsolute(artifact.split(/[ #]/)[0])){
      const file=artifact.split(/[ #]/)[0],value=reference(file);
      if(typedReviewAttempt(value)&&matches(value,id)&&!producerEvidence(file)&&!archivedReviewFile(resolution,file)&&!disposed(file))return 'same-change source-owner typed review reference UNKNOWN';
    }
  }
  for(const e of events){
    if(e.type==='change.reviewed'&&e.item===item.id&&(covered.has(e.head)||!capturedOriginal&&group&&(e.review_group_key??queueProducerGroup(state.items.get(e.review_item)))===group))return 'recorded same-change/producer-group verdict';
    if(e.type==='review.verdict'&&item.runs.includes(e.run)&&matches(e,e.run))return 'recorded same-change verdict';
    if(tokens.has(e.id)&&explicitReviewHold(e)){
      // The validated archival authorization is not another independent
      // attempt. Every other explicit hold, including later holds, still counts.
      if(resolution?.authorized_decision_seqs?.includes(e.seq))continue;
      const named=/[a-f0-9]{40}/.test(e.text);
      const atNote=item.runs.filter(id=>(state.runs.get(id)?.started.seq??Infinity)<e.seq).at(-1);
      if([...covered].some(h=>namesCommit(e.text,h))||!named&&(runs.has(e.id)||(e.text.match(/\bR-\d+\b/g)??[]).some(id=>runs.has(id))||e.id===item.id&&runs.has(atNote)&&(state.runs.get(atNote)?.report?.seq??Infinity)<e.seq))return 'recorded same-change independent review hold';
    }
  }
  const pending=(actions,file)=>Object.entries(actions??{}).some(([key,value])=>{
    if(resolution?.effects.some(e=>e.file===file&&e.key===key&&e.sha256===reviewDigest(JSON.stringify(value))))return false;
    if(ignoreService&&ignoreService.file===file&&ignoreService.key===key&&value.review_operation===ignoreService.operation&&JSON.stringify(value.review_target)===JSON.stringify(ignoreService.target)&&
      (['started','held'].includes(value.state)&&!ignoreQueue||value.state==='complete'&&value.result?.review_item===ignoreQueue))return false;
    if(!/review/i.test(key))return false;
    return key===`review:${item.id}:${target.head}`||key.includes(item.id)&&heads(value).has(target.head)||matches(value,key.match(/R-\d+/)?.[0]);
  });
  if(pending(effects?.actions,ignoreService?.file))return 'existing same-change service intent/result';
  for(const dir of ['retirement/occupants','retirement/reviews','settle'])for(const entry of entries(path.join(org,dir))){
    if(!entry.name.endsWith('.json'))continue;const file=path.join(org,dir,entry.name);if(archivedReviewFile(resolution,file))continue;const hint=entry.name.match(/R-\d+/)?.[0];let value;
    value=reference(path.join(org,dir,entry.name));
    if(value?.kind==='watcher')continue;
    if(typedReviewAttempt(value)&&matches(value,hint))return `existing same-change ${dir} attempt/UNKNOWN`;
  }
  for(const entry of entries(path.join(org,'line-service')))if(entry.isDirectory()){
    // This inventory scan retains readable same-change intents only. Strict
    // current-journal loading belongs to service.pass() and queued admission.
    const file=path.join(org,'line-service',entry.name,'effects.json');let saved;try{saved=readServiceJournal(file);}catch{continue;}
    if(file!==ignoreService?.file)references.push(file);
    if(pending(saved?.actions,file))return 'existing same-change service intent/result';
  }
  for(const id of item.runs){
    const run=state.runs.get(id);if(!run)continue;
    const evidence=path.join(org,'evidence',item.id,id);
    // Receipt attribution is scoped to its source run/head. An unrelated old
    // directory or opaque filename is never a project-wide review hold.
    if(runs.has(id))for(const entry of entries(evidence))if(/review|settle/i.test(entry.name)&&entry.name.endsWith('.json')){
      const file=path.join(evidence,entry.name),value=reference(file);if(!typedReviewAttempt(value)||producerEvidence(file)||archivedReviewFile(resolution,file))continue;if(matches(value,id)&&!disposed(file))return 'same-change source-owner review receipt/UNKNOWN';
    }
    for(const root of new Set([repo,run.workspace].filter(Boolean))){
      if(!fs.existsSync(root))continue;
      for(const relative of ['.lane/reviews','.lane/public-reviews','docs/reviews'])if(run.meta?.lane){
        const dir=path.join(root,relative,run.meta.lane);
        if(entries(dir).some(e=>e.name.startsWith(target.head.slice(0,7))))return 'existing same-change direct review output';
      }
      for(const entry of entries(root))if(entry.isDirectory()&&entry.name.startsWith('.lane-review-')){
        for(const file of ['request.json','review.json','manifest.json']){const value=reference(path.join(root,entry.name,file));if(typedReviewAttempt(value)&&matches(value))return 'existing same-change private native attempt';}
      }
    }
  }
  return null;
}

export function reviewAttempt(item, { org, identity, events, state, repo, effects, cache = new Map(), ignoreService, ignoreQueue, capturedRun,target,capturedOriginal,ignoreQueues,references,ignoredReferences }) {
  if(target)return changeReviewAttempt(item,{org,identity,events,state,repo,effects,target,ignoreService,ignoreQueue,capturedRun,capturedOriginal,ignoreQueues,references,ignoredReferences});
  const cached = (kind, file, fn) => { const key = `${kind}:${file}`; if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
  const readFile = file => cached('file', file, () => reference(file));
  const list = file => cached('directory', file, () => entries(file));
  const runs = new Set(item.runs), tokens = new Set([item.id, ...runs]);
  if (state && [...state.items.values()].some(candidate => candidate.id !== ignoreQueue && roleIs(candidate, 'REV') &&
      (candidate.parent === item.id || candidate.meta.review_source_item === item.id))) return 'existing item-wide record review';
  if (events.some(e => tokens.has(e.id) && explicitReviewHold(e))) return 'recorded independent review attempt/hold';
  if (events.some(e => e.type === 'review.verdict' && runs.has(e.run))) return 'recorded verdict';
  const pending = (actions, file) => Object.entries(actions ?? {}).some(([key, value]) => {
    if (ignoreService && ignoreService.file === file && ignoreService.key === key && value.review_operation === ignoreService.operation && JSON.stringify(value.review_target) === JSON.stringify(ignoreService.target) &&
        (value.state === 'started' && !ignoreQueue || value.state === 'complete' && value.result?.review_item === ignoreQueue)) return false;
    return key === `review:${item.id}` ||
    (/review/i.test(key) && contains(value, tokens)) || (value?.result?.result === 'review_pending' && contains(value, tokens));
  });
  if (pending(effects?.actions, ignoreService?.file)) return 'existing service review intent/result';
  for (const id of runs) if (typedReviewAttempt(readFile(path.join(org, 'settle', `${id}.json`))) || typedReviewAttempt(readFile(path.join(org, 'settle', `${id}.review-launch.json`)))) return `existing settle ${id}`;
  for (const [relative, reason] of [['retirement/occupants', 'existing native reviewer'], ['retirement/reviews', 'existing review receipt'], ['settle', 'existing consumer review receipt']]) {
    for (const entry of list(path.join(org, relative))) {
      if (!entry.name.endsWith('.json')) continue;
      const value = readFile(path.join(org, relative, entry.name));
      if (relative === 'retirement/occupants' && value?.kind === 'watcher') continue;
      if (typedReviewAttempt(value)&&contains(value, tokens)) return reason;
      // Unknown native/review records cannot prove absence. Auxiliary routing
      // snapshots and positively foreign run receipts are not review attempts.
      if (typedReviewAttempt(value) && !value.run && !value.item) {
        const named = /^(R-\d+)(?:\.|$)/.exec(entry.name)?.[1];
        if (named && runs.has(named)) return reason;
        if (!named || !state?.runs.has(named)) throw Error(`unmapped review inventory: ${relative}/${entry.name}`);
      }
    }
  }
  for (const entry of list(path.join(org, 'line-service'))) if (entry.isDirectory()) {
    const file = path.join(org, 'line-service', entry.name, 'effects.json'), saved = cached('service-journal', file, () => {try{return readServiceJournal(file);}catch{return null;}});
    if (pending(saved?.actions, file)) return 'existing service review intent/result';
  }
  const scanEvidence = directory => {
    for (const entry of list(directory)) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { const found = scanEvidence(file); if (found) return found; }
      else if (/review|settle/i.test(entry.name) && typedReviewAttempt(readFile(file))) return `source-owner/direct typed review evidence retained: ${file}`;
      else if (entry.name.endsWith('.json')) {
        const value = readFile(file);
        if (typedReviewAttempt(value)&&contains(value,tokens)) return `source-owner review receipt/uncertainty retained: ${file}`;
      }
    }
    return null;
  };
  const ownerEvidence = scanEvidence(path.join(org, 'evidence', item.id));
  if (ownerEvidence) return ownerEvidence;
  if (!state || !repo) return null; // Compatibility callers ask only for known attempts.
  for (const id of runs) {
    const run = state.runs.get(id);
    if (!run?.owner || run.owner.legacy || run.owner.controller !== 'brain' || run.owner.release?.id !== 'source') throw Error(`legacy/manual review absence is UNKNOWN for ${id}`);
    if (Object.keys(run.report?.extra ?? {}).some(key => /review|verdict|qualification/i.test(key))) return `report retains review/qualification uncertainty for ${id}`;
    const artifacts = run.report?.artifacts ?? [];
    for (const artifact of artifacts) if (typeof artifact === 'string' && path.isAbsolute(artifact) && /review|settle/i.test(path.basename(artifact))) {
      if(typedReviewAttempt(readFile(artifact)))return `bound source-owner typed review reference retained: ${artifact}`;
    } else if (typeof artifact === 'string' && path.isAbsolute(artifact) && artifact.endsWith('.json') && !path.resolve(artifact).startsWith(path.resolve(org) + path.sep)) {
      if(typedReviewAttempt(readFile(artifact)))return `outside-record typed review reference retained: ${artifact}`;
    }
    const roots = new Set([repo, run.workspace].filter(Boolean));
    for (const root of roots) {
      if (!fs.existsSync(root)) {
        if (id === capturedRun && root === run.workspace && root !== repo) continue;
        throw Error(`review consumer inventory unavailable: ${root}`);
      }
      for (const entry of list(root)) if (entry.name.startsWith('.lane-review-')) throw Error(`unmapped native/direct review delivery retained: ${path.join(root, entry.name)}`);
      const topic = run.meta?.lane;
      if (topic) for (const relative of ['.lane/reviews', '.lane/public-reviews', 'docs/reviews']) {
        if (list(path.join(root, relative, topic)).length) return 'existing direct/native review output';
      }
    }
  }
  return null;
}

// Prove the actual owner-bound helper and any forwarded record consumer have
// this implementation. A source pathname/selector is not a capability proof.
export function selectedReviewConsumer({ run, repo, resolve = () => {
  if(bundleRelease(codeRoot).commit&&probationRuntime(repo,{root:codeRoot,home:path.dirname(path.dirname(codeRoot)),allowEnded:true}))return codeRoot;
  const pin = projectPin(repo);
  return pin?.home_binding || (pin?.release && gitProject(codeRoot).identity !== pin.project.identity) ? selectRelease(repo).root : codeRoot;
} }) {
  const ownerRoot = run.owner?.release?.root;
  if (!ownerRoot || run.owner.legacy || fs.realpathSync(ownerRoot) !== codeRoot) throw Error('selected saved review helper capability is UNKNOWN/old; no source or owner override');
  const recordRoot = fs.realpathSync(resolve());
  for (const root of new Set([ownerRoot, recordRoot])) for (let i = 0; i < capabilityFiles.length; i++) {
    let actual;
    try { actual = sha(fs.readFileSync(path.join(root, capabilityFiles[i]))); } catch { throw Error('actual selected/pinned consumer cannot certify immutable review/dedup capability'); }
    if (actual !== capability[i]) throw Error('actual selected/pinned consumer has old/unknown immutable review/dedup capability');
  }
  return { ownerRoot, recordRoot, capability: [...capability] };
}

// Use the existing delivered-change artifact parser; live HEAD never chooses a
// target. The dispatch receipt supplies only a baseline/negative admission check.
export function bindReviewTarget({ item, run, events, repo, org, identity }) {
  const reportFile = path.resolve(org, run.report?.file ?? '');
  if (!run.report?.sha256 || !reportFile.startsWith(path.resolve(org) + path.sep) || sha(fs.readFileSync(reportFile)) !== run.report.sha256) throw Error('immutable report evidence is UNKNOWN or changed');
  const start = events.find(e => e.type === 'run.started' && e.id === run.id), journal = start?.meta?.dispatch_journal;
  if (!journal || !path.resolve(journal).startsWith(path.join(path.resolve(org), 'dispatch') + path.sep)) throw Error('native dispatch baseline is UNKNOWN');
  const dispatch = read(journal);
  if (!dispatch || dispatch.run !== run.id || dispatch.item !== item.id || dispatch.org !== org || dispatch.common !== identity ||
      dispatch.token !== start.meta.dispatch_attempt || dispatch.workspace !== run.workspace || dispatch.stage !== 'complete') throw Error('native dispatch baseline binding is UNKNOWN');
  let base = commit(dispatch.base) ? dispatch.base : null;
  if (!base && dispatch.sourceSelection?.kind === 'explicit-brain-root' && gitProject(dispatch.sourceSelection.root).identity === identity) base = dispatch.sourceSelection.head;
  if (!commit(base)) throw Error('immutable target-project baseline is UNKNOWN; dispatcher/admission head is not a review target');
  const git = args => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim();
  git(['cat-file', '-e', `${base}^{commit}`]);
  const claims = reviewScope({ workspace: repo, base, head: base, artifacts: run.report.artifacts ?? [] });
  if (claims.unresolved.length || !claims.claims.length) throw Error('committed delivered-source/evidence target is UNKNOWN; report/admission/live HEAD is insufficient');
  const tips = claims.claims.filter(head => claims.claims.every(other => {
    try { git(['merge-base', '--is-ancestor', other, head]); return true; } catch { return false; }
  }));
  if (tips.length !== 1) throw Error('delivered-source target is ambiguous');
  const head = tips[0];
  if (head === base) throw Error('admission HEAD has no positively bound committed change; preparation is not an owed code review');
  const scope = reviewScope({ workspace: repo, base, head, artifacts: run.report.artifacts ?? [] });
  if (scope.deferred || !scope.commits.length || scope.base !== base) throw Error('delivered-source target is outside its immutable dispatch baseline');
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', base, head]);
  if (!diff) throw Error('captured target has no committed changed source');
  return { head, base, scope, reportHash: run.report.sha256, evidence: reportFile, diff_sha256: sha(diff), dispatch: journal };
}
