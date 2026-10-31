// Controller-side capture only. The scenario receives this frozen tuple and
// verifies the copy again inside the kernel boundary before product effects.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkBundle} from '../lib/releases.mjs';
import {productFiles, payloadEntry} from '../lib/product-files.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function fixtureInventory(root, candidate) {
  const files=Object.fromEntries(productFiles(root).sort().map(file=>[file,payloadEntry(root,file)]));
  if(JSON.stringify(files)!==JSON.stringify(candidate.files))throw Error('candidate runtime inventory drift');
  return sha(JSON.stringify(files));
}
export function captureCandidate(directory, {commit,manifestSha256,tree}={}) {
  if(!/^[a-f0-9]{40}$/.test(commit??''))throw Error('exact candidate commit required');
  if(!/^[a-f0-9]{64}$/.test(manifestSha256??''))throw Error('exact manifest digest required');
  const root=fs.realpathSync(directory);
  if(root!==path.resolve(directory))throw Error('candidate root redirected');
  const bytes=fs.readFileSync(path.join(root,'.release-manifest.json'));
  if(sha(bytes)!==manifestSha256)throw Error('candidate manifest digest mismatch');
  const release=checkBundle(root,{verifyFiles:true});
  if(release.commit!==commit)throw Error('candidate commit mismatch');
  const files=Object.fromEntries(productFiles(root).sort().map(file=>[file,payloadEntry(root,file)]));
  // Freeze is required of the input, not inferred from a tag or copied name.
  function audit(file){const s=fs.lstatSync(file);if(s.mode&0o222)throw Error('candidate is writable');
    if(s.isDirectory())for(const name of fs.readdirSync(file))audit(path.join(file,name));
    else if(!s.isFile()||s.nlink!==1)throw Error('candidate payload redirected/shared');}
  audit(root);
  const validation=path.join(root,'.release-validation.json');
  const capturedTree=fs.existsSync(validation)?JSON.parse(fs.readFileSync(validation)).validation?.tree:tree;
  if(!/^[a-f0-9]{40}$/.test(capturedTree??'')||(tree&&tree!==capturedTree))throw Error('exact candidate source tree required');
  return {schema:'brain.installed-candidate/v1',root,commit,tree:capturedTree,
    manifestSha256,inventorySha256:sha(JSON.stringify(files)),files,node:{executable:process.execPath,version:process.version},
    protocol:release.protocol,configHome:JSON.parse(bytes).config_home??null};
}
