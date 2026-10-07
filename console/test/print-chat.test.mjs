import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';

test('standalone print chat refusal never imports optional UI, including configured minimal profiles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'print-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixtureFleet(t, root);
  // Reject imports even in an installed checkout, so this regression cannot
  // depend on whether the developer happens to have console/node_modules.
  const preload = path.join(root, 'preload.mjs');
  fs.writeFileSync(preload, "import { register } from 'node:module'; register('./reject-ui.mjs', import.meta.url);\n");
  fs.writeFileSync(path.join(root, 'reject-ui.mjs'), `
export function resolve(specifier, context, next) {
  if (/^(react|ink)(\\/|$)/.test(specifier)) throw Error('Optional UI import forbidden: ' + specifier);
  return next(specifier, context);
}
`);
  const config = path.join(root, 'console.json');
  const app = new URL('../app.mjs', import.meta.url).pathname;
  for (const configured of ['full', 'minimal']) {
    fs.writeFileSync(config, JSON.stringify({ profile: configured, explain: false,
      projects: [{ name: 'Project', cwd: root, org: path.join(root, 'record') }] }));
    for (const flags of [[], ['--modern'], ['--minimal'], ['--profile', 'minimal'], ['--profile', 'full']]) {
      const run = size => spawnSync(process.execPath, ['--import', preload, app, ...flags,
        '--config', config, '--project', 'Project', '--print', size, '--keys', 'C'],
      { env: process.env, encoding: 'utf8' });
      const result = run('100x30');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '--print does not open project chats\n');
      const invalid = run('invalid');
      assert.equal(invalid.status, 1, invalid.stderr);
      assert.match(invalid.stderr, /--print expects COLSxROWS/);
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'record')), false);
});
