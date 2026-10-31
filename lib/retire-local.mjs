// External preflight seals. Verification reads metadata, never evidence payloads.
import fs from 'node:fs';
import path from 'node:path';

// Path identity used by every retirement scope decision: the realpath of the
// longest existing prefix plus the not-yet-existing suffix. Only ENOENT walks
// up; loops, permission and other resolution errors stay errors.
export const canonical = file => {
  if (!file) return file;
  let parent = path.resolve(file), suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(parent), ...suffix); }
    catch (e) { if (e.code !== 'ENOENT') throw e; const next = path.dirname(parent); if (next === parent) throw e;
      suffix.unshift(path.basename(parent)); parent = next; }
  }
};

// Housekeeping's append-only activity/state is not retirement authority. Seal
// its actual owner inventory instead, including directory/file identities, so
// new/replaced owners still invalidate the final removal CAS without hashing
// every unrelated heartbeat/log update. Never follow a redirected authority.
export function sealHousekeepingOwners(directory){
  const dirIdentity=file=>{const s=fs.lstatSync(file);if(!s.isDirectory()||s.isSymbolicLink())throw Error(`redirected housekeeping authority ${file}; keep`);return[s.dev,s.ino,s.birthtimeMs,s.mode];};
  const read=()=>{
    let root;try{root=dirIdentity(directory);}catch(e){if(e.code==='ENOENT')return[];throw e;}
    const rows=[];
    for(const name of fs.readdirSync(directory).sort()){
      const child=path.join(directory,name),s=fs.lstatSync(child);if(s.isSymbolicLink())throw Error(`redirected housekeeping authority ${child}; keep`);if(!s.isDirectory())continue;
      const lock=path.join(child,'lock');let lockIdentity;try{lockIdentity=dirIdentity(lock);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      const owner=path.join(lock,'owner.json'),ownerStamp=stamp(owner,false,new Set(),new Set());if(ownerStamp===null)throw Error(`housekeeping owner is unknown: ${lock}; keep`);
      if(!fs.lstatSync(owner).isFile())throw Error(`invalid housekeeping owner ${owner}; keep`);
      rows.push([name,root,dirIdentity(child),lockIdentity,ownerStamp]);
    }
    return rows;
  };
  const saved=JSON.stringify(read());return()=>{if(JSON.stringify(read())!==saved)throw Error(`housekeeping ownership changed: ${directory}; prepare again; lane kept`);};
}

function stamp(file, recursive, omit, inertLinkParents, root = true) {
  let s;
  try { s = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const identity = [s.dev, s.ino, s.birthtimeMs, s.mode, s.size, s.mtimeMs, s.ctimeMs];
  if (s.isSymbolicLink()) {
    // regularJsonFiles ignores these immediate directory entries. Retain their
    // identity and link text as inert inventory, never read their destinations.
    if (!root && inertLinkParents.has(path.dirname(file))) return [identity, fs.readlinkSync(file)];
    throw Error(`redirected removal input ${file}; keep`);
  }
  if (recursive && s.isDirectory()) return [identity, fs.readdirSync(file).sort().filter(n => !omit.has(n))
    .map(n => [n, stamp(path.join(file, n), true, omit, inertLinkParents, false)])];
  return identity;
}

// Directory metadata detects additions/removals, file ctime detects edits even
// with restored mtime. Authority redirects remain uncertainty. Only ignored
// immediate entries in explicitly named receipt directories can be inert links;
// root inputs and redirected receipt directories always refuse. Evidence links
// are preserved by the evidence verifier, with their lstat identities.
export function sealRemovalInputs(files, { evidence = false, inertLinkParents = [] } = {}) {
  const inert = new Set(inertLinkParents.map(file => path.resolve(file)));
  const read = file => {
    if (!evidence) return stamp(file, true, new Set(), inert);
    const walk = f => {
      const s = fs.lstatSync(f);
      const identity = [s.dev, s.ino, s.birthtimeMs, s.mode, s.size, s.mtimeMs, s.ctimeMs];
      return s.isDirectory() ? [identity, fs.readdirSync(f).sort().filter(n => f !== file || n !== '.git')
        .map(n => [n, walk(path.join(f, n))])] : identity;
    };
    return walk(file);
  };
  const inputs = [...new Set(files.filter(Boolean))].map(file => [file, JSON.stringify(read(file))]);
  return () => {
    for (const [file, saved] of inputs) if (JSON.stringify(read(file)) !== saved)
      throw Error(`removal preflight input changed: ${file}; prepare and observe again; lane kept`);
  };
}

// Semantic target inventory, re-read under the removal lock. Directory mtime
// and unrelated callback/receipt bytes are not authority over this allocation.
// Matching additions, edits, disappearance and every redirect remain a CAS.
// Scope uses the reader's canonical path identity; receipt paths are resolved
// on every read, so aliases and alias redirects classify as the reader would. Only an
// absolute canonical common elsewhere proves a row foreign; a relative location
// is ambiguous and stays sealed; unresolvable paths refuse. The target paths
// are resolved once; production callers pass canonical targets.
// Native receipt schemas store a Herdr workspace ID, not a path, in workspace;
// it matches the target's workspace IDs. Completeness follows each reader.
const nativeReceiptFields={
  'retirement-occupant/v1':['common','cwd','workspace','tab','pane'],
  'retirement-exit/v1':['common','cwd','workspace','tab','pane','run'],
  'retirement-review/v1':['common','run','pane','terminal','session','workspace','cwd','agent'],
};
export const SCOPED_REMOVAL_AUTHORITY_CHANGED='target removal authority changed; prepare and observe again; lane kept';
export function sealScopedRemovalInputs(directories,context,{inertLinkParents=[],referenceDirectories=[],identityDirectories=[]}={}){
  const inert=new Set(inertLinkParents),references=new Set(referenceDirectories);
  // Discovery may reach the record through a supported ancestor alias. Bind
  // its destination once, then re-resolve it on every CAS read. The authority
  // directory itself must still be a real directory, never a redirect.
  const roots=directories.filter(Boolean).map(directory=>({directory,resolved:canonical(directory)}));
  const containers=identityDirectories.map(directory=>({directory,resolved:canonical(directory),missing:!fs.lstatSync(directory,{throwIfNoEntry:false})}));
  const inside=(a,b)=>typeof a==='string'&&typeof b==='string'&&(a===b||a.startsWith(b+path.sep));
  const runs=new Set(context.runs??[]),items=new Set(context.items??[]),panes=new Set(context.panes??[]),tabs=new Set(context.tabs??[]),terminals=new Set(context.terminals??[]),
    workspaces=new Set(context.workspaces??[]),sessions=new Set((context.sessions??[]).filter(Boolean));
  const common=canonical(context.common),cwd=canonical(context.cwd);
  const belongs=row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw Error('invalid scoped removal authority');
    if(typeof row.common==='string'&&path.isAbsolute(row.common)&&canonical(row.common)!==common)return false;
    if(row.schema==='herdr-reference/v1'&&(['owner','kind','job','item','created_at','expires_at'].some(k=>typeof row[k]!=='string'||!row[k])||!['pending','running'].includes(row.state)))return true;
    // A present non-string schema is unknown authority: keep it sealed, never crash.
    if(row.schema!=null&&typeof row.schema!=='string')return true;
    const native=row.schema&&Object.hasOwn(nativeReceiptFields,row.schema)?nativeReceiptFields[row.schema]:undefined;
    if(native?native.some(k=>typeof row[k]!=='string'||!row[k]):row.schema?.startsWith('retirement-')&&(!row.common||!row.run||!row.cwd||!row.pane||!row.workspace))return true;
    const named=[row.cwd,native?undefined:row.workspace,row.worktree].filter(v=>typeof v==='string'&&v);
    if(named.some(v=>!path.isAbsolute(v)))return true;
    const locations=named.map(canonical);
    const scoped=row.run||row.item||row.pane||row.pane_id||row.tab||row.tab_id||row.terminal||row.terminal_id||locations.length||row.lane||row.head;
    return !scoped||row.global===true||runs.has(row.run)||items.has(row.item)||locations.some(p=>inside(p,cwd)||inside(cwd,p))||
      panes.has(row.pane??row.pane_id)||tabs.has(row.tab??row.tab_id)||terminals.has(row.terminal??row.terminal_id)||
      native&&(workspaces.has(row.workspace)||sessions.has(row.agent_session_id??row.session))||
      row.lane&&row.lane===context.lane||row.head&&row.head===context.head||typeof row.label==='string'&&[context.cwd,cwd].some(p=>p&&row.label.includes(p));
  };
  const identity=s=>[s.dev,s.ino,s.birthtimeMs,s.mode];
  const read=()=>[containers.map(({directory,resolved,missing})=>{
    const root=fs.lstatSync(directory,{throwIfNoEntry:false});
    if(canonical(directory)!==resolved||root&&(!root.isDirectory()||root.isSymbolicLink()))throw Error(`redirected scoped removal input ${directory}`);
    // An absent parent may be created for a wake hint. Every authoritative
    // child inventory has its own absence fence; any redirect still refuses.
    // A parent present at preparation retains its exact directory identity.
    return[directory,root&&!missing?identity(root):null];
  }),roots.map(({directory,resolved})=>{
    const root=fs.lstatSync(directory,{throwIfNoEntry:false});
    if(canonical(directory)!==resolved)throw Error(`redirected scoped removal input ${directory}`);
    if(!root)return[directory,null,[]];
    if(!root.isDirectory()||root.isSymbolicLink())throw Error(`redirected scoped removal input ${directory}`);
    const selected=[];
    const walk=dir=>{
      for(const name of fs.readdirSync(dir).sort()){
        // Declared references are a flat filename-selected authority: selected
        // nonregular entries refuse. Occupant/exit readers select only regular
        // immediate JSON files; ignored links retain their inert CAS inventory.
        if(references.has(dir)&&(name.startsWith('.')||!name.endsWith('.json')))continue;
        const file=path.join(dir,name),s=fs.lstatSync(file);
        if(references.has(dir)&&!s.isFile())throw Error(`reference is not a regular JSON file: ${file}`);
        if(s.isSymbolicLink()){
          if(inert.has(path.dirname(file))){selected.push([file,'inert',stamp(file,false,new Set(),inert,false)]);continue;}
          throw Error(`redirected scoped removal input ${file}`);
        }
        if(inert.has(dir)&&(name.startsWith('.')||!s.isFile()||!name.endsWith('.json')))continue;
        if(s.isDirectory()){walk(file);continue;}
        if(!s.isFile()||!name.endsWith('.json'))continue;
        const row=JSON.parse(fs.readFileSync(file,'utf8'));
        if(belongs(row))selected.push([file,stamp(file,false,new Set(),new Set())]);
      }
    };walk(directory);
    return[directory,identity(root),selected];
  })];
  const saved=JSON.stringify(read());
  return()=>{if(JSON.stringify(read())!==saved)throw Error(SCOPED_REMOVAL_AUTHORITY_CHANGED);};
}
