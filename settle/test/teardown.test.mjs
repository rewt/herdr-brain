import { loadTimeout } from '../../lib/deadline.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { pathToFileURL } from 'node:url';
import { spawnDetachedFixture } from '../../test/helpers/detached.mjs';

async function until(predicate) {
  const deadline = Date.now() + loadTimeout(5000);
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'fixture did not reach its transport call');
}

for (const slow of [false, true]) test(`teardown stops a ${slow ? 'slow transport and its' : 'persistently busy'} inbox owner before deleting the record`, async t => {
  const f = fixture(t, { actor: 'settle-teardown-test' });
  const inbox = path.join(f.org, 'supervisor/inbox.log');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.writeFileSync(inbox, JSON.stringify({ type: 'notice', id: 'teardown', to: 'supervisor', message: 'fixture notice',
    herdr: path.join(f.root, 'bin/herdr'), attempts: 1, retrySeconds: 0, title: 'Fixture', sound: 'request' }) + '\n');
  fs.writeFileSync(path.join(f.root, 'supervisor-composer'), fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url)));
  const ready = path.join(f.root, 'slow-ready');
  if (slow) {
    const herdr = path.join(f.root, 'bin/herdr');
    fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ready)},String(process.pid));\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);\nfs.writeFileSync(${JSON.stringify(path.join(f.root, 'late-write'))},'transport finished');\n`);
  }
  const script = path.join(f.source, 'supervisor/prompt-supervisor.mjs');
  const launched = f.exec(process.execPath, ['--input-type=module', '-e',
    `import {resumeInbox} from ${JSON.stringify(pathToFileURL(script).href)}; console.log(await resumeInbox(${JSON.stringify(inbox)}));`]);
  assert.equal(launched.status, 0, launched.stderr);
  const owner = Number(launched.stdout.trim());
  assert.ok(owner > 1);
  if (slow) await until(() => fs.existsSync(ready));
  const transport = slow ? Number(fs.readFileSync(ready, 'utf8')) : null;
  if (!slow) await assert.rejects(waitForInboxIdle(inbox), /fixture inbox owner did not exit/);
  await f.cleanup();
  assert.equal(fs.existsSync(f.root), false);
  for (const pid of [owner, transport].filter(Boolean)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('a real detached owner stays alive through test end and stops in the after-hook', async t => {
  const { root, child } = spawnDetachedFixture(t, 'inbox');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const owner = JSON.parse(fs.readFileSync(path.join(root, 'owner.json'), 'utf8'));
  assert.equal(owner.pgid, owner.pid);
  assert.equal(fs.readFileSync(path.join(root, 'teardown-complete'), 'utf8'), 'owner stopped');
});

test('teardown treats a lock pointing at an unrelated command as gone without signalling it', async t => {
  const f = fixture(t, { actor: 'settle-teardown-refusal-test' });
  const child = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const inbox = path.join(f.org, 'supervisor/inbox.log'), lock = `${inbox}.owner.lock`;
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: child.pid,
    argv: [process.execPath, path.join(f.source, 'supervisor/prompt-supervisor.mjs'), '--inbox', inbox, '--owner-worker'] }));
  try {
    await f.cleanup();
    assert.equal(fs.existsSync(f.root), false);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    child.kill('SIGKILL'); await waitForExit(child);
  }
});
