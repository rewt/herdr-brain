// External preflight seals. Verification reads metadata, never evidence payloads.
import fs from 'node:fs';
import path from 'node:path';

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
