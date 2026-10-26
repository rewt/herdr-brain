// An explicit owner control: existing pending transport notices become one
// record message. Original transport bytes and work obligations remain intact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bundleRelease } from '../lib/releases.mjs';
import { gitProject } from '../lib/project.mjs';
import { loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
import { nativeSender, makeEnvelope, prepareEnvelope } from '../messages/operator-inbox.mjs';
import { canonical } from '../messages/schema.mjs';
import { invokeHerdr } from './herdr-edge.mjs';
import { noticeLock } from './notice-lock.mjs';
import { inboxPath, inboxTransaction } from './prompt-supervisor.mjs';

const source = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const capabilities=['supervisor/line-notice-aggregate.mjs','supervisor/prompt-supervisor.mjs','supervisor/notice-lock.mjs','lib/store.mjs','messages/operator-inbox.mjs'];
const loadedCapabilities=capabilities.map(f=>sha(fs.readFileSync(path.join(source,f))));
const sourceHead=()=>execFileSync('git',['--no-optional-locks','-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const targetNotice = e => e.to === 'brain-chat' && /^\[line-service\](?:\s|$)/.test(e.message);
const tuple = a => ({ name:a.name, pane:a.pane_id, workspace:a.workspace_id, terminal:a.terminal_id, session:a.agent_session?.value??null, cwd:fs.realpathSync(a.cwd) });
const same = (a,b) => canonical(a) === canonical(b);
function plain(file) {
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if (!stat) return null;
  if (!stat.isFile() || fs.realpathSync(file)!==path.resolve(file)) throw Error(`aggregate receipt redirected: ${file}`);
  return fs.readFileSync(file,'utf8');
}
function create(file, value) {
  const fd=fs.openSync(file,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
}

export function handlePendingLineNotices({org, inbox, id, herdr='herdr', cwd=process.cwd(), env=process.env, call=invokeHerdr, fault=()=>{}}={}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:-]{0,100}$/.test(id??'')) throw Error('pending-line handling requires one stable --id');
  if (!org) throw Error('pending-line handling requires explicit --org');
  org=fs.realpathSync(org);
  if (!env.HERDR_BRAIN_ROOT || fs.realpathSync(env.HERDR_BRAIN_ROOT)!==source || bundleRelease().commit) throw Error('pending-line control requires the matching development source selector');
  const executionHead=sourceHead();
  const guardSource=()=>{if(sourceHead()!==executionHead||capabilities.some((f,i)=>sha(fs.readFileSync(path.join(source,f)))!==loadedCapabilities[i]))throw Error('actual control source changed before mutation');};
  const bind=()=>{
    const binding=nativeSender(org,{cwd,env,call});
    if (binding.project.checkout!==binding.project.canonical) throw Error('pending-line control requires own canonical project context');
    const a=JSON.parse(call(herdr,['agent','get','brain-chat'])).result?.agent;
    if (a?.name!=='brain-chat' || !a.pane_id || !a.workspace_id || !a.terminal_id || typeof a.cwd!=='string' ||
        fs.realpathSync(a.cwd)!==binding.project.canonical || gitProject(a.cwd).identity!==binding.project.identity) throw Error('actual Brain Chat recipient binding is missing/foreign');
    return {binding,caller:tuple(binding.native),recipient:tuple(a)};
  };
  const initial=bind(), file=path.resolve(inbox??inboxPath({org,cwd}));
  if (file!==path.resolve(inboxPath({org,cwd}))) throw Error('pending-line inbox differs from actual owning record');
  if (fs.realpathSync(path.dirname(file))!==path.dirname(file) || plain(file)===null) throw Error('pending-line inbox is missing/redirected');
  const directory=path.join(org,'supervisor','record-only'); fs.mkdirSync(directory,{recursive:true});
  if (fs.realpathSync(directory)!==directory) throw Error('aggregate directory redirected');
  const manifestFile=path.join(directory,`${id}.json`), messageId=`line-service-aggregate:${id}`;
  // Never kill(0), resume, recover or replace an existing owner. A busy old
  // drain can already hold a final-input intent; only its natural release helps.
  const release=noticeLock(`${file}.drain.lock`,{recover:false});
  try { return inboxTransaction(file,(entries,append)=>{
    let manifest=plain(manifestFile); manifest=manifest===null?null:JSON.parse(manifest);
    const current=bind();
    if (!same(current.caller,initial.caller)||!same(current.recipient,initial.recipient)) throw Error('native caller/recipient changed before aggregate intent');
    const project={repo:current.binding.project.canonical,identity:current.binding.project.identity,org};
    const raw=fs.readFileSync(file,'utf8'), originals=new Map(raw.trimEnd().split('\n').filter(Boolean).map(line=>[JSON.parse(line),line]).filter(([e])=>e.type==='notice').map(([e,line])=>[e.id,sha(line+'\n')]));
    if (!manifest) {
      const pending=entries.filter(e=>targetNotice(e)&&e.state==='pending'&&!(e.autopilot_owner&&!e.autopilot));
      if (!pending.length) {
        const retained=entries.filter(e=>targetNotice(e)&&(e.state==='uncertain'||e.autopilot_owner&&!e.autopilot)).map(e=>({id:e.id,state:e.state}));
        return {result:retained.length?'pending-line-inflight-held':'no-pending-line-notices',handled:0,retained_ambiguous:retained,delivered:false,model_consumed:false};
      }
      if (pending.length>10000) throw Error('pending-line bounded manifest exceeds 10000 notices; no entries handled');
      if (pending.some(e=>!e.project||!same(e.project,project))) throw Error('pending line notice project binding is UNKNOWN/foreign; no entries handled');
      manifest={id,kind:'pending-line-record-only',org,inbox:file,project,caller:current.caller,recipient:current.recipient,message_id:messageId,
        source:{root:source,head:executionHead,capabilities:loadedCapabilities},
        at:new Date().toISOString(),selected:pending.map(e=>({id:e.id,notice_sha256:originals.get(e.id)})),
        retained_ambiguous:entries.filter(e=>targetNotice(e)&&(e.state==='uncertain'||e.autopilot_owner&&!e.autopilot)).map(e=>({id:e.id,state:e.state})),
        sent_unchanged:entries.filter(e=>targetNotice(e)&&e.state==='sent').length,delivered:false,model_consumed:false,obligations:'retained'};
      guardSource(); create(manifestFile,manifest); fault('intent');
    }
    if (manifest.id!==id||manifest.org!==org||manifest.inbox!==file||manifest.message_id!==messageId||!same(manifest.project,project)||!same(manifest.caller,current.caller)||!same(manifest.recipient,current.recipient)) throw Error('saved aggregate source/native/project/recipient binding changed');
    if(manifest.source?.root!==source||!same(manifest.source.capabilities,loadedCapabilities))throw Error('saved aggregate control capability changed; retain original intent');
    const manifestHash=sha(plain(manifestFile)), selected=new Set(manifest.selected.map(e=>e.id));
    if (selected.size!==manifest.selected.length||selected.size>10000) throw Error('saved aggregate ID set ambiguous');
    for (const ref of manifest.selected) {
      const entry=entries.find(e=>e.id===ref.id);
      const handled=entry?.state==='handled'&&entry.autopilot?.aggregate===messageId&&entry.autopilot?.manifest_sha256===manifestHash;
      if (!entry||originals.get(ref.id)!==ref.notice_sha256||!targetNotice(entry)||!same(entry.project,project)||(!handled&&(entry.state!=='pending'||entry.autopilot_owner&&!entry.autopilot))) throw Error(`aggregate notice CAS changed: ${ref.id}; retained without replay`);
    }
    const pendingAfter=entries.filter(e=>targetNotice(e)&&e.state==='pending'&&!(e.autopilot_owner&&!e.autopilot)&&!selected.has(e.id)).map(e=>e.id);
    const loaded=loadEvents(org); if (loaded.tornTail) throw Error('incomplete record prevents aggregate');
    const wording={id:messageId,kind:'fyi',summary:'Older service notices are stored together.',happened:`${selected.size} queued status notices were grouped for reading. Their original history and outstanding work remain available.`,action:'No action is needed for this grouped backlog.',details:`${manifestFile}; SHA256 ${manifestHash}; native delivery and model consumption are not claimed.`};
    const saved=transact(org,events=>{
      guardSource();
      const fresh=bind(); if(!same(fresh.caller,manifest.caller)||!same(fresh.recipient,manifest.recipient)) throw Error('native binding changed at record mutation');
      const envelope=makeEnvelope(wording,fresh.binding,events);
      envelope.payload.transport_aggregate={manifest:manifestFile,sha256:manifestHash,count:selected.size,delivered:false,model_consumed:false,obligations:'retained'};
      return protectRecordMutation({org,state:fold(events),events,command:'messages',mutation:prepareEnvelope(envelope,fresh.binding,fold(events),events)});
    },{actor:current.binding.native.name,strictTail:true,lockOptions:{recover:false}});
    fault('record');
    const fresh=bind(); if(!same(fresh.caller,manifest.caller)||!same(fresh.recipient,manifest.recipient)) throw Error('native binding changed before pending handling');
    guardSource();
    let count=0;
    for (const ref of manifest.selected) {
      const entry=entries.find(e=>e.id===ref.id);
      if(entry.state==='handled') continue;
      append({type:'autopilot',id:ref.id,result:{disposition:'handled',aggregate:messageId,manifest:manifestFile,manifest_sha256:manifestHash,
        summary:'Explicitly superseded by one record-only aggregate; original obligations retained.',delivered:false,model_consumed:false}});
      count++; fault('handled',count);
    }
    return {result:'handled-record-only',aggregate:saved.result.eventId,manifest:manifestFile,manifest_sha256:manifestHash,selected:selected.size,handled:count,
      retained_ambiguous:manifest.retained_ambiguous,sent_unchanged:manifest.sent_unchanged,pending_after:pendingAfter,delivered:false,model_consumed:false};
  },{recover:false,waitMs:0}); } finally {release();}
}
