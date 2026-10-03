import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createReceiptTracker } from '../../../test/helpers/receipts.mjs';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function installRuntime(root) {
  for (const relative of ['housekeeping/housekeeping.mjs', 'housekeeping/config.mjs', 'supervisor/tidy-tabs.mjs',
    'supervisor/prompt-supervisor.mjs', 'supervisor/composer.mjs', 'supervisor/notice-lock.mjs', 'lanes/promotion-lock.mjs',
    'lib/store.mjs', 'lib/project.mjs', 'lib/files.mjs', 'lib/deadline.mjs', 'lib/process-owner.mjs',
    'lib/processes.mjs', 'lib/process-source.c', 'lib/native/manifest.json',
    'lib/native/process-source-darwin-arm64', 'lib/native/process-source-darwin-x64']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), target);
  }
  return fs.realpathSync(path.join(root, 'housekeeping/housekeeping.mjs'));
}
export function configureCliFixture(f) {
  f.config = path.join(f.root, 'config.json'); f.state = path.join(f.root, 'state');
  fs.writeFileSync(f.config, JSON.stringify({ enabled: true, tick_seconds: 1, cleanup_seconds: 2 }));
  const fake = path.join(f.root, 'fake.mjs');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst [group, op] = process.argv.slice(2);\nconst result = group === 'status' ? {runs:[], items:[]} : group === 'workspace' ? {workspaces:[]} : {agents:[]};\nconsole.log(JSON.stringify({result}));\n`);
  fs.chmodSync(fake, 0o755);
  f.runtime = installRuntime(f.repo);
  f.fake = fs.realpathSync(fake);
  f.args = [f.runtime, '--cwd', f.repo, '--org', f.root, '--config', f.config, '--state-dir', f.state, '--herdr', f.fake, '--org-cli', f.fake];
  return f;
}

export function rememberHousekeepingProcess(f, receipts) {
  const ownerFile = path.join(f.state, 'lock/owner.json');
  if (!fs.existsSync(ownerFile)) return;
  const command = [process.execPath, f.runtime, '--cwd', fs.realpathSync(f.repo), '--org', f.root,
    '--config', f.config, '--state-dir', f.state, '--main', 'main', '--herdr', f.fake,
    '--org-cli', f.fake, '--loop'].join(' ');
  return receipts.remember(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid, command);
}

// Register before the fixture's directory-removal hook, and wait for the
// accepted schedule to exit while its config and runtime still exist.
export function createHousekeepingStarter(t, getFixture) {
  const receipts = createReceiptTracker();
  t.after(async () => {
    const f = getFixture();
    let entry;
    try { if (f) entry = rememberHousekeepingProcess(f, receipts); }
    finally { receipts.cleanup('SIGTERM'); }
    if (!entry) return;
    const deadline = Date.now() + 5000;
    for (;;) {
      try { process.kill(entry.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      if (Date.now() >= deadline) {
        receipts.cleanup();
        throw new Error(`housekeeping schedule ${entry.pid} did not exit before fixture removal`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  return () => {
    const f = getFixture();
    const result = spawnSync(process.execPath, [...f.args, '--start'], {
      encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'housekeeping-test-agent' }, timeout: 10000,
    });
    rememberHousekeepingProcess(f, receipts);
    return result;
  };
}
