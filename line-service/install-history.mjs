// The fresh release is the base of runtime history; no development migration
// is fabricated. Only a completed original install can seed later handoffs.
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {readPlainFile,plainDirectory} from '../lib/files.mjs';
import {canonical} from '../messages/schema.mjs';

export function freshInstallation({repo,org,identity,directory,cutover}){
  const ref=cutover.install_plan,folder=path.join(directory,'installs');
  if(!ref||!/^[-a-zA-Z0-9_]{1,80}$/.test(ref.id??'')||ref.id!==cutover.id||ref.file!==path.join(folder,ref.id+'.json'))throw Error('fresh installation intent binding differs');
  plainDirectory(folder,{create:false});
  const bytes=readPlainFile(ref.file),plan=JSON.parse(bytes),saved=plan.installation;
  if(!plan.cutover||Object.entries(plan.cutover).some(([key,value])=>canonical(cutover[key])!==canonical(value))||
      createHash('sha256').update(bytes).digest('hex')!==ref.sha256||plan.schema!=='line-release-install/v1'||plan.id!==ref.id||plan.repo!==repo||plan.org!==org||plan.identity!==identity||
      saved?.repo!==repo||saved.org!==org||saved.source!==cutover.source||saved.runtime?.root!==cutover.source||saved.runtime?.commit!==cutover.source_head||
      saved.file!==path.join(directory,'service.plist')||canonical(fs.readdirSync(folder).sort())!==canonical([ref.id+'.json']))throw Error('fresh installation intent changed');
  return {installation:{...saved,phase:'installed',fresh_install:ref},plist:plan.plist,last:cutover};
}
