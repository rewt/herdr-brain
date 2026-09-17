import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PANE = fileURLToPath(new URL('../contrib/console-pane.sh', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));

function setup({ existingTab = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-pane-'));
  const bin = path.join(root, 'bin');
  const cwd = path.join(root, 'checkout');
  fs.mkdirSync(bin);
  fs.mkdirSync(cwd);
  const calls = path.join(root, 'calls.log');
  const tabs = existingTab ? '[{"tab_id":"w1:t7","label":"console"}]' : '[{"tab_id":"w1:t1","label":"lanes"}]';
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w0","worktree":{"is_linked_worktree":false,"checkout_path":"/elsewhere"}},{"workspace_id":"w1","worktree":{"is_linked_worktree":false,"checkout_path":"${cwd}"}}]}}' ;;
  "tab list") echo '{"result":{"tabs":${tabs}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t9"},"root_pane":{"pane_id":"w1:p9"}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`, { mode: 0o755 });
  const config = path.join(root, 'console.json');
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: 'first', org: '/o1', cwd: '/nowhere' }, { name: 'bch-cloak', org: '/o2', cwd }] }));
  const run = (args, { configVar = config, cwd: runCwd, home } = {}) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONSOLE_PANE_WAIT: '0', ...(home ? { HOME: home } : {}) };
    delete env.HERDR_ORG_CONSOLE_CONFIG;
    if (configVar) env.HERDR_ORG_CONSOLE_CONFIG = configVar;
    const r = spawnSync(PANE, args, { encoding: 'utf8', env, cwd: runCwd });
    const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { code: r.status, out: r.stdout, err: r.stderr, calls: log };
  };
  return { root, cwd, config, run };
}

test('console-pane opens an unfocused console tab in the project\'s workspace', () => {
  const t = setup();
  const r = t.run(['bch-cloak']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.slice(0, 3), [
    'workspace list',
    'tab list --workspace w1',
    `tab create --workspace w1 --cwd ${t.cwd} --label console --no-focus --env HERDR_ORG_CONSOLE_CONFIG=${t.config}`,
  ]);
  assert.match(r.calls[3], new RegExp(`^pane run w1:p9 .*${BIN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}.* console --project .?bch-cloak`));
  assert.match(r.out, /console tab w1:t9 opened in workspace w1/);
});

test('console-pane hands a relative configuration path to the new tab as an absolute one', () => {
  const t = setup();
  const r = t.run(['bch-cloak'], { configVar: 'console.json', cwd: t.root });
  assert.equal(r.code, 0, r.err);
  // The shell's working directory is the real path (macOS tmp dirs sit behind /var).
  const config = path.join(fs.realpathSync(t.root), 'console.json');
  assert.equal(r.calls[2], `tab create --workspace w1 --cwd ${t.cwd} --label console --no-focus --env HERDR_ORG_CONSOLE_CONFIG=${config}`);
});

test('console-pane leaves an existing console tab alone and refuses unknown projects', () => {
  const t = setup({ existingTab: true });
  const r = t.run(['bch-cloak']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls, ['workspace list', 'tab list --workspace w1']);
  assert.match(r.out, /already has a console tab \(w1:t7\)/);

  const unknown = t.run(['nope']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no project named "nope" \(configured: first, bch-cloak\)/);

  const noWorkspace = t.run(['first']);
  assert.equal(noWorkspace.code, 1);
  assert.match(noWorkspace.err, /no Herdr workspace has \/nowhere as its checkout/);

  // Without an argument, the first configured project is used.
  assert.match(t.run([]).err, /\/nowhere/);
});

test('console-pane passes no configuration to the tab when none was chosen', () => {
  const t = setup();
  const home = path.join(t.root, 'home');
  fs.mkdirSync(path.join(home, '.config', 'herdr-org'), { recursive: true });
  fs.copyFileSync(t.config, path.join(home, '.config', 'herdr-org', 'console.json'));
  const r = t.run(['bch-cloak'], { configVar: null, home });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.calls[2], `tab create --workspace w1 --cwd ${t.cwd} --label console --no-focus`);
});
