import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {requireSuccessorCapabilities, successorCapabilityDiagnostic, successorFingerprint, successorRequirements} from '../line-service/probation-successor-capabilities.mjs';
import {makeFixture, lane, git, ignoreLaneState} from '../lanes/test/lane-fixture.mjs';

const product=path.resolve(import.meta.dirname,'..');
const sources=['probation-successor.mjs','probation-successor-history.mjs','probation.mjs','development-recovery.mjs','runtime.mjs','launchd.mjs','probation-successor-capabilities.mjs'];

test('successor capability profiles cover the current writer requirements',()=>{
  const profile=requireSuccessorCapabilities(product);
  assert.deepEqual(profile.required,successorRequirements());
  assert.deepEqual(profile.capabilities,['successor-effect/v1','successor-fence/v1','successor-history/v2']);
  assert.equal(successorCapabilityDiagnostic(product),null);
});

test('successor canonical drift is visible in a lane check and clears after source recovery',t=>{
  const f=makeFixture();t.after(()=>f.cleanup());ignoreLaneState(f);
  const directory=path.join(f.repo,'line-service');fs.mkdirSync(directory);
  for(const file of sources)fs.copyFileSync(path.join(product,'line-service',file),path.join(directory,file));
  const file=path.join(directory,'launchd.mjs'),bytes=fs.readFileSync(file);
  fs.appendFileSync(file,'\nthrow Error("unreviewed target must not execute");\n');
  git(f.repo,['add','line-service']);git(f.repo,['commit','-qm','Unregistered canonical reader']);
  const fingerprint=successorFingerprint(f.repo);
  assert.throws(()=>requireSuccessorCapabilities(f.repo),/unrecognized successor-reader\/v1/);
  // An unrelated selection still surfaces the drift, without changing its result.
  const options={executable:path.join(product,'lanes/lane.mjs')};
  const refused=lane(f,['check','--cmd','true'],options);
  assert.equal(refused.status,0,refused.stderr);
  assert.match(refused.stderr,/lane check: successor-canonical-drift:/);
  assert.ok(refused.stderr.includes(`fingerprint=${fingerprint}`),refused.stderr);
  fs.writeFileSync(file,bytes);
  git(f.repo,['add','line-service']);git(f.repo,['commit','-qm','Restore reviewed source']);
  const recovered=lane(f,['check','--cmd','true'],options);
  assert.equal(recovered.status,0,recovered.stderr);
  assert.doesNotMatch(recovered.stderr,/successor-canonical-drift/);
  assert.equal(successorCapabilityDiagnostic(f.repo),null);
});

