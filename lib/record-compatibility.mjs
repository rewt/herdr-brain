// Admission for a stopped release handoff, including legacy protocol-1 bundles.
// Read the target's actual fold, not a capability claimed by newer tooling.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from './files.mjs';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
function foldTypes(root) {
  const source = readPlainFile(path.join(root, 'lib/state.mjs'));
  // The supported legacy fold has one literal event switch. An unrecognized
  // implementation is uncertainty; do not infer compatibility from its version.
  const body = /function apply\(s, e\)\s*\{[\s\S]*?switch \(e\.type\)\s*\{([\s\S]*?)\n\s*default:/.exec(source)?.[1];
  if (!body) throw Error(`record-incompatible: unknown fold contract at ${root}`);
  return new Set([...body.matchAll(/^\s*case '([^']+)':/gm)].map(match => match[1]));
}

export function requireRecordCompatibility(root, events) {
  const reference = foldTypes(sourceRoot), target = foldTypes(root);
  const required = new Set(), missing = new Set();
  let first,through=0;
  for(const event of events) {
    through=event.seq??through;
    // decision.* also contains receipts consumed by the decision service, not
    // the aggregate fold. Only its actual fold cases belong to this contract.
    if(!reference.has(event.type)&&!/^(?:item|run|link|lesson|release|category)\./.test(event.type))continue;
    required.add(event.type);
    if(!target.has(event.type)){missing.add(event.type);first??=event.seq??'unknown';}
  }
  if(missing.size)throw Error(`record-incompatible: ${root} cannot fold ${[...missing].join(', ')} (first sequence ${first}); retain the stopped installation and captured work`);
  return { root, required_types: [...required].sort(), through };
}

// A waiting command router must not retain another full folded record while
// its selected child runs. Stream only event types, with bounded chunk memory.
export function requireRecordFileCompatibility(root,file) {
  function* events() {
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      if(!fs.fstatSync(fd).isFile())throw Error('record compatibility needs a regular event log');
      const chunk=Buffer.alloc(64*1024),decoder=new StringDecoder('utf8');
      let pending='',size;
      while((size=fs.readSync(fd,chunk,0,chunk.length,null))>0) {
        pending+=decoder.write(chunk.subarray(0,size));
        let end;
        while((end=pending.indexOf('\n'))!==-1) {
          const line=pending.slice(0,end);pending=pending.slice(end+1);
          if(line.trim())yield JSON.parse(line);
        }
      }
      pending+=decoder.end();
      if(pending.trim())throw Error('incomplete record prevents release admission');
    } finally {fs.closeSync(fd);}
  }
  return requireRecordCompatibility(root,events());
}
