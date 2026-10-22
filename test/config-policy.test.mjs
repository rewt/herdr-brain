import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { validatePolicy, parsePolicyBytes, validateLane } from '../lib/config-policy.mjs';

const identitySettings = { launch: ['owner-launch'], identity_root: '/identity', defaults_origin: {}, project_access: [], brain_write: {} };

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
