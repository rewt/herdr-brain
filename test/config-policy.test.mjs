import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { validatePolicy, parsePolicyBytes, validateLane } from '../lib/config-policy.mjs';

const identitySettings = { launch: ['owner-launch'], identity_root: '/identity', defaults_origin: {}, project_access: [], brain_write: {} };

test('review admission validates exact project-only policy and refuses malformed allowlists even when disabled',()=>{
  const policy={enabled:true,producer_groups:[`ENG-16:R-32:${'a'.repeat(64)}`],canonical_commits:['b'.repeat(40)],hold_ordinary:true};
  assert.equal(validatePolicy('lane',{review_admission:policy}).review_admission,policy);
  for(const kind of ['identity','routing'])assert.throws(()=>validatePolicy(kind,{review_admission:policy}),/project lane policy only/);
  assert.doesNotThrow(()=>validatePolicy('lane',{review_admission:{enabled:false}}));
  for(const bad of [null,[],{},true,{enabled:'true'},{enabled:true},{...policy,hold_ordinary:1},{...policy,typo:true},
    {...policy,producer_groups:['ENG-16']},{...policy,producer_groups:['*']},{...policy,producer_groups:[policy.producer_groups[0],policy.producer_groups[0]]},
    {...policy,canonical_commits:['b442f253']},{...policy,canonical_commits:['canonical:'+policy.canonical_commits[0]]},
    {enabled:false,canonical_commits:['bad']}])assert.throws(()=>validatePolicy('lane',{review_admission:bad}),/review_admission/);
});

test('every identity-only key is refused in project lane and routing policy, including null values', () => {
  for (const kind of ['lane', 'routing']) for (const [key, value] of Object.entries(identitySettings)) for (const input of [value, null]) {
    const config = { [key]: input };
    assert.throws(() => validatePolicy(kind, config, 'project.json'), /identity-only settings belong in identity.json/, `${kind}.${key}`);
    assert.throws(() => parsePolicyBytes(Buffer.from(JSON.stringify(config)), kind, 'project.json'), /identity-only settings belong in identity.json/);
  }
});

test('identity defaults and already admitted effective policy keep their validated literal launch prefix', () => {
  const config = { ...identitySettings, routes: { engineer: { kind: 'codex' } } };
  assert.equal(validatePolicy('identity', config), config);
  assert.equal(validatePolicy('routing-snapshot', config), config);
  assert.equal(validateLane(config, 'effective policy', { references: true }), config);
  for (const launch of [null, [], [''], ['bad\0word'], 'shell expression']) {
    assert.throws(() => validatePolicy('identity', { launch }), /launch must be/);
  }
});
