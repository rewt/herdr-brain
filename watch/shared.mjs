// Small observation metadata only. Neither this registry nor a native counter
// grants authority: the finite watcher rechecks the original claim at effects.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ownerAlive} from '../lib/process-owner.mjs';
import {openRecordReader} from '../lib/record-reader.mjs';
import {effectiveWorkerIdentity} from '../lib/worker-identity.mjs';

export const sharedDirectory = org => path.join(org, 'watch', 'shared');
export const observerDirectory = org => path.join(org, 'watch', 'observer');
export const registrationFile = (org, run) => path.join(sharedDirectory(org), `${run}.json`);
export const stepFile = (org, run) => path.join(org, 'watch', 'steps', `${run}.json`);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readWatchSubject(org, run) {
  const reader=openRecordReader(path.join(org,'events.jsonl'));
  try {
    if(reader.tornTail)throw Error('incomplete record prevents finite watcher observation');
    const current=reader.state.runs.get(run);if(!current)throw Error('original run is missing');
    // The compact reader exposes lazy ReadMaps. Identity helpers deliberately
    // accept native Maps/plain transported tables; select only this subject.
    const selected=Object.fromEntries(['workerReceipts','sessionBindings'].map(key=>
      [key,new Map([[run,reader.state[key].get(run)]])]));
    return {...current,meta:effectiveWorkerIdentity(current,selected)};
  } finally {reader.close();}
}
export function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file || stat.size > 1024 * 1024) throw Error(`redirected/oversized observation metadata: ${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function stamp(file) {
  try { const s = fs.statSync(file, {bigint:true}); return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':'); }
  catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
}
export function nativeBinding(agent) {
  return {agent:agent?.name,pane:agent?.pane_id,workspace:agent?.workspace_id,
    terminal:agent?.terminal_id,session:agent?.agent_session?.value,cwd:agent?.cwd};
}
export function sameNative(expected, agent) {
  const actual = nativeBinding(agent);
  return ['agent','pane','workspace','terminal','session','cwd'].every(k =>
    typeof expected?.[k] === 'string' && expected[k] && expected[k] === actual[k]);
}
export function observerReceipt(org, {repo, project, source, socket}, alive = ownerAlive) {
  const saved = readJson(path.join(observerDirectory(org), 'owner.json'));
  if (!saved || saved.org !== org || saved.repo !== repo || saved.project !== project ||
      saved.source !== source || saved.socket !== socket || !alive(saved)) throw Error('matching live project observer required; retain the original observation duty');
  return saved;
}

// A project can turn new starts off without abandoning existing shared duties.
export function pendingSharedDuties(org) {
  const directory=sharedDirectory(org);
  if(!fs.existsSync(directory))return false;
  return fs.readdirSync(directory).some(name=>/^R-\d+\.json$/.test(name)&&readJson(stepFile(org,name.slice(0,-5)))?.phase!=='complete');
}
