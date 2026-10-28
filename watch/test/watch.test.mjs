import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from '../../test/helpers/bounded-test.mjs';
import { fileURLToPath } from 'node:url';
import { waitForFile } from '../../test/helpers/file-wait.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';

import {
  blockedNotice,
  invalidReportNotice,
  longRunningNotice,
  noReportNotice,
  reportNotice,
  unavailableNotice,
} from '../notice.mjs';
import { seedOwnedRun } from '../../test/helpers/run-claim.mjs';
import { readInbox } from '../../supervisor/prompt-supervisor.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { stateDirectory, readJournal } from '../../messages/journal.mjs';
import { gitProject } from '../../lib/project.mjs';
import { createRunEventTail } from '../record-tail.mjs';

const TEST_ENV = { ...process.env, BRAIN_SHADOW_ROOT: process.env.BRAIN_SHADOW_ROOT || path.join(process.env.HERDR_TEST_OFFLINE_ROOT, 'shadow'), ORG_ACTOR: 'watch-test-agent', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.02', SUPERVISOR_INPUT_POLL_SECONDS: '0.02', SUPERVISOR_INPUT_WAIT_SECONDS: '2' };
const WATCH = fileURLToPath(new URL('../watch.mjs', import.meta.url));
const checkout = path.resolve(import.meta.dirname, '../..');
const hasGitCheckout = !!fs.lstatSync(path.join(checkout, '.git'), { throwIfNoEntry: false });

function executable(file, body) {
  if (path.basename(file) === 'herdr') body = `
if [ "$1 $2 $3" = 'agent get supervisor-test' ]; then
  printf '%s\\n' '{"result":{"agent":{"agent_status":"idle","agent":"claude","pane_id":"fake:supervisor","terminal_id":"fake:supervisor-terminal"}}}'
  exit 0
fi
if [ "$1 $2" = 'pane read' ]; then
  printf '%s\\n' '────────────────────' '❯ ' '────────────────────'
  exit 0
fi
if [ "$1 $2" = 'agent wait' ]; then
  trap 'exit 0' TERM
fi
${body}`;
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function reportText(run, headline = 'The report arrived') {
  return `---\nrun: ${run}\noutcome: done\nsummary: Report arrived.\nheadline: ${headline}\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`;
}

function watcherFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-branch-'));
  seedOwnedRun(path.join(root, '.org'), run);
  const report = path.join(root, 'report.md');
  const calls = path.join(root, 'herdr-calls');
  const org = path.join(root, 'org');
  const herdr = path.join(root, 'herdr');
  const writer = path.join(root, 'write-report');
  const started = new Date().toISOString();
  executable(org, `case "$1" in
  show) printf '%s\\n' '{"id":"${run}","item":"ENG-9","meta":{"agent":"lane-nine"},"report_path":"${report}","started":{"at":"${started}"}}' ;;
  check) printf '%s\\n' 'ok: done · 0 blockers' ;;
  *) exit 2 ;;
esac`);
  executable(writer, `printf '%s' '${reportText(run)}' > '${report}'`);
  const args = [
    WATCH, run, '--org', path.join(root, '.org'), '--org-cli', org, '--herdr', herdr,
    '--to', 'supervisor-test', '--retry-after', '0',
  ];
  return { root, report, calls, org, herdr, writer, args };
}

function startWatcher(t, args) {
  return spawnChild(t, process.execPath, args, { env: TEST_ENV });
}

function eventTailFixture(t, { readLimit = Infinity } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-record-tail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'note.added', id: 'R-940', text: 'old history' }) + '\n');
  const reads = [];
  const changed = createRunEventTail(file, { run: 'R-940', item: 'ENG-9', io: { ...fs,
    readSync(fd, buffer, start, length, position) {
      const bytes = fs.readSync(fd, buffer, start, Math.min(length, readLimit), position);
      reads.push({ position, bytes }); return bytes;
    },
  } });
  const append = (event, newline = true) => fs.appendFileSync(file, JSON.stringify(event) + (newline ? '\n' : ''));
  return { file, reads, changed, append };
}

test('record tail reads only appended bytes and ignores unrelated lifecycle and own metadata events', t => {
  const f = eventTailFixture(t), initial = fs.statSync(f.file).size;
  assert.equal(f.changed(), false); assert.deepEqual(f.reads, []);
  for (const event of [
    { type: 'run.claimed', run: 'R-941' }, { type: 'run.abandoned', id: 'R-941' },
    { type: 'report.ingested', run: 'R-941' }, { type: 'item.closed', id: 'ENG-10' },
    { type: 'run.updated', id: 'R-940', meta: { process_end: 'observed' } },
    { type: 'note.added', id: 'R-940', text: 'x'.repeat(130_000) },
    { type: 'future.event', run: 'R-940' },
  ]) f.append(event);
  assert.equal(f.changed(), false);
  const firstEnd = fs.statSync(f.file).size;
  assert.equal(f.reads[0].position, initial);
  assert.equal(f.reads.reduce((sum, read) => sum + read.bytes, 0), firstEnd - initial);
  assert.ok(f.reads.every(read => read.bytes <= 64 * 1024));
  const count = f.reads.length;
  assert.equal(f.changed(), false); assert.equal(f.reads.length, count, 'unchanged stat never opens or reads history');
  f.append({ type: 'note.added', id: 'R-941', text: 'next append' });
  assert.equal(f.changed(), false); assert.equal(f.reads[count].position, firstEnd);
  f.append({ type: 'report.ingested', run: 'R-940' });
  assert.equal(f.changed(), true);
});

for (const event of [
  { type: 'report.ingested', run: 'R-940' }, { type: 'run.claimed', run: 'R-940' },
  { type: 'run.abandoned', id: 'R-940' }, { type: 'item.closed', id: 'ENG-9' },
]) test(`record tail wakes for ${event.type} of its run or item`, t => {
  const f = eventTailFixture(t); f.append(event); assert.equal(f.changed(), true);
});

test('record tail keeps byte offsets across split UTF-8 and complete events without a final newline', t => {
  const f = eventTailFixture(t, { readLimit: 7 }), initial = fs.statSync(f.file).size;
  f.append({ type: 'note.added', id: 'R-941', text: '😀 café 漢字'.repeat(10) }, false);
  assert.equal(f.changed(), false);
  const end = fs.statSync(f.file).size, count = f.reads.length;
  assert.equal(f.reads.reduce((sum, read) => sum + read.bytes, 0), end - initial);
  fs.appendFileSync(f.file, '\n');
  f.append({ type: 'run.claimed', run: 'R-940' }, false);
  assert.equal(f.changed(), true); assert.equal(f.reads[count].position, end);
});

for (const damage of ['missing', 'truncated', 'replaced', 'malformed', 'torn']) {
  test(`record tail wakes for a ${damage} record`, t => {
    const f = eventTailFixture(t);
    if (damage === 'missing') fs.unlinkSync(f.file);
    if (damage === 'truncated') fs.truncateSync(f.file, 0);
    if (damage === 'replaced') {
      fs.writeFileSync(f.file + '.new', fs.readFileSync(f.file)); fs.renameSync(f.file + '.new', f.file);
    }
    if (damage === 'malformed') fs.appendFileSync(f.file, '{broken}\n');
    if (damage === 'torn') fs.appendFileSync(f.file, '{"type":"report.ingested"');
    assert.equal(f.changed(), true);
  });
}

for (const fallback of [false, true]) {
  for (const change of ['reported', 'abandoned', 'claim moved', 'record removed', 'org removed', 'STOP']) {
    test(`a blocking watcher exits on ${change}${fallback ? ' after ignoring unrelated events without filesystem watches' : ''}`, async t => {
      const f = watcherFixture('R-940');
      t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
      if (!fallback && !await requireFileWatch(t, f.root)) return;
      const record = path.join(f.root, '.org/events.jsonl');
      const stop = path.join(f.root, '.lane/supervisor/STOP');
      fs.mkdirSync(path.dirname(stop), { recursive: true });
      // Unlike an agent-state transition, these changes cannot release this
      // wait. The watcher must terminate the exact wait it started.
      const waiting = path.join(f.root, 'waiting'), ended = path.join(f.root, 'wait-ended');
      const untilText = async (file, pattern) => {
        const deadline = Date.now() + loadTimeout(10_000);
        while (!fs.existsSync(file) || !pattern.test(fs.readFileSync(file, 'utf8'))) {
          assert.ok(Date.now() < deadline, `timed out waiting for ${file}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      fs.writeFileSync(f.herdr, `#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)},JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get') console.log(JSON.stringify({result:{agent:a[2]==='supervisor-test'
  ? {agent:'claude',agent_status:'idle',pane_id:'fake:supervisor',terminal_id:'fake:supervisor-terminal'}
  : {agent_status:'working'}}}));
else if(a[0]==='agent'&&a[1]==='wait') {
  process.once('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(ended)},'terminated');process.exit(0);});
  fs.writeFileSync(${JSON.stringify(waiting)},'waiting');setInterval(()=>{},1000);
} else if(a[0]==='pane'&&a[1]==='read') { console.log('────────────────────'); console.log('❯ '); console.log('────────────────────'); }
else if(a[0]==='agent'&&a[1]==='prompt') console.log('{}');
else process.exit(2);
`, { mode: 0o755 });
      const preloads = [], tailRead = path.join(f.root, 'tail-read');
      if (fallback) {
        const preload = path.join(f.root, 'lost-watches.mjs');
        // Exercise the production fallback without a thirty-second test wait.
        fs.writeFileSync(preload, `import fs from 'node:fs';
fs.watch=()=>{throw Error('fixture: fs.watch unavailable');};
const interval=globalThis.setInterval;
globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===30000?50:ms,...args);
const open=fs.openSync,close=fs.closeSync,read=fs.readSync,records=new Set();
fs.openSync=(file,...args)=>{const fd=open(file,...args);if(file===${JSON.stringify(record)})records.add(fd);return fd;};
fs.closeSync=fd=>{records.delete(fd);return close(fd);};
fs.readSync=(fd,buffer,start,length,position)=>{
  const bytes=read(fd,buffer,start,length,position);
  if(records.has(fd)&&Number.isInteger(position))fs.appendFileSync(${JSON.stringify(tailRead)},String(position+bytes)+'\\n');
  return bytes;
};
`);
        preloads.push('--import', preload);
      }
      const child = startWatcher(t, [...preloads, ...f.args, '--cwd', f.root, '--start-grace', '0']);
      await untilText(waiting, /waiting/);
      // Idle fallback ticks only stat files; they never respawn Herdr or write
      // an ownership receipt. This also proves the fallback timer is live.
      if (fallback) {
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 2);
        assert.equal(fs.existsSync(path.join(f.root, '.org/watch/R-940.json')), false);
      }
      const events = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
      let sequence = 2;
      const append = event => fs.appendFileSync(record, JSON.stringify({ ...event, seq: ++sequence,
        at: new Date().toISOString(), by: 'fixture' }) + '\n');
      if (fallback) {
        for (const batch of [
          [{ type: 'run.started', id: 'R-941', item: 'ENG-10', meta: {} },
            { ...events[1], run: 'R-941' }, { type: 'report.ingested', run: 'R-941', report: { outcome: 'done' } }],
          [{ type: 'run.abandoned', id: 'R-941' }, { type: 'item.closed', id: 'ENG-10', as: 'done' },
            { type: 'run.updated', id: 'R-940', meta: { process_end: 'observed' } }],
        ]) {
          for (const event of batch) append(event);
          await untilText(tailRead, new RegExp(`^${fs.statSync(record).size}$`, 'm'));
          assert.equal(child.exitCode, null);
          assert.equal(fs.existsSync(ended), false, 'unrelated lifecycle and own metadata retain the exact wait');
          assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 2, 'no Herdr respawn pass');
          assert.equal(fs.existsSync(path.join(f.root, '.org/watch/R-940.json')), false);
        }
      }
      if (change === 'reported') append({ type: 'report.ingested', run: 'R-940', report: {
        outcome: 'done', summary: 'Report arrived.', headline: 'The report arrived',
      } });
      if (change === 'abandoned') append({ type: 'run.abandoned', id: 'R-940' });
      if (change === 'claim moved') append({ ...events[1], owner: { ...events[1].owner, controller: 'successor' } });
      if (change === 'record removed') fs.unlinkSync(record);
      if (change === 'org removed') fs.rmSync(path.dirname(record), { recursive: true });
      if (change === 'STOP') fs.writeFileSync(stop, 'Operator stop\n');
      const result = await waitForExit(child);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, change === 'reported' ? /final notice confirmed from its ingested report/ : change === 'abandoned'
        ? /was abandoned; stopping/ : change === 'STOP' ? /Supervisor STOP; stopping without delivery/
          : /stopping without delivery/);
      await untilText(ended, /terminated/);
      const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
      if (change === 'reported') {
        assert.deepEqual(calls.slice(0, 2).map(a => a.slice(0, 2)), [['agent', 'get'], ['agent', 'wait']]);
        const prompts = calls.filter(a => a[1] === 'prompt');
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0][2], 'supervisor-test');
        assert.match(prompts[0][3], /notice-id=watch:R-940:final$/);
        const receipt = JSON.parse(fs.readFileSync(path.join(f.root, '.org/watch/R-940.json')));
        assert.deepEqual(receipt.deliveries, ['watch:R-940:final']);
        assert.equal(receipt.intent, undefined);
        await waitForInboxIdle(path.join(f.root, '.org/supervisor/inbox.log'));
      } else {
        assert.deepEqual(calls.map(a => a.slice(0, 2)), [['agent', 'get'], ['agent', 'wait']]);
        assert.equal(fs.existsSync(path.join(f.root, '.org/watch/R-940.json')), false);
      }
    });
  }
}

function retiringWatcherFixture(t, run) {
  const f = watcherFixture(run);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  executable(f.org, `printf '%s\\n' '{"id":"${run}","item":"ENG-9","meta":{"agent":"lane-nine"},"abandoned":{"note":"fixture complete"},"report_path":"${f.report}"}'`);
  executable(f.herdr, `printf '%s\\n' "$*" >> '${f.calls}'; echo '{"result":{}}'`);
  return { ...f, retire: async (cwd, preloads = []) => {
    const child = spawnChild(t, process.execPath, [...preloads, ...f.args, '--cwd', cwd, '--close-tab-on-exit'], {
      env: { ...TEST_ENV, HERDR_TAB_ID: 'watch-tab' },
    });
    const result = await waitForExit(child);
    assert.equal(result.code, 0, result.stderr);
    return result;
  } };
}

async function waitForTabClose(f) {
  const deadline = Date.now() + loadTimeout(5000);
  while (!fs.existsSync(f.calls) || !/tab close watch-tab/.test(fs.readFileSync(f.calls, 'utf8'))) {
    assert.ok(Date.now() < deadline, 'watcher did not close its tab');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('retirement hold: native watcher closes its tab from a non-Git cwd', async t => {
  const f = retiringWatcherFixture(t, 'R-902');
  const probe = spawnSync('git', ['-C', f.root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', env: { ...TEST_ENV, LC_ALL: 'C' },
  });
  assert.equal(probe.status, 128, probe.stderr);
  assert.match(probe.stderr, /^fatal: not a git repository/);
  const result = await f.retire(f.root);
  assert.doesNotMatch(result.stdout, /"action":"held"/);
  await waitForTabClose(f);
});

test('retirement hold: native watcher self-retirement keeps its tab from a linked cwd', async t => {
  const f = retiringWatcherFixture(t, 'R-901');
  const repo = path.join(f.root, 'repo'), lane = path.join(f.root, 'lane'); fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], ['worktree', 'add', '-b', 'lane/held', lane]]) {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  }
  const hold = path.join(repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'); fs.mkdirSync(path.dirname(hold), { recursive: true }); fs.writeFileSync(hold, 'hold');
  const held = await f.retire(lane); assert.ok(!fs.existsSync(f.calls) || !/tab close|workspace close|worktree remove/.test(fs.readFileSync(f.calls, 'utf8'))); assert.match(held.stdout, /held/);
  fs.unlinkSync(hold); await f.retire(lane);
  await waitForTabClose(f);
});

test('retirement hold: native watcher keeps its tab when the cwd has a broken Git pointer', async t => {
  const f = retiringWatcherFixture(t, 'R-905');
  fs.writeFileSync(path.join(f.root, '.git'), 'gitdir: missing-git-directory\n');
  const probe = spawnSync('git', ['-C', f.root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', env: { ...TEST_ENV, LC_ALL: 'C' },
  });
  assert.equal(probe.status, 128, probe.stderr);
  assert.match(probe.stderr, /^fatal: not a git repository: /);
  const held = await f.retire(f.root);
  assert.match(held.stdout, /"action":"held"/);
  assert.ok(!fs.existsSync(f.calls) || !/tab close|workspace close|worktree remove/.test(fs.readFileSync(f.calls, 'utf8')));
});

for (const fault of ['canonical', 'hold']) test(`retirement hold: native watcher keeps its tab on an indeterminate ${fault} lookup inside Git`, async t => {
  const f = retiringWatcherFixture(t, fault === 'canonical' ? 'R-903' : 'R-904');
  const repo = path.join(f.root, 'repo'); fs.mkdirSync(repo);
  const init = spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const preload = path.join(f.root, 'fault.mjs'), reached = path.join(f.root, 'fault-reached');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fault = ${JSON.stringify(fault)}, marker = ${JSON.stringify(reached)};
const exec = cp.execFileSync, lstat = fs.lstatSync;
cp.execFileSync = function(command, args, ...rest) {
  if (fault === 'canonical' && command === 'git' && args.at(-1) === '--git-common-dir' && ${JSON.stringify([repo, fs.realpathSync(repo)])}.includes(args[1])) {
    fs.writeFileSync(marker, 'canonical');
    throw Object.assign(Error('injected canonical lookup failure'), { status: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\\n' });
  }
  return exec.call(this, command, args, ...rest);
};
fs.lstatSync = function(target, ...rest) {
  if (fault === 'hold' && target === ${JSON.stringify(path.join(fs.realpathSync(repo), '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'))}) {
    fs.writeFileSync(marker, 'hold');
    throw Object.assign(Error('injected hold lookup failure'), { code: 'EACCES' });
  }
  return lstat.call(this, target, ...rest);
};
syncBuiltinESMExports();
`);
  const held = await f.retire(repo, ['--import', preload]);
  assert.equal(fs.readFileSync(reached, 'utf8'), fault, 'the indeterminate lookup must be exercised');
  assert.match(held.stdout, /"action":"held"/);
  assert.ok(!fs.existsSync(f.calls) || !/tab close|workspace close|worktree remove/.test(fs.readFileSync(f.calls, 'utf8')));
});

function waitForText(file, pattern, timeoutMs = 10_000) {
  return waitForFile(file, body => pattern.test(body), { timeoutMs });
}

async function requireFileWatch(t, directory) {
  // Some outer sandboxes allow fs.watch construction but asynchronously reject
  // it with EMFILE/EPERM. Probe delivery rather than passing this test through
  // its independent Herdr wake-up path without exercising filesystem events.
  const probe = path.join(directory, 'watch-probe');
  return new Promise((resolve, reject) => {
    let watcher, timer, writer, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(writer);
      watcher?.close();
      if (error && !['EMFILE', 'ENOSPC', 'EPERM', 'EACCES'].includes(error.code)) return reject(error);
      if (error) t.skip(`filesystem notifications unavailable: ${error.code}`);
      resolve(!error);
    };
    try {
      watcher = fs.watch(directory, () => finish());
      watcher.once('error', finish);
      timer = setTimeout(() => finish(new Error('filesystem notification probe timed out')), loadTimeout(10_000));
      fs.writeFileSync(probe, 'probe');
      // FSEvents registration can lag fs.watch returning under load. Keep
      // exercising the probe until the backend delivers an event or errors.
      writer = setInterval(() => fs.writeFileSync(probe, String(Date.now())), 100);
    } catch (error) { finish(error); }
  });
}

test('every terminal condition has a distinct, compact supervisor notice', () => {
  const common = { run: 'R-7', item: 'ENG-3', agent: 'lane-seven', report: '/tmp/report.md' };
  assert.equal(
    reportNotice({ ...common, outcome: 'done', headline: 'The work landed', check: 'pass' }),
    '[org-report] run=R-7 item=ENG-3 outcome=done headline="The work landed" check=pass report=/tmp/report.md',
  );
  assert.match(invalidReportNotice({ ...common, error: 'outcome is required' }), /^\[watch-invalid-report\].*check=fail.*outcome is required/);
  assert.match(noReportNotice({ ...common, state: 'gone' }), /^\[watch-no-report\].*state=gone/);
  assert.match(blockedNotice(common), /^\[watch-blocked\].*state=blocked/);
  assert.match(longRunningNotice({ ...common, minutes: 60 }), /^\[watch-long-running\].*still-running=60m/);
  assert.match(unavailableNotice({ ...common, error: 'permission denied' }), /^\[watch-unavailable\].*permission denied/);
});

test('spawn resolves the cwd workspace when it is run outside a Herdr pane', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-spawn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'checkout');
  const herdr = path.join(root, 'herdr');
  fs.mkdirSync(cwd);
  seedOwnedRun(path.join(root, '.org'), 'R-6');
  executable(herdr, `case "$1 $2" in
  "workspace list") printf '%s\\n' '{"result":{"workspaces":[{"workspace_id":"w-canonical","worktree":{"checkout_path":"${cwd}"}}]}}' ;;
  *) exit 2 ;;
esac`);
  const result = spawnSync(process.execPath, [
    WATCH, 'R-6', '--org', path.join(root, '.org'), '--herdr', herdr,
    '--cwd', cwd, '--spawn', '--dry-run',
  ], { encoding: 'utf8', env: { ...TEST_ENV, HERDR_WORKSPACE_ID: '' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /would create tab "watch R-6" in w-canonical/);
});

test('a valid report is checked and delivered without Herdr being present', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-'));
  seedOwnedRun(path.join(root, '.org'), 'R-7');
  const report = path.join(root, 'report.md');
  const calls = path.join(root, 'herdr-calls');
  const org = path.join(root, 'org');
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(report, `---\nrun: R-7\noutcome: done\nsummary: Work landed.\nheadline: The work landed\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  executable(org, `case "$1" in
  show) printf '%s\\n' '{"id":"R-7","item":"ENG-3","meta":{"agent":"lane-seven"},"report_path":"${report}","started":{"at":"2026-10-01T00:00:00.000Z"}}' ;;
  check) printf '%s\\n' 'ok: done · 0 blockers' ;;
  *) exit 2 ;;
esac`);
  executable(herdr, `printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"done"}}}' ;;
  "agent prompt") printf '%s\\n' '{"result":{"type":"agent_prompt"}}' ;;
  *) exit 2 ;;
esac`);
  const result = spawnSync(process.execPath, [
    WATCH, 'R-7', '--org', path.join(root, '.org'), '--org-cli', org, '--herdr', herdr, '--to', 'supervisor-test',
  ], { encoding: 'utf8', env: TEST_ENV });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sent = fs.readFileSync(calls, 'utf8');
  assert.match(sent, /agent prompt supervisor-test \[org-report\] run=R-7 item=ENG-3 outcome=done/);
  assert.match(sent, /headline="The work landed" check=pass/);
  // The transport owner may finish just after the foreground delivery receipt.
  // Let that owner release its own locks before removing this isolated fixture.
  await waitForInboxIdle(path.join(root, '.org/supervisor/inbox.log'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('an ingested report delivers once to the recorded recipient without consulting the worker or mutable file', async t => {
  for (const fileState of ['missing', 'invalid', 'rewritten']) {
    await t.test(fileState, async t => {
      const f = watcherFixture('R-941'), inbox = path.join(f.root, '.org/supervisor/inbox.log');
      t.after(async () => {
        await waitForInboxIdle(inbox);
        fs.rmSync(f.root, { recursive: true, force: true });
      });
      const report = { outcome: 'done', summary: 'Recorded completion.', headline: 'Recorded final headline',
        extra: { verdict: 'NEEDS-WORK' } };
      fs.appendFileSync(path.join(f.root, '.org/events.jsonl'), JSON.stringify({
        type: 'report.ingested', seq: 3, run: 'R-941', report,
      }) + '\n');
      if (fileState !== 'missing') fs.writeFileSync(f.report, fileState === 'invalid'
        ? 'Incomplete report' : reportText('R-941', 'Unrecorded rewrite'));
      // Worker reads and report checks must be unnecessary after ingestion.
      executable(f.org, `case "$1" in
  show) printf '%s\\n' '${JSON.stringify({ id: 'R-941', item: 'ENG-9', meta: { agent: 'lane-nine' }, report_path: f.report })}' ;;
  *) exit 2 ;;
esac`);
      executable(f.herdr, `printf '%s\\n' "$*" >> '${f.calls}'
case "$1 $2" in
  "agent prompt") printf '%s\\n' '{}' ;;
  *) exit 2 ;;
esac`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await waitForExit(startWatcher(t, f.args));
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /final notice confirmed from its ingested report/);
      }
      const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n');
      const prompts = calls.filter(call => call.startsWith('agent prompt '));
      assert.equal(prompts.length, 1, calls.join('\n'));
      assert.ok(calls.every(call => !call.startsWith('agent get lane-nine')), calls.join('\n'));
      assert.equal(prompts[0], `agent prompt supervisor-test ${reportNotice({ run: 'R-941', item: 'ENG-9',
        outcome: 'done', headline: report.headline, report: f.report, check: 'pass' })} notice-id=watch:R-941:final`);
      const entries = readInbox(inbox);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].to, 'supervisor-test');
      assert.equal(entries[0].state, 'sent');
    });
  }
});

test('a watcher preserves worker recipients through ingested-report delivery and restart', async t => {
  for (const recipient of ['lane-nine', 'fake:worker-pane']) {
    await t.test(recipient, async t => {
      const f = watcherFixture('R-942'), inbox = path.join(f.root, '.org/supervisor/inbox.log');
      t.after(async () => {
        await waitForInboxIdle(inbox);
        fs.rmSync(f.root, { recursive: true, force: true });
      });
      const report = { outcome: 'done', summary: 'Done.', headline: 'Worker completion' };
      fs.appendFileSync(path.join(f.root, '.org/events.jsonl'), JSON.stringify({
        type: 'report.ingested', seq: 3, run: 'R-942', report,
      }) + '\n');
      executable(f.org, `case "$1" in
  show) printf '%s\\n' '${JSON.stringify({ id: 'R-942', item: 'ENG-9',
    meta: { agent: 'lane-nine', pane: 'fake:worker-pane' }, report_path: f.report })}' ;;
  *) exit 2 ;;
esac`);
      executable(f.herdr, `printf '%s\\n' "$*" >> '${f.calls}'
case "$1 $2" in
  "agent get") test "$3" = '${recipient}' || exit 2
    printf '%s\\n' '{"result":{"agent":{"name":"lane-nine","agent":"claude","agent_status":"idle","pane_id":"fake:worker-pane","terminal_id":"fake:worker-terminal"}}}' ;;
  "agent prompt") printf '%s\\n' '{}' ;;
  *) exit 2 ;;
esac`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await waitForExit(startWatcher(t, [...f.args, '--to', recipient]));
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /final notice confirmed from its ingested report/);
      }
      const prompts = fs.readFileSync(f.calls, 'utf8').trim().split('\n')
        .filter(call => call.startsWith('agent prompt '));
      assert.deepEqual(prompts, [`agent prompt ${recipient} ${reportNotice({ run: 'R-942', item: 'ENG-9',
        outcome: report.outcome, headline: report.headline, report: f.report, check: 'pass' })} notice-id=watch:R-942:final`]);
      const entries = readInbox(inbox);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].to, recipient);
      assert.equal(entries[0].state, 'sent');
    });
  }
});

test('watch shadow uses the checked review verdict and scope while preserving the final tag', async t => {
  for (const [suffix, extra, route] of [['1', 'verdict: PASS', 'triage'], ['2', 'verdict: NEEDS-WORK', 'supervisor'], ['3', 'review_scope: deferred', 'supervisor'], ['4', 'verdict:\n  toString: inert-data', 'unknown']]) {
    const run = `R-99${suffix}`, f = watcherFixture(run);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(f.root, '.org'), { recursive: true });
    fs.writeFileSync(f.report, reportText(run).replace('outcome: done', `outcome: done\n${extra}`));
    executable(f.herdr, `printf '%s\\n' "$*" >> '${f.calls}'
case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"done"}}}' ;;
  "agent prompt") printf '%s\\n' '{"result":{}}' ;;
  *) exit 2 ;;
esac`);
    const root = path.join(fs.realpathSync(f.root), 'shadow');
    const child = spawnChild(t, process.execPath, f.args, { env: { ...TEST_ENV, BRAIN_SHADOW_ROOT: root, BRAIN_IDENTITY: 'example' } });
    const done = await waitForExit(child); assert.equal(done.code, 0, done.stderr);
    const text = reportNotice({ run, item: 'ENG-9', outcome: 'done', headline: 'The report arrived', report: f.report });
    await t.test(`shadow mirror for ${run}`, async t => {
      if (!hasGitCheckout) {
        t.skip('release snapshots have no product .git entry; shadow mirroring requires a Git identity');
        return;
      }
      const directory = stateDirectory({ root, identity: 'example', commonDir: gitProject().identity });
      const { entries } = await readJournal(directory);
      assert.equal(entries.length, 1, done.stderr); assert.equal(entries[0].shadow.path, route);
      assert.equal(entries[0].payload.evidence.validated, true);
      assert.equal(entries[0].run, run); assert.equal(entries[0].payload.refs[0].orgRef, fs.realpathSync(path.join(f.root, '.org')));
      assert.equal(fs.readFileSync(entries[0].payload.body_ref.path, 'utf8'), text);
    });
    assert.ok(fs.readFileSync(f.calls, 'utf8').includes(`agent prompt supervisor-test ${text} notice-id=watch:${run}:final`));
  }
});

test('final watch notice waits for fake operator typing, then sends once across watcher restart', async (t) => {
  const f = watcherFixture('R-125');
  t.after(async () => {
    await waitForInboxIdle(path.join(f.root, '.org/supervisor/inbox.log'));
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const screen = path.join(f.root, 'composer');
  const inbox = path.join(f.root, '.org/supervisor/inbox.log');
  fs.writeFileSync(f.report, reportText('R-125'));
  fs.writeFileSync(screen, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url)));
  // This fake bypasses executable()'s default empty supervisor fixture.
  fs.writeFileSync(f.herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)},JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get') console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake:supervisor',terminal_id:'fake:supervisor-terminal'}}}));
else if(a[0]==='pane'&&a[1]==='read') process.stdout.write(fs.readFileSync(${JSON.stringify(screen)},'utf8'));
else console.log('{}');\n`, { mode: 0o755 });
  const child = startWatcher(t, f.args);
  await waitForText(f.calls, /notification/);
  assert.equal(readInbox(inbox)[0].state, 'pending');
  assert.doesNotMatch(fs.readFileSync(f.calls, 'utf8'), /"prompt"/);
  fs.writeFileSync(screen, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url)));
  assert.equal((await waitForExit(child)).code, 0);
  fs.appendFileSync(path.join(f.root, '.org/events.jsonl'), JSON.stringify({
    type: 'report.ingested', seq: 3, run: 'R-125', report: {
      outcome: 'done', summary: 'Report arrived.', headline: 'The report arrived',
    },
  }) + '\n');
  assert.equal((await waitForExit(startWatcher(t, f.args))).code, 0);
  const prompts = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args[1] === 'prompt');
  assert.equal(prompts.length, 1); assert.match(prompts[0][3], /^\[org-report\] run=R-125 /);
  assert.equal(readInbox(inbox).length, 1);
});
test('a capped final watcher exits while its owned notice later delivers without another watcher', async (t) => {
  const f = watcherFixture('R-132'), screen = path.join(f.root, 'composer');
  const inbox = path.join(f.root, '.org/supervisor/inbox.log');
  const empty = fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url));
  t.after(async () => {
    fs.writeFileSync(screen, empty); await waitForInboxIdle(inbox);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  fs.writeFileSync(f.report, reportText('R-132'));
  fs.writeFileSync(screen, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url)));
  fs.writeFileSync(f.herdr, `#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)},JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get') console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake:supervisor',terminal_id:'fake:supervisor-terminal'}}}));
else if(a[0]==='pane'&&a[1]==='read') process.stdout.write(fs.readFileSync(${JSON.stringify(screen)},'utf8'));
else console.log('{}');\n`, { mode: 0o755 });
  const child = spawnChild(t, process.execPath, f.args, { env: { ...TEST_ENV, SUPERVISOR_INPUT_WAIT_SECONDS: '0' } });
  assert.equal((await waitForExit(child)).code, 1);
  assert.equal(readInbox(inbox)[0].state, 'pending');
  assert.doesNotMatch(fs.readFileSync(f.calls, 'utf8'), /"prompt"/);
  fs.writeFileSync(screen, empty);
  await waitForText(inbox, /"type":"sent"/);
  const prompts = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args[1] === 'prompt');
  assert.equal(prompts.length, 1); assert.match(prompts[0][3], /notice-id=watch:R-132:final$/);
});

test('a report landing wakes the watcher without polling Herdr', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-landing-'));
  seedOwnedRun(path.join(root, '.org'), 'R-8');
  if (!await requireFileWatch(t, root)) return;
  const report = path.join(root, 'report.md');
  const calls = path.join(root, 'herdr-calls');
  const state = path.join(root, 'worker-state');
  const waits = path.join(root, 'waits');
  const checks = path.join(root, 'checks');
  const org = path.join(root, 'org');
  const herdr = path.join(root, 'herdr');
  const started = new Date().toISOString();
  fs.writeFileSync(state, 'working');
  executable(org, `case "$1" in
  show) printf '%s\\n' '{"id":"R-8","item":"ENG-4","meta":{"agent":"lane-eight"},"report_path":"${report}","started":{"at":"${started}"}}' ;;
  check) cat '${report}' >> '${checks}'; printf '%s\\n' 'ok: done · 0 blockers' ;;
  *) exit 2 ;;
esac`);
  executable(herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") printf yes >> '${waits}'; while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${calls}" ;;
  *) exit 2 ;;
esac`);
  const child = spawnChild(t, process.execPath, [
    WATCH, 'R-8', '--org', path.join(root, '.org'), '--org-cli', org, '--herdr', herdr, '--to', 'supervisor-test',
  ], { env: TEST_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForText(waits, /yes/);
  fs.writeFileSync(report, reportText('R-8', 'Draft report'));
  await waitForText(checks, /Draft report/);
  const afterDraft = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  fs.writeFileSync(report, reportText('R-8', 'Final report'));
  await waitForText(checks, /Final report/);
  const afterFinal = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(afterDraft, /\[org-report\]/, 'a valid report is not delivered while the worker is working');
  assert.doesNotMatch(afterFinal, /\[org-report\]/, 'a rewritten valid report still waits for the worker to stop');
  const sent = fs.readFileSync(calls, 'utf8');
  assert.match(sent, /\[org-report\] run=R-8 item=ENG-4.*headline="Final report"/);
  assert.doesNotMatch(sent, /Draft report/);
});

test('a valid report also waits while the worker state is unknown', async (t) => {
  const fixture = watcherFixture('R-17');
  t.after(async () => {
    await waitForInboxIdle(path.join(fixture.root, '.org/supervisor/inbox.log'));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const state = path.join(fixture.root, 'worker-state');
  const waits = path.join(fixture.root, 'waits');
  fs.writeFileSync(fixture.report, reportText('R-17'));
  fs.writeFileSync(state, 'unknown');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") printf yes >> '${waits}'; while [ "$(cat '${state}')" = unknown ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; printf '%s\\n' '{"result":{}}' ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher(t, fixture.args);
  await waitForText(waits, /yes/);
  assert.equal(fs.existsSync(fixture.calls), false, 'an unknown worker is not treated as stopped');
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[org-report\] run=R-17/);
});

test('a mismatched report is invalid even when org check passes', async (t) => {
  const fixture = watcherFixture('R-9');
  t.after(async () => {
    await waitForInboxIdle(path.join(fixture.root, '.org/supervisor/inbox.log'));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  fs.writeFileSync(fixture.report, reportText('R-99', 'Stale report'));
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"done"}}}' ;;
  "agent wait") exec sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-invalid-report*) "${fixture.writer}" ;; esac; printf '%s\\n' '{"result":{}}' ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, [...fixture.args, '--start-grace', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-invalid-report\].*report run R-99 does not match watched run R-9/);
  assert.match(calls, /\[org-report\] run=R-9/);
});

test('a vanished worker delivers exited-without-report and stops', async (t) => {
  const fixture = watcherFixture('R-10');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"error":{"code":"agent_not_found","message":"gone"}}' >&2; exit 1 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, [...fixture.args, '--start-grace', '0']));
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[watch-no-report\].*state=gone/);
});

test('an initially idle worker is not terminal until it has worked', async (t) => {
  const fixture = watcherFixture('R-11');
  const counter = path.join(fixture.root, 'gets');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") n=$(($(cat "${counter}" 2>/dev/null || echo 0)+1)); printf '%s' "$n" > "${counter}"; case "$n" in 1) state=idle ;; 2) state=working ;; *) state=idle ;; esac; printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$state" ;;
  "agent wait") exit 0 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-no-report*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, [...fixture.args, '--start-grace', '10']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.equal((calls.match(/\[watch-no-report\]/g) ?? []).length, 1, calls);
  assert.match(calls, /\[org-report\] run=R-11/);
});

test('idle grace waits for a late report before sending a no-report notice', async (t) => {
  const fixture = watcherFixture('R-19');
  const state = path.join(fixture.root, 'worker-state');
  const waitStarted = path.join(fixture.root, 'wait-started');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") printf 'state=%s\\n' "$(cat '${state}')" >> "${waitStarted}"; case " $* " in
    *" --until working "*) while [ "$(cat '${state}')" != working ]; do sleep 0.02; done ;;
    *) while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  esac ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher(t, [...fixture.args, '--idle-grace', '1']);
  await waitForText(waitStarted, /state=working/);
  fs.writeFileSync(state, 'idle');
  await waitForText(waitStarted, /state=idle/);
  assert.equal(fs.existsSync(fixture.calls), false, 'idle grace suppresses the early no-report notice');
  fs.writeFileSync(fixture.report, reportText('R-19', 'Late final report'));
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[org-report\] run=R-19.*headline="Late final report"/);
  assert.doesNotMatch(calls, /\[watch-no-report\]/);
  assert.match(result.stdout, /waiting up to 1s .* report or resume/);
});

test('idle grace does not start before the worker has been seen working', async (t) => {
  const fixture = watcherFixture('R-20');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"idle"}}}' ;;
  "agent wait") exec sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-no-report*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, [
    ...fixture.args, '--start-grace', '0', '--idle-grace', '10',
  ]));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-no-report\].*state=idle/);
  assert.match(calls, /\[org-report\] run=R-20/);
  assert.doesNotMatch(result.stdout, /report or resume before sending a no-report notice/);
});

test('idle grace notices a blocked worker immediately and keeps watching', async (t) => {
  const fixture = watcherFixture('R-21');
  const state = path.join(fixture.root, 'worker-state');
  const waits = path.join(fixture.root, 'waits');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait")
    printf '%s state=%s\\n' "$*" "$(cat '${state}')" >> "${waits}"
    while :; do
      current=$(cat '${state}')
      case " $* " in *" --until $current "*) exit 0 ;; esac
      sleep 0.02
    done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher(t, [...fixture.args, '--idle-grace', '10']);
  await waitForText(waits, /state=working/);
  fs.writeFileSync(state, 'idle');
  await waitForText(waits, /state=idle/);
  fs.writeFileSync(state, 'blocked');
  const blockedCalls = await waitForText(fixture.calls, /\[watch-blocked\]/);
  assert.doesNotMatch(blockedCalls, /\[watch-no-report\]|\[org-report\]/);
  assert.equal(child.exitCode, null, 'a blocked worker remains watched');
  fs.writeFileSync(fixture.report, reportText('R-21', 'Finished after grace block'));
  await waitForText(waits, /state=blocked/);
  assert.doesNotMatch(fs.readFileSync(fixture.calls, 'utf8'), /\[org-report\]/,
    'a valid report stays intermediate while the worker is blocked');
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.equal((calls.match(/\[watch-blocked\]/g) ?? []).length, 1, calls);
  assert.doesNotMatch(calls, /\[watch-no-report\]/);
  assert.match(calls, /\[org-report\] run=R-21.*headline="Finished after grace block"/);
});

test('idle, working, idle without a report delivers both stop notices', async (t) => {
  const fixture = watcherFixture('R-12');
  const counter = path.join(fixture.root, 'gets');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") n=$(($(cat "${counter}" 2>/dev/null || echo 0)+1)); printf '%s' "$n" > "${counter}"; case "$n" in 1|3) state=working ;; *) state=idle ;; esac; printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$state" ;;
  "agent wait") exit 0 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-no-report*) n=$(grep -c watch-no-report "${fixture.calls}"); [ "$n" -eq 2 ] && "${fixture.writer}"; : ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, fixture.args));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.equal((calls.match(/\[watch-no-report\]/g) ?? []).length, 2, calls);
  assert.match(calls, /\[org-report\] run=R-12/);
});

test('a blocked worker delivers its distinct notice', async (t) => {
  const fixture = watcherFixture('R-13');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'blocked');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = blocked ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-blocked*) "${fixture.writer}"; printf '%s' idle > '${state}' ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, [...fixture.args, '--start-grace', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[watch-blocked\].*state=blocked/);
});

test('a valid report stays intermediate while blocked and is final only after idle', async (t) => {
  const fixture = watcherFixture('R-18');
  t.after(async () => {
    await waitForInboxIdle(path.join(fixture.root, '.org/supervisor/inbox.log'));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(fixture.report, reportText('R-18', 'Finished after unblocking'));
  fs.writeFileSync(state, 'blocked');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = blocked ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; printf '%s\\n' '{"result":{}}' ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher(t, [...fixture.args, '--start-grace', '0']);
  const whileBlocked = await waitForText(fixture.calls, /\[watch-blocked\]/);
  assert.doesNotMatch(whileBlocked, /\[org-report\]/);
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.ok(calls.indexOf('[watch-blocked]') < calls.indexOf('[org-report]'), calls);
  assert.match(calls, /\[org-report\] run=R-18.*headline="Finished after unblocking"/);
});

test('a refused intermediate delivery stays first in the inbox and recovers before the final report', async (t) => {
  const fixture = watcherFixture('R-16');
  t.after(async () => {
    await waitForInboxIdle(path.join(fixture.root, '.org/supervisor/inbox.log'));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'blocked');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") exec sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-blocked*)
    if [ ! -f '${fixture.root}/refused' ]; then printf yes > '${fixture.root}/refused'; printf '%s\\n' '{"error":{"code":"agent_blocked"}}' >&2; exit 1; fi ;; esac; printf '%s\\n' '{"result":{}}' ;;
  "notification show") printf '%s\\n' "$*" >> "${fixture.calls}"; "${fixture.writer}"; printf '%s' idle > '${state}' ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, [
    ...fixture.args, '--start-grace', '0', '--delivery-attempts', '1',
  ]));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /agent prompt supervisor-test \[watch-blocked\]/);
  assert.match(calls, /notification show R-16 watch could not deliver/);
  assert.match(calls, /agent prompt supervisor-test \[org-report\] run=R-16/);
});

test('a still-working worker delivers the long-running notice', async (t) => {
  const fixture = watcherFixture('R-14');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-long-running*) "${fixture.writer}"; printf '%s' idle > '${state}' ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, [...fixture.args, '--long-after', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-long-running\].*still-running=/);
  assert.ok(calls.indexOf('[watch-long-running]') < calls.indexOf('[org-report]'), calls);
});

test('a capped long-running notice keeps one owned ID and payload across minutes and watcher restarts', async (t) => {
  const f = watcherFixture('R-135');
  const inbox = path.join(f.root, '.org/supervisor/inbox.log');
  const screen = path.join(f.root, 'composer'), state = path.join(f.root, 'worker-state');
  const offset = path.join(f.root, 'clock-offset'), wake = path.join(f.root, 'wake');
  const abandoned = path.join(f.root, 'abandoned'), clock = path.join(f.root, 'clock.mjs');
  const empty = fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url));
  const children = [];
  const until = async (predicate) => {
    const deadline = Date.now() + loadTimeout(10_000);
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for watcher fixture');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const waits = () => fs.readdirSync(f.root).filter((name) => name.startsWith('wait-'));
  t.after(async () => {
    fs.writeFileSync(abandoned, 'yes'); fs.writeFileSync(state, 'idle'); fs.writeFileSync(screen, empty);
    await Promise.all(children.map(waitForExit));
    await until(() => waits().length === 0);
    await waitForInboxIdle(inbox);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  fs.writeFileSync(state, 'working'); fs.writeFileSync(offset, '120000');
  fs.writeFileSync(screen, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url)));
  fs.writeFileSync(clock, `import fs from 'node:fs'; const now=Date.now;
Date.now=()=>now()+Number(fs.readFileSync(${JSON.stringify(offset)},'utf8'));\n`);
  const started = new Date().toISOString();
  fs.writeFileSync(f.org, `#!${process.execPath}\nimport fs from 'node:fs';
console.log(JSON.stringify({id:'R-135',item:'ENG-9',meta:{agent:'lane-nine'},report_path:${JSON.stringify(f.report)},
started:{at:${JSON.stringify(started)}},abandoned:fs.existsSync(${JSON.stringify(abandoned)})}));\n`);
  fs.writeFileSync(f.herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const a=process.argv.slice(2);
const state=${JSON.stringify(state)},wake=${JSON.stringify(wake)},marker=${JSON.stringify(f.root + '/wait-')}+process.pid;
if(a[0]==='agent'&&a[1]==='wait') {
  fs.writeFileSync(marker,'waiting');
  process.once('SIGTERM',()=>{fs.rmSync(marker,{force:true});process.exit(0);});
}
fs.appendFileSync(${JSON.stringify(f.calls)},JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get') console.log(JSON.stringify({result:{agent:a[2]==='supervisor-test'
  ? {agent:'claude',agent_status:'idle',pane_id:'fake:supervisor',terminal_id:'fake:supervisor-terminal'} : {agent_status:fs.readFileSync(state,'utf8')}}}));
else if(a[0]==='pane'&&a[1]==='read') process.stdout.write(fs.readFileSync(${JSON.stringify(screen)},'utf8'));
else if(a[0]==='agent'&&a[1]==='wait') {
  while(fs.readFileSync(state,'utf8')==='working'&&!fs.existsSync(wake)) await new Promise(r=>setTimeout(r,20));
  fs.rmSync(wake,{force:true});fs.rmSync(marker,{force:true});console.log('{}');
} else console.log('{}');\n`, { mode: 0o755 });
  const calls = () => fs.existsSync(f.calls) ? fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const waitCount = () => calls().filter((a) => a[1] === 'wait').length;
  const prompts = () => calls().filter((a) => a[1] === 'prompt');
  const start = () => {
    const child = spawnChild(t, process.execPath, ['--import', clock, ...f.args, '--long-after', '0', '--retry-after', '0.05'],
      { env: { ...TEST_ENV, SUPERVISOR_INPUT_WAIT_SECONDS: '0' } });
    children.push(child); return child;
  };
  const first = start();
  await until(() => waitCount() >= 1);
  const original = readInbox(inbox)[0];
  assert.equal(original.state, 'pending'); assert.ok(original.owner_pid > 0);
  assert.equal(original.id, 'watch:R-135:long-running');
  assert.match(original.message, /still-running=2m$/); assert.equal(prompts().length, 0);
  const count = waitCount();
  fs.writeFileSync(offset, '240000'); fs.writeFileSync(wake, 'yes');
  await until(() => waitCount() > count);
  assert.equal(readInbox(inbox).length, 1, 'owned handoff must disarm long-notice retries');
  first.kill('SIGTERM');
  const stopped = await waitForExit(first);
  assert.equal(stopped.signal, 'SIGTERM');
  assert.equal(stopped.stdout.match(/\[watch-long-running\]/g)?.length, 1);
  assert.doesNotMatch(stopped.stdout, /could not deliver/);
  fs.writeFileSync(state, 'idle'); await until(() => waits().length === 0); fs.writeFileSync(state, 'working');
  const restartCount = waitCount();
  const second = start(); await until(() => waitCount() > restartCount);
  assert.equal(readInbox(inbox).length, 1, 'restart must adopt the journaled long-running notice');
  assert.equal(readInbox(inbox)[0].id, original.id); assert.equal(readInbox(inbox)[0].message, original.message);
  assert.equal(prompts().length, 0);
  fs.writeFileSync(screen, empty); await waitForText(inbox, /"type":"sent"/);
  assert.equal(prompts().length, 1); assert.equal(prompts()[0][3], `${original.message} notice-id=${original.id}`);
  const deliveredCount = waitCount();
  fs.writeFileSync(offset, '360000'); fs.writeFileSync(wake, 'yes');
  await until(() => waitCount() > deliveredCount);
  assert.equal(readInbox(inbox).length, 1); assert.equal(prompts().length, 1);
  fs.writeFileSync(abandoned, 'yes'); fs.writeFileSync(wake, 'yes');
  const finished = await waitForExit(second);
  assert.equal(finished.code, 0, finished.stdout + finished.stderr);
  assert.equal(finished.stdout.match(/\[watch-long-running\]/g)?.length, 1);
  assert.doesNotMatch(finished.stdout, /could not deliver/);
});

test('a Herdr outage is delivered after Herdr recovers, never reported as gone', async (t) => {
  const fixture = watcherFixture('R-15');
  const counter = path.join(fixture.root, 'gets');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") n=$(($(cat "${counter}" 2>/dev/null || echo 0)+1)); printf '%s' "$n" > "${counter}"; if [ "$n" -eq 1 ]; then printf '%s\\n' '{"error":{"code":"socket_unavailable","message":"server down"}}' >&2; exit 1; fi; printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-unavailable*) "${fixture.writer}"; printf '%s' idle > '${state}' ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(t, fixture.args));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-unavailable\].*socket_unavailable.*server down/);
  assert.doesNotMatch(calls, /\[watch-no-report\]/);
});
