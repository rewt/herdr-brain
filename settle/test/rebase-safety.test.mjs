import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const setup = (t) => fixture(t, { actor: 'settle-rebase-safety-test' });
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const mainCommit = (f, file, text) => {
  fs.writeFileSync(path.join(f.repo, file), text);
  f.git(['add', '--', file]); f.git(['commit', '-qm', 'Advance main']);
};

test('reviewed binary, modes, renames and same-file edits survive independent upstream edits', (t) => {
  const f = setup(t);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  mainCommit(f, 'shared.txt', lines.join('\n') + '\n');
  mainCommit(f, 'rename-from.txt', 'rename this\n'); f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n');
  const laneLines = [...lines]; laneLines[0] = 'reviewed change';
  fs.writeFileSync(path.join(f.workspace, 'shared.txt'), laneLines.join('\n') + '\n');
  fs.writeFileSync(path.join(f.workspace, 'binary.dat'), Buffer.from([0, 255, 1, 0, 128]));
  fs.writeFileSync(path.join(f.workspace, 'tool.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  f.git(['mv', 'rename-from.txt', 'rename-to.txt'], f.workspace);
  f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Preserve varied reviewed changes'], f.workspace); f.report(run);
  const upstreamLines = [...lines]; upstreamLines[19] = 'upstream change';
  mainCommit(f, 'shared.txt', upstreamLines.join('\n') + '\n');
  const r = result(f.settle(run)); assert.equal(r.result, 'promotable');
  const expected = [...laneLines]; expected[19] = 'upstream change';
  assert.equal(fs.readFileSync(path.join(f.workspace, 'shared.txt'), 'utf8'), expected.join('\n') + '\n');
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'binary.dat')), Buffer.from([0, 255, 1, 0, 128]));
  assert.match(f.git(['ls-tree', r.head, 'tool.sh']), /^100755 /);
  assert.equal(fs.existsSync(path.join(f.workspace, 'rename-from.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'rename-to.txt'), 'utf8'), 'rename this\n');
});

test('automatic rebase never updates other branches even when Git updateRefs is enabled', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  f.git(['branch', 'lane/other', reviewed]); f.git(['config', 'rebase.updateRefs', 'true']);
  mainCommit(f, 'main-only.txt', 'upstream\n');
  assert.equal(result(f.settle(run)).result, 'promotable');
  assert.equal(f.git(['rev-parse', 'lane/other']), reviewed);
});

test('a lost lane-head update response resumes only the saved proved commit without replay or review', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  mainCommit(f, 'main-only.txt', 'upstream\n');
  const realGit = f.exec('which', ['git']).stdout.trim();
  const marker = path.join(f.root, 'update-response-lost');
  const proxy = path.join(f.root, 'git-update-proxy.mjs');
  // Only the ref transaction needs fault injection. A Node hop for every Git
  // read made this recovery test exceed the fixture's bounded 15-second call.
  fs.writeFileSync(proxy, `
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(r.status===0&&args[0]==='update-ref'&&args.includes('--stdin')){
 if(fs.existsSync(${JSON.stringify(marker)})){console.error('unexpected second head update');process.exit(1);}
 fs.writeFileSync(${JSON.stringify(marker)},'lost response');console.error('injected lost head-update response');process.exit(1);
}
process.exit(r.status??1);
`);
  fs.writeFileSync(path.join(f.root, 'bin/git'), `#!/bin/sh\nif [ "$1" = update-ref ]; then exec '${process.execPath}' '${proxy}' "$@"; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const interrupted = f.settle(run); assert.equal(interrupted.status, 1, interrupted.stderr || interrupted.error?.message);
  assert.match(interrupted.stderr, /injected lost head-update response/);
  const file = path.join(f.org, 'settle', `${run}.json`), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.stage, 'rebase'); assert.equal(saved.rebase.state, 'prepared');
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), saved.rebase.to);
  const launches = f.calls().filter(a => a[1] === 'start').length;
  const r = result(f.retry(run)); assert.equal(r.result, 'promotable'); assert.equal(r.head, saved.rebase.to);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, launches);
});

test('main moving during replay refuses lane-head replacement and keeps the reviewed lane', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  mainCommit(f, 'main-only.txt', 'upstream\n');
  const hooks = path.join(f.root, 'hooks'); fs.mkdirSync(hooks);
  // Fixture paths are mkdtemp-generated and contain no shell metacharacters.
  fs.writeFileSync(path.join(hooks, 'post-rewrite'), `#!/bin/sh
unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE
printf 'main advanced during replay\\n' > '${f.repo}/main-only.txt'
git -C '${f.repo}' add main-only.txt
git -C '${f.repo}' -c core.hooksPath=/dev/null commit -qm 'Move main during replay'
`, { mode: 0o755 });
  f.git(['config', 'core.hooksPath', hooks]);
  const r = f.settle(run); assert.equal(r.status, 1); assert.match(r.stderr, /base branch moved/);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});
