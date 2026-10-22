import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealRemovalInputs } from '../lib/retire-local.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'removal-seal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retirement = path.join(root, 'retirement'), occupants = path.join(retirement, 'occupants');
  fs.mkdirSync(occupants, { recursive: true });
  const external = path.join(root, 'external.json'); fs.writeFileSync(external, 'not authority');
  return { root, retirement, occupants, external };
}

test('an ignored receipt symlink is sealed without following it', t => {
  const f = fixture(t), link = path.join(f.occupants, 'ignored.json');
  fs.symlinkSync(f.external, link);
  const verify = sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] });
  verify(); fs.writeFileSync(f.external, 'still not authority'); verify();
  assert.equal(fs.readlinkSync(link), f.external);
  fs.unlinkSync(link); fs.writeFileSync(link, '{}');
  assert.throws(verify, /removal preflight input changed/);
});

for (const change of ['retarget', 'add', 'remove', 'edit-receipt']) test(`receipt inventory ${change} invalidates its removal seal`, t => {
  const f = fixture(t), link = path.join(f.occupants, 'ignored.json'), receipt = path.join(f.occupants, 'real.json');
  fs.symlinkSync(f.external, link); fs.writeFileSync(receipt, '{}');
  const verify = sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] });
  if (change === 'retarget') { fs.unlinkSync(link); fs.symlinkSync('different.json', link); }
  if (change === 'add') fs.writeFileSync(path.join(f.occupants, 'new.json'), '{}');
  if (change === 'remove') fs.unlinkSync(link);
  if (change === 'edit-receipt') fs.writeFileSync(receipt, '{"changed":true}');
  assert.throws(verify, /removal preflight input changed/);
});

test('an inert receipt allowance cannot authorize a root or nested authority redirect', t => {
  const f = fixture(t), link = path.join(f.occupants, 'ignored.json'); fs.symlinkSync(f.external, link);
  assert.throws(() => sealRemovalInputs([link], { inertLinkParents: [f.occupants] }), /redirected removal input/);
  assert.throws(() => sealRemovalInputs([f.retirement]), /redirected removal input/);
  fs.unlinkSync(link); const nested = path.join(f.occupants, 'nested'); fs.mkdirSync(nested);
  fs.symlinkSync(f.external, path.join(nested, 'redirect.json'));
  assert.throws(() => sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] }), /redirected removal input/);
  fs.rmSync(nested, { recursive: true }); fs.rmdirSync(f.occupants);
  fs.symlinkSync(f.root, f.occupants, 'dir');
  assert.throws(() => sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] }), /redirected removal input/);
});
