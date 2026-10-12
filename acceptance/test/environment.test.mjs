import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLaneEnvironmentCommand } from '../environment.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-env-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = fs.mkdtempSync(path.join(root, 'herdr-lane-env-'));
  const file = path.join(dir, 'prepare.sh'), verifier = path.join(dir, 'verify.sh');
  const entries = [['ROUTE_TEST_FLAG', '1'], ['SECRET', "quotes ' $HOME $(exit 99);\nnext"]];
  const nonce = `lane-env-${'a'.repeat(48)}`;
  const checks = entries.map(([key, value]) => `[ "\${${key}+x}" = x ] && [ "$${key}" = ${quote(value)} ]`).join(' && ');
  fs.writeFileSync(verifier, `${checks} && printf '\\n%s\\n' ${quote(nonce)}\n`, { mode: 0o600 });
  fs.writeFileSync(file, `set +x\nexport ${entries.map(([key, value]) => quote(`${key}=${value}`)).join(' ')} || return\ncommand /bin/sh ${quote(verifier)}\n`, { mode: 0o600 });
  const command = ` . ${quote(file)} 2>/dev/null; command rm -f -- ${quote(file)} ${quote(verifier)}`;
  return { root, dir, file, verifier, command, nonce };
}
test('acceptance admits the exact private lane environment handoff including literal shell metacharacters', t => {
  const f = fixture(t);
  assert.equal(isLaneEnvironmentCommand(f.command, f.root), true);
});
for (const fault of ['outside', 'suffix', 'cleanup', 'mode', 'symlink', 'script', 'verifier']) test(`acceptance refuses altered lane environment handoff: ${fault}`, t => {
  const f = fixture(t);
  let command = f.command;
  if (fault === 'outside') f.root = path.join(f.root, 'other');
  if (fault === 'suffix') command += '; echo arbitrary';
  if (fault === 'cleanup') command = command.replace(`-- ${quote(f.file)}`, `-- ${quote(f.verifier)}`);
  if (fault === 'mode') fs.chmodSync(f.file, 0o644);
  if (fault === 'symlink') { fs.unlinkSync(f.file); fs.symlinkSync(f.verifier, f.file); }
  if (fault === 'script') fs.appendFileSync(f.file, 'echo arbitrary\n');
  if (fault === 'verifier') fs.appendFileSync(f.verifier, 'echo arbitrary\n');
  assert.equal(isLaneEnvironmentCommand(command, f.root), false);
});

test('an empty route environment proves shell readiness without printing ambient exports', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, `set +x\ncommand /bin/sh ${quote(f.verifier)}\n`);
  fs.writeFileSync(f.verifier, `true && printf '\\n%s\\n' ${quote(f.nonce)}\n`);
  assert.equal(isLaneEnvironmentCommand(f.command, f.root), true);
});
