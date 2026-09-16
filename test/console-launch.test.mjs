import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupOrg } from './helpers.mjs';

const CONSOLE = fileURLToPath(new URL('../console/', import.meta.url));

test('org console explains how to install the console when its dependencies are missing', () => {
  const t = setupOrg();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-console-'));
  const r = t.org(['console'], { env: { HERDR_ORG_CONSOLE_DIR: empty } });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`dependencies are not installed; run: npm --prefix ${empty.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ci`));
});

test('org console starts the console app, which writes an example configuration on first run', { skip: !fs.existsSync(path.join(CONSOLE, 'node_modules', 'ink')) && 'console dependencies not installed' }, () => {
  const t = setupOrg();
  const config = path.join(t.root, 'cfg', 'console.json');
  const r = t.org(['console', '--project', 'x'], { env: { HERDR_ORG_CONSOLE_CONFIG: config } });
  assert.equal(r.code, 1);
  assert.match(r.err, /wrote an example configuration to .*console\.json/);
  assert.ok(fs.existsSync(config));
});
