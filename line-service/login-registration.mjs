// A login entry follows the service's own atomically replaced plist. It carries
// no caller identity and never clears STOP or bootstraps a second service.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {plainDirectory} from '../lib/files.mjs';

export function loginRegistration(label, file, userHome = process.env.HOME || os.homedir()) {
  if (!/^dev\.herdr\.line\.[a-f0-9]{20}$/.test(label) || !path.isAbsolute(userHome) || !path.isAbsolute(file))
    throw Error('invalid service login registration binding');
  return {file:path.join(userHome,'Library','LaunchAgents',label+'.plist'),target:file};
}
export function inspectLoginRegistration(registration) {
  let ancestor=path.dirname(registration.file);
  while(!fs.lstatSync(ancestor,{throwIfNoEntry:false}))ancestor=path.dirname(ancestor);
  plainDirectory(ancestor,{create:false});
  const stat=fs.lstatSync(registration.file,{throwIfNoEntry:false});
  if(!stat)return {registered:false,reason:'login registration missing; project supervisor must arrange guarded installation before automatic login recovery is available'};
  if(!stat.isSymbolicLink() || fs.readlinkSync(registration.file)!==registration.target)
    throw Error('existing service login registration differs; retain it');
  return {registered:true};
}
export function createLoginRegistration(registration) {
  // Fresh installation only. EEXIST (including our own old intent) is final;
  // neither a refused nor an uncertain installation may replace an entry.
  if(inspectLoginRegistration(registration).registered)throw Error('service login registration already exists; retain it');
  plainDirectory(path.dirname(registration.file));
  fs.symlinkSync(registration.target,registration.file);
  return inspectLoginRegistration(registration);
}
