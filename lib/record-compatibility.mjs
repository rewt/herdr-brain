// Admission for a stopped release handoff, including legacy protocol-1 bundles.
// Read the target's actual fold, not a capability claimed by newer tooling.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from './files.mjs';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { applyObligationEvent } from './obligations.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
function foldContract(root) {
  const source = readPlainFile(path.join(root, 'lib/state.mjs'));
  // Recognize the legacy switch and the current post-switch delegate. Unknown
  // tails are uncertainty, including an unrecognized additional fold helper.
  const apply = /^function apply\(s, e\)\s*\{\n([\s\S]*?)^\}/m.exec(source)?.[1];
  const parts = apply && /^  switch \(e\.type\)\s*\{([\s\S]*?)^    default:[\s\S]*?^      break;\n  \}([\s\S]*)$/m.exec(apply);
  const tail = parts?.[2].trim();
  const prologue = '  s.lastAt = e.at;\n  const item = s.items.get(e.id ?? e.item);\n';
  if (!parts || apply.slice(0, parts.index) !== prologue || tail !== '' && tail !== 'applyObligationEvent(s, e);')
    throw Error(`record-incompatible: unknown fold contract at ${root}`);
  let obligations = null;
  if (tail) {
    if (!/^import \{ applyObligationEvent \} from '\.\/obligations\.mjs';$/m.test(source) ||
        !/export function fold\(events\)\s*\{\n\s*const s = \{[^;]*\bobligations: new Map\(\)/.test(source))
      throw Error(`record-incompatible: unknown obligation fold contract at ${root}`);
    try { obligations = readPlainFile(path.join(root, 'lib/obligations.mjs')); }
    catch (cause) { throw Error(`record-incompatible: unreadable obligation fold contract at ${root}`, { cause }); }
  }
  return { types: new Set([...parts[1].matchAll(/^\s*case '([^']+)':/gm)].map(match => match[1])), obligations };
}

function needsObligationFold(event) {
  // Probe only our known pure delegate, never target code. A lookup also marks
  // a dependency: completion events need the reader even without an open row.
  // Empty per-event scratch maps keep file admission streaming and bounded, and
  // cover payload-driven and generic pending events without a second type list.
  let needed = false;
  const obligations = new Proxy(new Map(), { get(map, key) {
    needed = true;
    const value = Reflect.get(map, key, map);
    return typeof value === 'function' ? value.bind(map) : value;
  } });
  applyObligationEvent({ items: new Map(), runs: new Map(), obligations }, event);
  return needed;
}

export function requireRecordCompatibility(root, events) {
  const reference = foldContract(sourceRoot), target = foldContract(root);
  const required = new Set(), missing = new Set();
  let first,through=0;
  for(const event of events) {
    through=event.seq??through;
    // decision.* also contains receipts consumed by the decision service, not
    // the aggregate fold. Only its actual fold cases belong to this contract.
    const delegated = needsObligationFold(event);
    if (delegated && (!reference.obligations || target.obligations !== reference.obligations)) {
      missing.add(`obligation fold for ${event.type}`);
      first ??= event.seq ?? 'unknown';
    }
    if(!delegated&&!reference.types.has(event.type)&&!/^(?:item|run|link|lesson|release|category)\./.test(event.type))continue;
    required.add(event.type);
    if((reference.types.has(event.type)||/^(?:item|run|link|lesson|release|category)\./.test(event.type))&&!target.types.has(event.type)){
      missing.add(event.type);first??=event.seq??'unknown';
    }
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
