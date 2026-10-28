// The line's executing source is explicit. Saved worker/watch runtimes are not
// selected again when the controller moves to an accepted installed release.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {gitProject} from '../lib/project.mjs';
import {bundleRelease,projectPin,selectRelease,checkRelease,releaseHome,requireReadyAcceptance} from '../lib/releases.mjs';
import {readPlainFile} from '../lib/files.mjs';

export const runtimeRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function acceptedRuntime(repo,{root=runtimeRoot,home=releaseHome(),verifyFiles=true}={}) {
  root=fs.realpathSync(root);
  const pin=projectPin(repo);
  if(!pin?.release)throw Error('line runtime requires an explicit accepted project pin');
  const selected=selectRelease(repo,home,{pin});
  if(selected.root!==root)throw Error('executing line runtime differs from the accepted project pin');
  const release=checkRelease(home,pin.release,{verifyFiles});
  requireReadyAcceptance(release,home);
  return release;
}

export function serviceSource(repo,options={}) {
  const bundle=bundleRelease();
  if(bundle.commit)return acceptedRuntime(repo,options);
  const source=gitProject(runtimeRoot);
  if(source.checkout!==source.canonical)throw Error('live line service must use canonical development source or its accepted installed runtime');
  return bundle;
}

// A migrated cutover is an immutable old boundary plus one completed handoff,
// never a replacement boundary. Partial filesystem writes without that event
// remain UNKNOWN and cannot start a service.
export function migratedCutover(events,{repo,org,identity,directory,installation,cutover,root=runtimeRoot}) {
  const rows=events.filter(e=>e.type==='line-service.runtime-migrated'&&e.project===identity&&e.org===org);
  if(rows.length!==1)throw Error('service runtime migration is missing/ambiguous');
  const event=rows[0],ref=installation.migration;
  if(event.repo!==repo||event.source!==root||event.previous_source!==cutover.source||event.cutover_seq!==cutover.seq||
      event.cutover_id!==cutover.id||!ref||ref.id!==event.id||ref.file!==event.archive?.file||ref.sha256!==event.archive?.sha256||
      event.seq<=cutover.seq||!/^[-a-zA-Z0-9_]{1,80}$/.test(event.id??'')||ref.file!==path.join(directory,'migrations',event.id+'.json'))throw Error('service runtime migration binding differs');
  const bytes=readPlainFile(ref.file),archive=JSON.parse(bytes);
  if(digest(bytes)!==ref.sha256||archive.schema!=='line-runtime-migration/v1'||archive.id!==event.id||archive.repo!==repo||archive.org!==org||archive.identity!==identity||
      archive.source!==root||archive.previous_source!==cutover.source||JSON.stringify(archive.cutover)!==JSON.stringify(cutover)||
      JSON.stringify(archive.runtime)!==JSON.stringify(installation.runtime)||JSON.stringify(event.runtime)!==JSON.stringify(installation.runtime))throw Error('service runtime migration archive changed');
  const {migration,...saved}=installation;
  if(JSON.stringify(saved)!==archive.after.installation||digest(readPlainFile(path.join(directory,'service.plist')))!==digest(archive.after.plist))throw Error('migrated installation/plist drifted');
  return cutover;
}
