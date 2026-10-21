import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Observe an actual wait in the unchanged lock implementation. Expiry advances
// only its next clock comparison beyond loadTimeout's maximum finite allowance,
// avoiding a two-minute fixture without adding a product timeout override.
export function watchPromotionLock(root, env, lock, { expire = false } = {}) {
  const preload = path.join(root, `promotion-lock-${randomUUID()}.cjs`), marker = preload + '.waiting';
  const source = fileURLToPath(new URL('../../lanes/promotion-lock.mjs', import.meta.url));
  fs.writeFileSync(preload, `const fs=require('node:fs'),mkdir=fs.mkdirSync,wait=Atomics.wait;
let contended=false;
fs.mkdirSync=function(directory,...args){
  if(directory!==${JSON.stringify(lock)})return mkdir.call(this,directory,...args);
  try{const result=mkdir.call(this,directory,...args);contended=false;return result;}
  catch(error){contended=error.code==='EEXIST';throw error;}
};
Atomics.wait=function(...args){
  if(contended&&new Error().stack.includes(${JSON.stringify(source)})){
    fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv)+'\\n');
    if(${JSON.stringify(expire)}){
      const now=Date.now;Date.now=()=>{Date.now=now;return now()+2**31;};
      return 'timed-out';
    }
  }
  return wait.apply(this,args);
};\n`);
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`;
  return marker;
}
