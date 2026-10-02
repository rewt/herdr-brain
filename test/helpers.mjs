// Shared setup for CLI tests: a fresh organization in a temporary directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
export const T0 = '2026-09-15T09:00:00Z';

export function setupOrg({ tz = 'UTC' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-org-'));
  const dir = path.join(root, '.org');
  const org = (argv, { now = T0, env = {} } = {}) => {
    // Explicitly simulate an unnamed writer unless this test supplies an actor.
    const base = { ...process.env, ORG_ACTOR: '' };
    const r = spawnSync(process.execPath, [BIN, ...argv], {
      cwd: root,
      encoding: 'utf8',
      env: { ...base, ORG_DIR: dir, ORG_NOW: now, TZ: tz, ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const ok = (argv, opts) => {
    const r = org(argv, opts);
    assert.equal(r.code, 0, `org ${argv.join(' ')}\n${r.err}${r.out}`);
    return r.out;
  };
  const fail = (argv, opts) => {
    const r = org(argv, opts);
    assert.equal(r.code, 1, `expected org ${argv.join(' ')} to fail\n${r.err}${r.out}`);
    return r.err;
  };
  const events = () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const json = (argv, opts) => JSON.parse(ok(argv, opts));
  ok(['init', dir]);
  return { root, dir, org, ok, fail, events, json };
}

export function report(fields) {
  return `---\n${fields}\n---\nDetails.\n`;
}
