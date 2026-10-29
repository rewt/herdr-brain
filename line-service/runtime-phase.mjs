// A stopped, verified configuration can become installed without asserting
// that its original refused bootstrap ever succeeded.
import {createHash} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function installationPhaseProof(saved,bytes,{target,service,stop_sha256}){
  if(saved.phase!=='uncertain-or-refused')return null;
  if(service?.loaded!==false||typeof service.native!=='string'||!service.native||!stop_sha256)
    throw Error('installation settlement requires verified stopped service and STOP');
  return{schema:'line-installation-settlement/v1',previous_phase:saved.phase,installation_sha256:digest(bytes),
    target,service,stop_sha256,phase:'installed',bootstrap_replayed:false};
}
export function settledInstallation(saved,proof){
  if(!proof)return saved;
  const after={...saved,phase:'installed',phase_settlement:proof};delete after.error;return after;
}
