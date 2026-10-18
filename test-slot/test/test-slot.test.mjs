import { provingRun } from './helpers/proving.mjs';
// Ported ENG-725 regressions: the host-wide test slot. Every case uses its own lock path, never the real one, and scrubs the slot's
// environment, so these tests run the same inside a held slot (the full gate) as outside it. They use the non-setuid kernel process source.
import assert from "node:assert/strict";
import { loadTimeout } from "../../lib/deadline.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it as nodeIt } from "node:test";
const it = (name, body) => nodeIt(name, { timeout: loadTimeout(30000) }, body);
import { fileURLToPath } from "node:url";
import { testSlotEnvironment } from "../../test/helpers/test-slot-env.mjs";

import { lookupProcess } from "../../lib/processes.mjs";
import { acquireTestSlot, holderState, PATH_ENV, COMPAT_PATH_ENV, LEGACY_TOKEN_ENV, LEGACY_WAIT_ENV, HELD_CODE, HOLDER_UNKNOWN_CODE, REFUSED_EXIT, TEST_SLOT_PATH, TOKEN_ENV, WAIT_ENV, RETRIED_ENV } from "../test-slot.mjs";

const CLI = fileURLToPath(new URL("../test-slot.mjs", import.meta.url));
const MODULE = new URL("../test-slot.mjs", import.meta.url).href;
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ENV = testSlotEnvironment();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dirs = [];
const children = [];
const readies = [];
// Every command a case starts is killed afterwards, with its group, even when a regression leaves it orphaned: an
// orphan holding the runner's inherited stdout would otherwise keep this test process from exiting.
afterEach(() => {
  for (const child of children.splice(0)) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
  for (const ready of readies.splice(0)) {
    let pid;
    try { pid = Number(fs.readFileSync(ready, "utf8")); } catch { continue; }
    let command = "";
    try { command = lookupProcess(pid).value?.command ?? ''; } catch { continue; }
    if (!command.includes(ready)) continue; // not ours: the pid has gone and been reissued
    for (const target of [-pid, pid]) { try { process.kill(target, "SIGKILL"); } catch { /* gone */ } }
  }
});
after(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-slot-"));
  dirs.push(dir);
  return { dir, lockPath: path.join(dir, "slot.lock"), file: (name) => path.join(dir, name) };
}

/** A node one-liner as a command: writes its pid to `ready`, then runs `body`. */
const nodeCommand = (ready, body = "setInterval(() => {}, 1000);") => {
  readies.push(ready);
  return [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ready + ".tmp")}, String(process.pid));require("fs").renameSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)}); ${body}`];
};

/** Starts the CLI; resolves `done` with its exit code and stderr. */
function cli(args, { env = ENV } = {}) {
  const child = spawn(process.execPath, [CLI, ...provingRun(args)], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const done = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

async function until(test, what, ms = 10_000) {
  const deadline = Date.now() + loadTimeout(ms);
  while (Date.now() < deadline) { if (test()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}
const readLock = (lockPath) => JSON.parse(fs.readFileSync(lockPath, "utf8"));
const exists = (target) => { try { process.kill(target, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };

/** A CLI run that holds the slot at `lockPath` with a command that runs until killed; resolves once the group is recorded. */
async function holder(s, label = "first", extra = [], env = ENV) {
  const ready = s.file(`${label}.ready`);
  const run = cli(["run", label, "--lock-path", s.lockPath, ...extra, "--", ...nodeCommand(ready)], { env });
  await until(() => fs.existsSync(ready) && fs.existsSync(s.lockPath) && readLock(s.lockPath).groupStart !== null, `${label} to hold the slot`);
  return { ...run, commandPid: Number(fs.readFileSync(ready, "utf8")), record: readLock(s.lockPath) };
}

// Pin the holder's environment so these controls fire even when the parent already runs in UTC or another locale.
const HOLDER_ENV = { ...ENV, TZ: "America/Chicago", LANG: "en_US.UTF-8" };
delete HOLDER_ENV.LC_ALL;
delete HOLDER_ENV.LC_TIME;
const ENV_CASES = [
  ["same environment control", {}],
  ["TZ=UTC", { TZ: "UTC" }],
  ["TZ=Asia/Tokyo", { TZ: "Asia/Tokyo" }],
  ["LC_ALL=fr_FR.UTF-8", { LC_ALL: "fr_FR.UTF-8" }],
  ["LC_TIME=de_DE.UTF-8", { LC_TIME: "de_DE.UTF-8" }],
];

describe("environment-independent holder identity (REV-378 I1)", () => {
  for (const [name, change] of ENV_CASES) {
    for (const orphan of [false, true]) {
      it(`refuses ${name} with a live ${orphan ? "orphaned command group" : "runner"}`, async (t) => {
        const s = scratch();
        const first = await holder(s, "first", [], HOLDER_ENV);
        if (orphan) { first.child.kill("SIGKILL"); await first.done; }
        const before = fs.readFileSync(s.lockPath, "utf8");
        const marker = s.file("environment-taker.ran");
        const env = { ...HOLDER_ENV, ...change };
        const status = await cli(["status", "--lock-path", s.lockPath], { env }).done;
        const second = await cli(["run", "environment-taker", "--lock-path", s.lockPath, "--", ...nodeCommand(marker, "")], { env }).done;
        t.diagnostic(JSON.stringify({ environment: name, orphan, holder_live: exists(orphan ? first.commandPid : first.child.pid), status_raw_exit: status.code, taker_raw_exit: second.code, command_started: fs.existsSync(marker), record_unchanged: fs.existsSync(s.lockPath) && fs.readFileSync(s.lockPath, "utf8") === before }));
        assert.equal(exists(orphan ? first.commandPid : first.child.pid), true, "the holder is still live after the taker finishes");
        assert.equal(status.code, 1, status.stdout);
        assert.equal(JSON.parse(status.stdout).state, "live");
        assert.equal(second.code, REFUSED_EXIT, second.stderr);
        assert.match(second.stderr, /^TEST_SLOT_HELD:/u);
        assert.equal(fs.existsSync(marker), false, "the refused command never starts");
        assert.equal(fs.readFileSync(s.lockPath, "utf8"), before, "the live holder's record is unchanged");
      });
    }
  }

  it("refuses a live holder's legacy environment-dependent start identity", async () => {
    const s = scratch();
    const first = await holder(s);
    const legacy = { ...first.record, processStart: first.record.processStart.replace(/^ps-utc-c:/u, "") };
    fs.writeFileSync(s.lockPath, JSON.stringify(legacy));
    const before = fs.readFileSync(s.lockPath, "utf8");
    const second = await cli(["run", "legacy-taker", "--lock-path", s.lockPath, "--", process.execPath, "-e", ""]).done;
    assert.equal(second.code, REFUSED_EXIT);
    assert.match(second.stderr, /TEST_SLOT_HOLDER_UNKNOWN:.*environment-dependent start time/u);
    assert.equal(fs.readFileSync(s.lockPath, "utf8"), before);
  });
});

describe("serialized stale takeover (REV-378 I2)", () => {
  it("never admits two takers when one is paused between comparing and deleting the stale record", async (t) => {
    const s = scratch();
    const paused = s.file("paused"); const resume = s.file("resume"); const held = s.file("held");
    fs.writeFileSync(s.lockPath, JSON.stringify({ pid: 999_999, pgid: null, token: "stale", label: "stale" }));
    const script = `import fs from "node:fs";
      const remove = fs.rmSync;
      fs.rmSync = (p, ...args) => {
        if (p === ${JSON.stringify(s.lockPath)}) {
          fs.writeFileSync(${JSON.stringify(paused)}, "paused");
          const deadline = Date.now() + ${loadTimeout(15000)};
          while (!fs.existsSync(${JSON.stringify(resume)})) {
            if (Date.now() > deadline) throw new Error("takeover pause timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return remove(p, ...args);
      };
      const { acquireTestSlot } = await import(${JSON.stringify(MODULE)});
      const slot = await acquireTestSlot("paused-taker", { lockPath: ${JSON.stringify(s.lockPath)}, waitSeconds: 0 });
      fs.writeFileSync(${JSON.stringify(held + '.tmp')}, JSON.stringify({ nested: slot.nested, token: slot.token }));
      fs.renameSync(${JSON.stringify(held + '.tmp')}, ${JSON.stringify(held)});
      setInterval(() => {}, 1000);`;
    const first = spawn(process.execPath, ["--input-type=module", "-e", script], { env: ENV, stdio: ["ignore", "ignore", "inherit"] });
    children.push(first);
    try {
      await until(() => fs.existsSync(paused), "the stale remover to pause");
      const marker = s.file("other-taker.ran");
      const second = cli(["run", "other-taker", "--lock-path", s.lockPath, "--", ...nodeCommand(marker)]);
      await until(() => fs.existsSync(marker) || second.child.exitCode !== null, "the competing taker to enter or refuse");
      fs.writeFileSync(resume, "resume");
      await until(() => fs.existsSync(held), "the paused taker to hold");
      t.diagnostic(JSON.stringify({ paused_taker_admitted: fs.existsSync(held), competing_taker_admitted: fs.existsSync(marker), competing_taker_raw_exit: second.child.exitCode }));
      assert.equal(fs.existsSync(marker), false, "two stale takers must never both be admitted");
      const refusal = await second.done;
      assert.equal(refusal.code, REFUSED_EXIT);
      assert.match(refusal.stderr, /^TEST_SLOT_HOLDER_UNKNOWN:.*cannot safely remove/u);
      assert.equal(JSON.parse(fs.readFileSync(held, "utf8")).nested, false);
      assert.equal(readLock(s.lockPath).pid, first.pid);
      assert.equal(fs.existsSync(`${s.lockPath}.takeover`), false, "normal takeover releases its guard");
      const third = await cli(["run", "third", "--lock-path", s.lockPath, "--", process.execPath, "-e", ""]).done;
      assert.equal(third.code, REFUSED_EXIT);
      assert.match(third.stderr, /^TEST_SLOT_HELD:/u);
    } finally { fs.writeFileSync(resume, "resume"); }
  });

  it("leaves a dead holder and an abandoned takeover guard in place, then recovers after operator cleanup", async () => {
    const s = scratch();
    const stale = JSON.stringify({ pid: 999_999, pgid: null, token: "stale", label: "stale" });
    fs.writeFileSync(s.lockPath, stale);
    fs.writeFileSync(`${s.lockPath}.takeover`, "abandoned");
    await assert.rejects(acquireTestSlot("taker", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 }), (e) => e.code === HOLDER_UNKNOWN_CODE);
    assert.equal(fs.readFileSync(s.lockPath, "utf8"), stale);
    assert.equal(fs.readFileSync(`${s.lockPath}.takeover`, "utf8"), "abandoned");
    fs.rmSync(`${s.lockPath}.takeover`);
    const slot = await acquireTestSlot("after-cleanup", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 });
    slot.release();
    assert.equal(fs.existsSync(s.lockPath), false);
  });
});

describe("two concurrent holders are refused", () => {
  it("refuses a second run by name, runs none of its command, and admits it once the first releases", async () => {
    const s = scratch();
    const first = await holder(s);
    assert.equal(first.record.pid, first.child.pid);
    assert.equal(first.record.pgid, first.commandPid, "the command leads its own recorded group");
    const before = fs.readFileSync(s.lockPath, "utf8");
    const marker = s.file("second.ran");
    const second = await cli(["run", "second", "--lock-path", s.lockPath, "--", ...nodeCommand(marker, "")]).done;
    assert.equal(second.code, REFUSED_EXIT);
    assert.match(second.stderr, new RegExp(`^${HELD_CODE}: second refused: first \\(pid ${String(first.child.pid)}, group ${String(first.commandPid)}, `, "u"));
    assert.equal(fs.existsSync(marker), false, "the refused run's command never started");
    assert.equal(fs.existsSync(`${s.lockPath}.queue`), false, "a zero-wait refusal creates no ticket");
    // The same refusal in-process, from the library a sim test file uses.
    await assert.rejects(acquireTestSlot("in-process", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 }), (e) => e.code === HELD_CODE);
    assert.equal(fs.readFileSync(s.lockPath, "utf8"), before, "a refusal leaves the holder's lock as it was");

    first.child.kill("SIGTERM");
    const ended = await first.done;
    assert.equal(ended.code, 128 + os.constants.signals.SIGTERM, "the forwarded SIGTERM ended the command, and its status is the runner's");
    assert.equal(fs.existsSync(s.lockPath), false, "released on exit");
    await until(() => !exists(-first.commandPid), "the command's group to exit");
    const retry = await cli(["run", "second", "--lock-path", s.lockPath, "--", ...nodeCommand(marker, "")]).done;
    assert.equal(retry.code, 0);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.existsSync(s.lockPath), false);
  });

  it("uses the existing bch-cloak host path by default", () => {
    assert.equal(TEST_SLOT_PATH, process.platform === "darwin" ? "/private/tmp/bch-cloak-test-slot.lock" : "/tmp/bch-cloak-test-slot.lock");
  });
});

describe("a dead holder is recovered", () => {
  it("keeps the slot while a SIGKILLed runner's command still runs, and recovers it once that group is gone", async () => {
    const s = scratch();
    const first = await holder(s);
    first.child.kill("SIGKILL");
    await first.done;
    assert.equal(exists(first.child.pid), false);
    assert.equal(exists(first.commandPid), true, "the command outlives its runner");
    const refused = await cli(["run", "second", "--lock-path", s.lockPath, "--", process.execPath, "-e", ""]).done;
    assert.equal(refused.code, REFUSED_EXIT);
    assert.match(refused.stderr, new RegExp(`^${HELD_CODE}: second refused: first `, "u"));

    const current = lookupProcess(first.commandPid);
    assert.ok(current.ok, current.error);
    assert.ok(current.value?.command.includes(s.file('first.ready')), 'the orphan is still our fixture');
    // The suite runner contains children in its own group; direct invocations
    // allow the product to detach. Signal the group only when this command is
    // its leader, and prove the actual orphan is gone in both environments.
    const target = current.value.pgid === first.commandPid ? -first.commandPid : first.commandPid;
    process.kill(target, "SIGKILL");
    await until(() => !exists(target), "the orphaned command to exit");
    assert.equal(exists(first.commandPid), false);
    const slot = await acquireTestSlot("recovered", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 });
    assert.equal(slot.nested, false);
    assert.equal(readLock(s.lockPath).label, "recovered");
    slot.release();
    assert.equal(fs.existsSync(s.lockPath), false);
  });

  it("takes over a record whose process and group are gone, or whose pid now belongs to another process", async () => {
    const s = scratch();
    const stale = (fields) => fs.writeFileSync(s.lockPath, JSON.stringify({ token: "t", label: "stale", cwd: "/", acquiredAt: "then", processStart: "ps-utc-c:Thu Jan  1 00:00:00 1970", pgid: null, groupStart: null, ...fields }));
    for (const fields of [
      { pid: 999_999 },                                                             // exited, no group recorded
      { pid: 999_999, pgid: 999_998, groupStart: "ps-utc-c:Thu Jan  1 00:00:00 1970" },      // exited, and so has its group
      { pid: 1 },                                                                   // pid reused by a root-owned process: another start time
      { pid: 999_999, pgid: 1, groupStart: "ps-utc-c:Thu Jan  1 00:00:00 1970" },           // group id reused by a root-owned process
      { pid: 999_999, pgid: process.pid, groupStart: "ps-utc-c:Thu Jan  1 00:00:00 1970" }, // group id reissued to another process
      { pid: process.pid },                                                         // this pid, from before this process started
    ]) {
      stale(fields);
      assert.equal(holderState(readLock(s.lockPath)).state, "gone", JSON.stringify(fields));
      const slot = await acquireTestSlot("taker", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 });
      assert.equal(slot.nested, false, JSON.stringify(fields));
      assert.equal(readLock(s.lockPath).token, slot.token);
      slot.release();
    }
    assert.equal(fs.existsSync(s.lockPath), false);
  });
});

describe("a waiter does not deadlock on itself", () => {
  for (const [name, scrub] of [["with the holder's token", false], ["with the token scrubbed from its environment", true]]) {
    it(`runs a waiting run started inside the holder's own command at once, ${name}`, async () => {
      const s = scratch();
      const marker = s.file("inner.ran");
      const afterInner = s.file("after-inner.json");
      const inner = [process.execPath, CLI, "run", "inner", "--lock-path", s.lockPath, "--wait", "30", "--", ...nodeCommand(marker, "")];
      // The outer command runs the inner run, then copies the lock as the inner run left it.
      const command = ["/bin/sh", "-c", `"$@" && cp '${s.lockPath}' '${afterInner}'`, "sh", ...(scrub ? ["/usr/bin/env", "-u", TOKEN_ENV] : []), ...inner];
      const started = Date.now();
      const outer = await cli(["run", "outer", "--lock-path", s.lockPath, "--", ...command]).done;
      assert.equal(outer.code, 0, outer.stderr);
      assert.equal(fs.existsSync(marker), true, "the inner command ran");
      assert.ok(Date.now() - started < loadTimeout(10_000), "no wait: the inner run is inside the slot");
      assert.equal(JSON.parse(fs.readFileSync(afterInner, "utf8")).label, "outer", "the inner run neither took nor released the outer run's lock");
      assert.equal(fs.existsSync(s.lockPath), false, "the outer run released it");
    });
  }

  it("runs a process that carries the holder's token inside the slot, even outside the holder's process tree", async () => {
    const s = scratch();
    const first = await holder(s);
    const marker = s.file("carried.ran");
    const carried = await cli(["run", "carried", "--lock-path", s.lockPath, "--", ...nodeCommand(marker, "")], { env: { ...ENV, [TOKEN_ENV]: first.record.token } }).done;
    assert.equal(carried.code, 0, carried.stderr);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(readLock(s.lockPath).token, first.record.token, "the holder's lock is untouched");
    const other = await cli(["run", "other", "--lock-path", s.lockPath, "--", process.execPath, "-e", ""], { env: { ...ENV, [TOKEN_ENV]: "not-the-holders" } }).done;
    assert.equal(other.code, REFUSED_EXIT, "any other token is no token");
  });

  it("never matches a waiter by its command line: a free slot is taken at once, a held one is refused by the holder's pid", async () => {
    const s = scratch();
    const patterns = ["pnpm validate:all-safe", "vitest run tools/pool-multiparty-sim"];
    const free = await cli(["run", ...patterns, "--lock-path", s.lockPath, "--", process.execPath, "-e", "", ...patterns]).done;
    assert.equal(free.code, 0, free.stderr);
    const first = await holder(s, "first", []);
    const refused = await cli(["run", "second", "--lock-path", s.lockPath, "--", process.execPath, "-e", "", ...patterns]).done;
    assert.equal(refused.code, REFUSED_EXIT);
    assert.match(refused.stderr, new RegExp(`\\(pid ${String(first.child.pid)}, `, "u"));
  });

  it("takes the slot again in the process that holds it without waiting or replacing it", async () => {
    const s = scratch();
    const outer = await acquireTestSlot("outer", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 });
    const again = await acquireTestSlot("again", { lockPath: s.lockPath, env: ENV, waitSeconds: 30, pollMs: 100 });
    assert.equal(again.nested, true);
    assert.equal(again.token, outer.token);
    again.release();
    assert.equal(readLock(s.lockPath).label, "outer");
    outer.release();
  });
});

describe('slot grant receipts', () => {
  const receipts = s => fs.readdirSync(s.dir).filter(name => name.endsWith('.json'));

  it('writes exactly one acquired receipt after waiting for a grant', async () => {
    const s = scratch();
    const first = await holder(s);
    const receipt = s.file('grant.json');
    const marker = s.file('granted.ran');
    const waiter = cli(['run', 'granted', '--lock-path', s.lockPath, '--wait', '30', '--poll-ms', '100',
      '--wait-receipt-path', receipt, '--', ...nodeCommand(marker, '')]);
    let waiting = false;
    waiter.child.stderr.on('data', data => { waiting ||= String(data).includes('TEST_SLOT_WAIT:'); });
    await until(() => waiting || waiter.child.exitCode !== null, 'the waiter to start');
    assert.equal(waiting, true, 'the runner is waiting for the held slot');
    assert.deepEqual(receipts(s), [], 'waiting is not a grant');
    first.child.kill('SIGTERM');
    await first.done;
    const done = await waiter.done;
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(receipts(s), ['grant.json']);
    const grant = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(grant.schema, 'test-slot-wait/v1');
    assert.equal(grant.state, 'acquired');
    assert.equal(grant.nested, false);
    assert.ok(Date.parse(grant.acquired_at) >= Date.parse(grant.started_at));
    assert.equal(grant.finished_at, grant.acquired_at);
    assert.ok(grant.waits.length > 0, 'the grant retains its wait evidence');
    assert.equal(fs.existsSync(marker), true);
  });

  for (const state of ['held', 'unknown']) {
    it(`writes no receipt when a ${state} slot refuses the run`, async () => {
      const s = scratch();
      if (state === 'held') await holder(s);
      else fs.writeFileSync(s.lockPath, 'unreadable holder');
      const marker = s.file('refused.ran');
      const done = await cli(['run', 'refused', '--lock-path', s.lockPath, '--wait', state === 'held' ? '1' : '0',
        '--poll-ms', '100', '--wait-receipt-path', s.file('grant.json'), '--', ...nodeCommand(marker, '')]).done;
      assert.equal(done.code, REFUSED_EXIT, done.stderr);
      assert.match(done.stderr, new RegExp(`${state === 'held' ? HELD_CODE : HOLDER_UNKNOWN_CODE}:`));
      assert.deepEqual(receipts(s), []);
      assert.equal(fs.existsSync(marker), false);
    });
  }
});

describe("waiting", () => {
  it("queues behind a live holder and takes the slot when it is released", async () => {
    const s = scratch();
    const first = await holder(s);
    const marker = s.file("waiter.ran");
    const waiter = cli(["run", "waiter", "--lock-path", s.lockPath, "--wait", "30", "--poll-ms", "100", "--", ...nodeCommand(marker, "")]);
    await sleep(500);
    assert.equal(fs.existsSync(marker), false, "still waiting");
    first.child.kill("SIGTERM");
    const done = await waiter.done;
    assert.equal(done.code, 0, done.stderr);
    assert.equal(fs.existsSync(marker), true);
  });

  it("refuses once its wait runs out", async () => {
    const s = scratch();
    await holder(s);
    const started = Date.now();
    const done = await cli(["run", "waiter", "--lock-path", s.lockPath, "--wait", "1", "--poll-ms", "100", "--", process.execPath, "-e", ""]).done;
    assert.equal(done.code, REFUSED_EXIT);
    assert.match(done.stderr, new RegExp(`^${HELD_CODE}: waiter refused: first .*\\(waited 1 s\\)`, "u"));
    assert.ok(Date.now() - started >= 900);
  });

  it("reads its wait from the environment, and refuses a malformed one", async () => {
    const s = scratch();
    await holder(s);
    const bad = await cli(["run", "waiter", "--lock-path", s.lockPath, "--", process.execPath, "-e", ""], { env: { ...ENV, [WAIT_ENV]: "soon" } }).done;
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, new RegExp(`${WAIT_ENV} must be a whole number of seconds`, "u"));
  });
});

describe("liveness it cannot establish is refused by name", () => {
  /** A separate process whose process source calls (all, or only the ancestry listing) fail with `failure`, trying to take the slot. */
  async function takeWithFailingSource(lockPath, failure, onlyAncestry = false) {
    const script = `import cp from "node:child_process"; import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
      const real = cp.spawnSync, read = fs.readFileSync, list = fs.readdirSync;
      cp.spawnSync = (file, args, options) => { if (!String(file).includes('process-source-') || Number(args.at(-1)) === process.pid || (${String(onlyAncestry)} && args.at(-1) !== '--identity')) return real(file, args, options); throw ${failure}; };
      fs.readFileSync = (file,...args) => { if (!${String(onlyAncestry)} && String(file).startsWith('/proc/') && file !== '/proc/stat' && file !== '/proc/sys/kernel/random/boot_id' && !String(file).startsWith('/proc/'+process.pid+'/')) throw ${failure}; return read(file,...args); };
      fs.readdirSync = (file,...args) => { if(file==='/proc')throw ${failure}; return list(file,...args); };
      syncBuiltinESMExports();
      const { acquireTestSlot } = await import(${JSON.stringify(MODULE)});
      let message = null; try { await acquireTestSlot("second", { lockPath: ${JSON.stringify(lockPath)}, waitSeconds: 30 }); } catch (e) { message = e.message; }
      process.stdout.write(JSON.stringify({ message }));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0);
    return JSON.parse(out).message;
  }

  for (const [name, failure] of [
    ["denied (EPERM)", `Object.assign(new Error("process source denied"), { code: "EPERM" })`],
    ["missing (ENOENT)", `Object.assign(new Error("process source ENOENT"), { code: "ENOENT" })`],
    ["answering that the live holder does not exist", `Object.assign(new Error("process source failed"), { status: 1, stdout: "" })`],
  ]) {
    it(`refuses, without waiting, and leaves a live holder's lock in place when the source is ${name}`, async () => {
      const s = scratch();
      const first = await holder(s);
      const before = fs.readFileSync(s.lockPath, "utf8");
      const started = Date.now();
      const message = await takeWithFailingSource(s.lockPath, failure);
      assert.match(message, new RegExp(`^${HOLDER_UNKNOWN_CODE}: second refused: cannot tell whether the holder of .*, first \\(pid ${String(first.child.pid)}, .*\\), still runs: process source could not read pid ${String(first.child.pid)}'s start time`, "u"));
      assert.ok(Date.now() - started < loadTimeout(10_000));
      assert.equal(fs.readFileSync(s.lockPath, "utf8"), before);
    });
  }

  it("retains a stale record for root-owned PID 1 when its identity read is denied", async () => {
    const s = scratch();
    fs.writeFileSync(s.lockPath, JSON.stringify({ pid: 1, token: "stale", label: "stale", processStart: "ps-utc-c:Thu Jan  1 00:00:00 1970", pgid: null }));
    const before = fs.readFileSync(s.lockPath, "utf8");
    const message = await takeWithFailingSource(s.lockPath, `Object.assign(new Error("process source denied"), { code: "EPERM" })`);
    assert.match(message, /^TEST_SLOT_HOLDER_UNKNOWN:.*could not read pid 1's start time/u);
    assert.equal(fs.readFileSync(s.lockPath, "utf8"), before);
  });

  it("refuses when the source cannot list the ancestry it needs to tell a nested waiter from another run", async () => {
    const s = scratch();
    await holder(s);
    const before = fs.readFileSync(s.lockPath, "utf8");
    const message = await takeWithFailingSource(s.lockPath, `Object.assign(new Error("process source denied"), { code: "EPERM" })`, true);
    assert.match(message, new RegExp(`^${HOLDER_UNKNOWN_CODE}: second refused: cannot tell whether this process runs inside the live holder first `, "u"));
    assert.equal(fs.readFileSync(s.lockPath, "utf8"), before);
  });

  it("refuses, and leaves the file in place, for a record that names no holder, or a live one it cannot date", async () => {
    const s = scratch();
    const first = await holder(s);
    const cases = [
      ["", /cannot tell whether the holder of .*, an unreadable record, still runs: the lock file does not name a holder process/u],
      ["{\"label\":\"no-pid\"}", /the lock file does not name a holder process/u],
      [JSON.stringify({ ...first.record, token: "" }), /the lock file does not name a holder process/u],
      [JSON.stringify({ ...first.record, processStart: null }), new RegExp(`pid ${String(first.child.pid)} runs and the holder recorded no start time to compare`, "u")],
      [JSON.stringify({ ...first.record, pid: 999_999, groupStart: null }), new RegExp(`pid ${String(first.commandPid)} runs and the holder recorded no start time to compare`, "u")],
    ];
    for (const [text, why] of cases) {
      fs.writeFileSync(s.lockPath, text);
      await assert.rejects(acquireTestSlot("second", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 }), (e) => e.code === HOLDER_UNKNOWN_CODE && why.test(e.message) && e.message.startsWith(`${HOLDER_UNKNOWN_CODE}: second refused: `));
      assert.equal(fs.readFileSync(s.lockPath, "utf8"), text);
    }
  });
});

describe("signals and release", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    it(`forwards ${signal} to the command's group, then releases`, async () => {
      const s = scratch();
      const got = s.file("got");
      const ready = s.file("ready");
      const body = `process.on(${JSON.stringify(signal)}, () => { require("fs").writeFileSync(${JSON.stringify(got)}, ${JSON.stringify(signal)}); process.exit(9); }); setInterval(() => {}, 1000);`;
      const run = cli(["run", "signalled", "--lock-path", s.lockPath, "--", ...nodeCommand(ready, body)]);
      await until(() => fs.existsSync(ready) && fs.existsSync(s.lockPath) && readLock(s.lockPath).groupStart !== null, "the run to hold the slot");
      run.child.kill(signal);
      const done = await run.done;
      assert.equal(fs.readFileSync(got, "utf8"), signal);
      assert.equal(done.code, 9, "the runner's status is its command's");
      assert.equal(fs.existsSync(s.lockPath), false);
    });
  }

  it("status reports free (0), held (1) and unknown (2) without touching the lock", async () => {
    const s = scratch();
    const free = await cli(["status", "--lock-path", s.lockPath]).done;
    assert.deepEqual([free.code, JSON.parse(free.stdout).state], [0, "free"]);
    assert.deepEqual(JSON.parse(free.stdout).queue, []);
    const first = await holder(s);
    const held = await cli(["status", "--lock-path", s.lockPath]).done;
    assert.deepEqual([held.code, JSON.parse(held.stdout).state, JSON.parse(held.stdout).holder.pid], [1, "live", first.child.pid]);
    assert.deepEqual(JSON.parse(held.stdout).queue, []);
    fs.writeFileSync(s.lockPath, "{");
    const unknown = await cli(["status", "--lock-path", s.lockPath]).done;
    assert.deepEqual([unknown.code, JSON.parse(unknown.stdout).state], [2, "unknown"]);
    assert.deepEqual(JSON.parse(unknown.stdout).queue, []);
    assert.equal(fs.readFileSync(s.lockPath, "utf8"), "{");
  });

  it("never reports success for an interrupted run, even when its command exits 0 on the signal", async () => {
    const s = scratch();
    const ready = s.file("ready");
    const run = cli(["run", "swallower", "--lock-path", s.lockPath, "--", ...nodeCommand(ready, `process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000);`)]);
    await until(() => fs.existsSync(ready) && fs.existsSync(s.lockPath) && readLock(s.lockPath).groupStart !== null, "the run to hold the slot");
    run.child.kill("SIGINT");
    const done = await run.done;
    assert.equal(done.code, 128 + os.constants.signals.SIGINT);
    assert.equal(fs.existsSync(s.lockPath), false);
  });

  it("release removes only its own lock", async () => {
    const s = scratch();
    const slot = await acquireTestSlot("mine", { lockPath: s.lockPath, env: ENV, waitSeconds: 0 });
    fs.writeFileSync(s.lockPath, JSON.stringify({ pid: 1, token: "someone-else", label: "later" }));
    slot.release();
    assert.equal(readLock(s.lockPath).label, "later");
  });
});

describe('workspace configuration and timeout retry', () => {
  it('scrubs enclosing slot paths, tokens, wait allowances and retry state before fixture overrides', () => {
    const inherited = { PATH: ENV.PATH, LANG: 'C',
      [PATH_ENV]: '/outer/slot', [COMPAT_PATH_ENV]: '/outer/compat',
      [TOKEN_ENV]: 'outer-token', [WAIT_ENV]: '7200', [RETRIED_ENV]: '1',
      [LEGACY_TOKEN_ENV]: 'outer-token', [LEGACY_WAIT_ENV]: '7200',
      BCH_CLOAK_TEST_SLOT_PATH: '/outer/legacy', MONITOR_TEST_SLOT_FUTURE: 'outer-state' };
    const clean = testSlotEnvironment(inherited);
    assert.deepEqual(clean, { PATH: ENV.PATH, LANG: 'C' });
    assert.equal(inherited[WAIT_ENV], '7200', 'scrubbing leaves the enclosing gate environment intact');
  });

  it('uses the workspace path and passes it to nested commands', async () => {
    const s = scratch();
    const inner = [process.execPath, CLI, 'run', 'nested', '--', process.execPath, '-e', ''];
    const body = `const fs=require('fs');require('assert').equal(process.env.${PATH_ENV},${JSON.stringify(s.lockPath)});const r=require('child_process').spawnSync(${JSON.stringify(inner[0])},${JSON.stringify(inner.slice(1))},{env:process.env,timeout:5000});process.exit(r.status??1);`;
    const done = await cli(['run', 'workspace', '--', process.execPath, '-e', body], { env: { ...ENV, [PATH_ENV]: s.lockPath, [COMPAT_PATH_ENV]: s.lockPath } }).done;
    assert.equal(done.code, 0, done.stderr); assert.equal(fs.existsSync(s.lockPath), false);
  });

  for (const [name, load, firstCode, marker, expectedRuns] of [
    ['timeout under load', 1000, 124, '', 2],
    ['reported Node timeout under load', 1000, 1, 'testTimeoutFailure', 2],
    ['timeout without load', 0, 124, '', 1],
    ['ordinary failure under load', 1000, 7, '', 1],
    ['slot refusal under load', 1000, 75, 'ETIMEDOUT', 1],
  ]) {
    it(`retries only once for ${name}`, async () => {
      const s = scratch(); const count = s.file('count'); const identities = s.file('identities');
      const preload = s.file('load.mjs');
      fs.writeFileSync(preload, `import os from 'node:os';os.loadavg=()=>[${load},${load},${load}];`);
      const body = `const fs=require('fs');let n=fs.existsSync(${JSON.stringify(count)})?Number(fs.readFileSync(${JSON.stringify(count)},'utf8')):0;fs.writeFileSync(${JSON.stringify(count)},String(++n));fs.appendFileSync(${JSON.stringify(identities)},fs.readFileSync(${JSON.stringify(s.lockPath)},'utf8'));console.error(${JSON.stringify(marker)});process.exit(n===1?${firstCode}:0);`;
      const done = await cli(['run', name, '--lock-path', s.lockPath, '--retry-timeout-under-load', '--', process.execPath, '-e', body],
        { env: { ...ENV, NODE_OPTIONS: `--import=${preload}` } }).done;
      assert.equal(Number(fs.readFileSync(count, 'utf8')), expectedRuns);
      assert.equal(done.code, expectedRuns === 2 ? 0 : firstCode, done.stderr);
      assert.equal((done.stderr.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, expectedRuns - 1);
      const records = fs.readFileSync(identities, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(new Set(records.map(record => record.token)).size, 1, 'retry retains the exclusive slot');
      assert.equal(fs.existsSync(s.lockPath), false);
    });
  }

  it('does not retry a second timeout or a signaled timeout', async () => {
    const s = scratch(); const count = s.file('count'); const preload = s.file('load.mjs');
    fs.writeFileSync(preload, `import os from 'node:os';os.loadavg=()=>[1000,1000,1000];`);
    const env = { ...ENV, NODE_OPTIONS: `--import=${preload}` };
    const repeated = await cli(['run', 'repeated', '--lock-path', s.lockPath, '--retry-timeout-under-load', '--', process.execPath, '-e',
      `require('fs').appendFileSync(${JSON.stringify(count)},${JSON.stringify('attempt\n')});process.exit(124);`], { env }).done;
    assert.equal(repeated.code, 124); assert.equal(fs.readFileSync(count, 'utf8'), 'attempt\nattempt\n');
    const signaled = await cli(['run', 'signal', '--lock-path', s.lockPath, '--retry-timeout-under-load', '--', process.execPath, '-e',
      `console.error('ETIMEDOUT');process.kill(process.pid,'SIGTERM');`], { env }).done;
    assert.equal(signaled.code, 143); assert.doesNotMatch(signaled.stderr, /TEST_SLOT_TIMEOUT_RETRY:/);
  });

  for (const childRetries of [true, false]) {
    it(`limits nested retrying holders to two attempts when the ${childRetries ? 'child' : 'ancestor'} initiates the retry`, async () => {
      const s = scratch(), count = s.file('count'), result = s.file('result.json'), preload = s.file('load.mjs');
      fs.writeFileSync(preload, `import os from 'node:os';os.loadavg=()=>${childRetries ? '[1000,1000,1000]' : `process.argv[3]==='inner' && process.env.${RETRIED_ENV}!=='1' ? [0,0,0] : [1000,1000,1000]`};`);
      const body = `require('fs').appendFileSync(${JSON.stringify(count)},'attempt\\n');process.exit(124);`;
      const inner = [process.execPath, CLI, 'run', 'inner', '--retry-timeout-under-load', '--', process.execPath, '-e', body];
      const middle = [process.execPath, CLI, 'run', 'middle', '--retry-timeout-under-load', '--', ...inner];
      const done = await cli(['run', 'outer', '--lock-path', s.lockPath, '--result-path', result,
        '--retry-timeout-under-load', '--', ...middle], { env: { ...ENV, NODE_OPTIONS: `--import=${preload}` } }).done;
      assert.equal(done.code, 124, done.stderr);
      assert.equal(fs.readFileSync(count, 'utf8'), 'attempt\nattempt\n');
      assert.equal((done.stderr.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, 1);
      // With no inner retry, the middle wrapper spends the allowance, then
      // suppresses both the outer replay and another retry in its descendants.
      assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).attempts, 1);
      assert.equal(fs.existsSync(s.lockPath), false);
    });
  }

  for (const [tier, failedStep, expected] of [
    ['promotion', 'test:promotion:core', ['test:slot', 'test:promotion:core', 'test:promotion:core', 'test:promotion:lanes', 'test:promotion:logic']],
    ['release', 'test:core', ['test:slot', 'test:core', 'test:core', 'test:cycle', 'test:lanes', 'test:acceptance', 'test:release:only']],
  ]) it(`${tier} retries only the timed-out heavy step and continues the remaining steps once`, async () => {
    const s = scratch(), count = s.file('steps'), preload = s.file('load.mjs');
    fs.writeFileSync(preload, "import os from 'node:os';os.loadavg=()=>[1000,1000,1000];");
    const scripts = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts;
    fs.writeFileSync(s.file('npm'), `#!${process.execPath}
const fs=require('fs'),file=${JSON.stringify(count)},name=process.argv[3];
if(process.argv[2]==='test'){const r=require('child_process').spawnSync('/bin/sh',['-c',${JSON.stringify(scripts.test)}],{stdio:'inherit',env:process.env,timeout:10000});process.exit(r.status??1);}
const previous=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
fs.appendFileSync(file,name+'\\n');
process.exit(name===${JSON.stringify(failedStep)}&&!previous.includes(${JSON.stringify(failedStep)})?124:0);
`, { mode: 0o755 });
    const steps = scripts[`test:${tier}:steps`];
    const done = await cli(['run', `${tier} adapter`, '--lock-path', s.lockPath, '--retry-timeout-under-load',
      '--', '/bin/sh', '-c', steps], { env: { ...ENV, PATH: `${s.dir}:${ENV.PATH}`, NODE_OPTIONS: `--import=${preload}` } }).done;
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(fs.readFileSync(count, 'utf8').trim().split('\n'),
      expected);
    assert.equal((done.stderr.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, 1);
    assert.equal(fs.existsSync(s.lockPath), false);
  });

  it('does not inherit a stale token into a dead holder record', async () => {
    const s = scratch();
    fs.writeFileSync(s.lockPath, JSON.stringify({ pid: 999999, pgid: null, token: 'stale', label: 'dead' }));
    const slot = await acquireTestSlot('new', { lockPath: s.lockPath, env: { ...ENV, [TOKEN_ENV]: 'stale' } });
    assert.equal(slot.nested, false); assert.notEqual(slot.token, 'stale'); slot.release();
  });
});

describe('legacy bridge during workspace migration', () => {
  it('a configured workspace path waits for the legacy slot and holds both for its entire command', async () => {
    const legacy = scratch(), workspace = scratch();
    const first = await holder(legacy, 'bch-cloak');
    const marker = workspace.file('waiter.ran');
    const env = { ...ENV, [PATH_ENV]: workspace.lockPath, [COMPAT_PATH_ENV]: legacy.lockPath };
    const refused = await cli(['run', 'workspace', '--', process.execPath, '-e', ''], { env }).done;
    assert.equal(refused.code, 75); assert.match(refused.stderr, /^TEST_SLOT_HELD:.*bch-cloak/);
    assert.equal(fs.existsSync(workspace.lockPath), false);
    const queued = cli(['run', 'workspace', '--wait', String(Math.ceil(loadTimeout(10000) / 1000)), '--', ...nodeCommand(marker)], { env });
    await sleep(200); assert.equal(fs.existsSync(marker), false);
    first.child.kill('SIGTERM'); await first.done;
    await until(() => fs.existsSync(marker) && fs.existsSync(workspace.lockPath), 'configured run to acquire both locks');
    // The command can run before the two post-spawn group updates finish.
    // Both locks already exclude contenders through the live wrapper's identity.
    for (const lockPath of [legacy.lockPath, workspace.lockPath]) {
      const record = readLock(lockPath);
      assert.equal(record.pid, queued.child.pid);
      assert.equal(holderState(record).state, 'live');
      const other = await cli(['run', 'bridge-taker', '--lock-path', lockPath, '--', process.execPath, '-e', '']).done;
      assert.equal(other.code, 75, 'each lock excludes a taker while group metadata is being recorded');
      assert.match(other.stderr, /^TEST_SLOT_HELD:/);
    }
    const commandPid = Number(fs.readFileSync(marker, 'utf8'));
    await until(() => [legacy.lockPath, workspace.lockPath].every(lockPath => {
      const record = readLock(lockPath);
      return record.pgid === commandPid && typeof record.groupStart === 'string' && typeof record.groupBirth === 'string';
    }), 'both locks to record the command group');
    const old = readLock(legacy.lockPath), own = readLock(workspace.lockPath);
    assert.equal(old.token, own.token); assert.equal(old.pgid, own.pgid);
    assert.equal(old.groupStart, own.groupStart); assert.equal(old.groupBirth, own.groupBirth);
    queued.child.kill('SIGTERM'); await queued.done;
    assert.equal(fs.existsSync(legacy.lockPath), false); assert.equal(fs.existsSync(workspace.lockPath), false);
  });
});
