#!/usr/bin/env node
// supervisor-events.mjs: wakes agents that wait on the host test slot or on a file, and delivers notifications to the supervisor
// pane, driven by file events instead of polling (operator 2026-10-02 night: "eliminate polling all together"; built 2026-10-03;
// reduced the same day after review REV-NOPOLL found that running promotions and gates from the daemon was the main risk).
//
// It does NOT run promotions or gates. The supervisor runs `.lane/supervisor/promote.sh TOPIC` by hand, one at a time, and the
// full gate runs only there. Gate requests left by old briefs are answered with a file (skipped/refused), never run.
//
// What launches a child process, and when (every child is a herdr call; there are no others):
//   - waking a waiter: one `agent wait` with a 25 s herdr timeout, then send-text and Enter. Each waiter file (regular files only) is
//     claimed (renamed) before its wake and attempted once; a wake held by PAUSED puts the file back for a later attempt. On a failure
//     it becomes R-n.<kind>.failed and one supervisor message is queued, naming where the file is (if that rename fails, it stays as
//     R-n.<kind>.waking, never retried; if the outbox write fails, that is only logged). A run with both a .slot and a .file is woken for one of them at a time.
//   - delivering a notification: agent list, pane read, agent prompt. A failed or deferred delivery retries on a timer with backoff
//     (SE_BACKOFF_MS doubling to SE_BACKOFF_MAX_MS) for at most SE_RETRIES attempts, then parks until a new message arrives or
//     outbox/RETRY is created.
// With no waiter files and no messages it launches nothing. Timers: the sweep (every SE_SWEEP_MS, default 5 min) re-arms watches and
// runs a pass, which wakes a waiter only if one is due and missed its event (a holder that died without removing its lock, for
// example); the reservation expiry; the bounded delivery retry. herdr calls run strictly one at a time: SIGTERM after SE_HERDR_MS,
// SIGKILL 5 s later; a child that survives SIGKILL holds the queue (no further herdr call) until it exits. When the daemon stops on
// SIGINT/SIGTERM/SIGHUP or crashes on an uncaught error, it SIGKILLs its running herdr call first; a SIGKILL of the daemon itself
// cannot, and that child is then left to its own exit. A read of the supervisor's input box and the
// prompt that depends on it run back to back, with no other herdr call between them; the operator can still type in that gap.
//
// Inputs (agents in a sandbox can write the /private/tmp ones):
//   /private/tmp/bch-cloak-waiters/R-n.slot    the run's agent waits for the host test slot; woken with SLOT-FREE, oldest mtime first,
//                                               one at a time (the next only after the slot is taken or the reservation ends)
//   /private/tmp/bch-cloak-waiters/R-n.file    first line = an absolute path; woken with FILE-READY once it exists
//   /private/tmp/bch-cloak-gate-requests/*.req answered at once: skipped (engineer-gates-off) or refused (no gate runner); never run.
//                                               A request that cannot be answered becomes .req.failed (or, if that rename fails, stays
//                                               in place and is skipped) and the supervisor is told once
//   .lane/supervisor/outbox/*.msg               notifications for the supervisor pane; delivered only while its input box is empty
//   .lane/supervisor/PAUSED                     while it exists: no wakes and no gate answers; notifications are still delivered
// State: watch-logs/supervisor-events.reservation (survives a restart). A waiter whose wake was in flight when the daemon died is
// found as R-n.<kind>.waking at start, moved to .failed and reported (whether its text was typed is unknown).
// Log: watch-logs/supervisor-events.log. One instance: it holds 127.0.0.1:SE_LOCK_PORT (the kernel frees it when the process dies);
// a second instance exits 0. Run in the foreground: launchd or a herdr pane.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const env = process.env;
const ROOT = env.SE_ROOT ?? "/Users/rewt/development/bastian/bch-cloak";
const SUP = env.SE_SUP ?? path.join(ROOT, ".lane/supervisor");
const WAITERS = env.SE_WAITERS ?? "/private/tmp/bch-cloak-waiters";
const GATE_REQ = env.SE_GATE_REQ ?? "/private/tmp/bch-cloak-gate-requests";
const SLOT_LOCK = env.SE_SLOT_LOCK ?? "/private/tmp/bch-cloak-test-slot.lock";
const ORG_EVENTS = env.SE_ORG_EVENTS ?? "/Users/rewt/development/bastian/.org/events.jsonl";
const HERDR = env.SE_HERDR ?? "herdr";
const SUPERVISOR = env.SE_SUPERVISOR ?? "supervisor-opus";
const LOCK_PORT = Number(env.SE_LOCK_PORT ?? 47391);
const SWEEP_MS = Number(env.SE_SWEEP_MS ?? 300_000);
const RESERVE_MS = Number(env.SE_RESERVE_MS ?? 600_000);
const HERDR_MS = Number(env.SE_HERDR_MS ?? 30_000);
const WAIT_MS = Number(env.SE_WAIT_MS ?? 25_000); // how long a woken agent may take to end its turn; must stay below HERDR_MS
const BACKOFF_MS = Number(env.SE_BACKOFF_MS ?? 30_000);
const BACKOFF_MAX_MS = Number(env.SE_BACKOFF_MAX_MS ?? 600_000);
const RETRIES = Number(env.SE_RETRIES ?? 6);
const OUTBOX = path.join(SUP, "outbox");
const PAUSED = path.join(SUP, "PAUSED");
const GATES_OFF = path.join(SUP, "engineer-gates-off");
const LOGS = path.join(SUP, "watch-logs");
const LOG = path.join(LOGS, "supervisor-events.log");
const PID = path.join(LOGS, "supervisor-events.pid");
const RESERVATION = path.join(LOGS, "supervisor-events.reservation");

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (m) => { try { fs.appendFileSync(LOG, `${stamp()}  ${m}\n`); } catch { process.stderr.write(`${stamp()}  ${m}\n`); } };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const paused = () => exists(PAUSED);
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const firstLine = (e) => String(e?.stack ?? e).split("\n")[0];
const active = new Set(); // herdr children still running; killed on any exit so none outlives its deadline
const killChildren = () => { for (const c of active) { try { c.kill("SIGKILL"); } catch { /* gone */ } } };
process.on("uncaughtException", (e) => { log(`fatal: ${e?.stack ?? e}`); killChildren(); process.exit(1); }); // launchd restarts a crash, throttled
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${firstLine(e)}`));

for (const d of [WAITERS, GATE_REQ]) {
  fs.mkdirSync(d, { recursive: true });
  try { fs.chmodSync(d, 0o1777); } catch (e) { process.stderr.write(`cannot chmod 1777 ${d}: ${e.code}; sandboxed agents may not be able to write there\n`); }
}
fs.mkdirSync(OUTBOX, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });

// ---- single instance: a listening socket, released by the kernel on any exit ------------------------------------------------
const lock = net.createServer();
lock.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.error(`supervisor-events already running (127.0.0.1:${LOCK_PORT} is held)`); process.exit(0); }
  console.error(`supervisor-events cannot take its instance lock 127.0.0.1:${LOCK_PORT}: ${e.code}`); process.exit(1);
});
lock.listen(LOCK_PORT, "127.0.0.1", main);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { log(`stopped (${s})${active.size ? `; killed ${active.size} herdr call(s)` : ""}`); killChildren(); try { fs.rmSync(PID); } catch { /* gone */ } process.exit(0); });

// ---- herdr: one call at a time, each bounded ------------------------------------------------------------------------------
let execs = 0, chain = Promise.resolve();
// SIGTERM at the deadline, SIGKILL 5 s later. A call ends only after its child has exited, so the queue never runs two children: a
// child that survives SIGKILL (stuck in the kernel, as `ps` was on 10-02) holds the queue, and no further herdr call starts, until it
// exits. An error reported before the exit (a failed signal, say) is held until the exit; escalation continues meanwhile. The child
// leaves `active` only when it exits. If its output pipes stay open more than 5 s after it exited (a grandchild holding them), they are
// destroyed and the call ends with no output.
function runHerdr(args, ms) {
  return new Promise((resolve) => {
    let done = false, exited = false, result, term = null, kill = null, stuck = null, drain = null, child = null;
    const what = args.slice(0, 2).join(" ");
    const finish = (v) => { if (done) return; done = true; for (const t of [term, kill, stuck, drain]) clearTimeout(t); resolve(v); };
    const settle = (v) => { result = v; if (exited) finish(v); }; // the execFile callback; before the exit it only records the result
    execs++;
    try { child = execFile(HERDR, args, { maxBuffer: 8 << 20, encoding: "utf8" }, (err, out) => settle(err ? null : out)); }
    catch (e) { log(`herdr ${what} not started: ${firstLine(e)}`); finish(null); return; }
    if (!child.pid) { child.on("error", (e) => log(`herdr ${what} not started: ${firstLine(e)}`)); finish(null); return; } // spawn failed
    active.add(child);
    child.on("exit", () => {
      exited = true; active.delete(child); clearTimeout(term); clearTimeout(kill);
      if (stuck !== null) log(`herdr ${what} (pid ${child.pid}) finally exited; herdr calls resume`);
      clearTimeout(stuck); stuck = null;
      if (result !== undefined) { finish(result); return; }
      drain = setTimeout(() => {
        log(`herdr ${what} exited but its output stayed open 5 s; pipes destroyed, ended without output`);
        for (const st of [child.stdout, child.stderr]) { try { st?.destroy(); } catch { /* closed */ } }
        finish(null);
      }, 5_000);
    });
    term = setTimeout(() => { log(`herdr ${what} passed its ${ms / 1000} s deadline; SIGTERM`); try { child.kill("SIGTERM"); } catch { /* gone */ } }, ms);
    kill = setTimeout(() => {
      log(`herdr ${what} still running 5 s after SIGTERM; SIGKILL`); try { child.kill("SIGKILL"); } catch { /* gone */ }
      stuck = setTimeout(() => log(`herdr ${what} (pid ${child.pid}) survived SIGKILL for 5 s; no herdr call starts until it exits`), 5_000);
    }, ms + 5_000);
  });
}
// `task(call)` holds the herdr queue for its whole run, so dependent calls (read the box, then prompt) are back to back
function herdrExclusive(task) {
  const p = chain.then(() => task((args, ms = HERDR_MS) => runHerdr(args, ms)));
  chain = p.then(() => undefined, () => undefined); return p;
}

// ---- notifications to the supervisor pane ------------------------------------------------------------------------------------
export function notify(msg) { // other scripts do the same with a file: see notify-watch.sh
  try {
    const f = path.join(OUTBOX, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.msg`);
    fs.writeFileSync(`${f}.tmp`, msg); fs.renameSync(`${f}.tmp`, f);
  } catch (e) { log(`OUTBOX WRITE FAILED (${firstLine(e)}): ${msg}`); }
}
// Input box = the lines between the last two horizontal rules of the Claude Code footer; typed text is in the default colour, the
// prompt glyph and placeholders are grey or dim (port of box-empty.py, so a check launches no python).
export function boxEmpty(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  const rules = plain.flatMap((l, i) => (l.trim().startsWith("────") ? [i] : []));
  if (rules.length < 2) return false;
  let typed = "";
  for (const l of lines.slice(rules.at(-2) + 1, rules.at(-1))) {
    const style = new Set();
    for (const tok of l.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
      const m = /^\x1b\[([0-9;?]*)m$/.exec(tok);
      if (m) {
        const p = m[1];
        if (p === "" || p === "0") style.clear();
        else if (p === "2") style.add("dim");
        else if (p === "22") style.delete("dim");
        else if (p.startsWith("38;2;")) { const rgb = p.split(";").slice(2, 5).map(Number); style.delete("grey"); if (Math.max(...rgb) - Math.min(...rgb) < 16 && rgb[0] >= 90 && rgb[0] <= 170) style.add("grey"); }
        else if (p === "39") style.delete("grey");
        continue;
      }
      if (tok.startsWith("\x1b")) continue;
      if (!style.has("dim") && !style.has("grey")) typed += tok;
    }
  }
  return typed.replaceAll("❯", "").replaceAll(" ", " ").trim() === "";
}

const outboxMsgs = () => { try { return fs.readdirSync(OUTBOX).filter((n) => n.endsWith(".msg")).sort(); } catch { return []; } };
let delivering = false, attempts = 0, retryTimer = null, parked = null, backlogWarned = false; // parked = names seen when it parked
async function outboxPass() {
  if (delivering || retryTimer) return;
  if (parked) { // a missed watch event (dropped watcher, null filename) is caught here at the next pass or sweep; no child process
    if (exists(path.join(OUTBOX, "RETRY"))) { fs.rmSync(path.join(OUTBOX, "RETRY"), { force: true }); log("delivery unparked (RETRY)"); }
    else { const fresh = outboxMsgs().find((n) => !parked.has(n)); if (!fresh) return; log(`delivery unparked (new message ${fresh})`); }
    parked = null; attempts = 0;
  }
  const msgs = outboxMsgs();
  if (!msgs.length) { attempts = 0; backlogWarned = false; return; }
  if (msgs.length > 50 && !backlogWarned) { backlogWarned = true; log(`outbox backlog: ${msgs.length} messages`); }
  delivering = true;
  let result;
  try {
    result = await herdrExclusive(async (call) => {
      const sup = (json(await call(["agent", "list"]))?.result?.agents ?? []).find((a) => a.name === SUPERVISOR);
      if (!sup?.pane_id) return `no agent named ${SUPERVISOR}`;
      const screen = await call(["pane", "read", sup.pane_id, "--lines", "14", "--format", "ansi"]);
      if (screen === null) return "pane read failed";
      if (!boxEmpty(screen)) return "input box busy";
      const p = path.join(OUTBOX, msgs[0]);
      let msg; try { msg = fs.readFileSync(p, "utf8").trim(); } catch { return "sent"; } // removed meanwhile: nothing to send
      const ok = (await call(["agent", "prompt", sup.pane_id, msg])) !== null;
      const at = new Date().toISOString().replace("T", " ").slice(0, 19);
      try {
        if (ok) fs.appendFileSync(path.join(SUP, "inbox.log"), `${at}  ${msg}\n`);
        fs.appendFileSync(path.join(SUP, "notify-log.tsv"), `${at}\tsupervisor-events\t${ok ? "sent" : "FAILED"}\t${msg}\n`);
      } catch (e) { log(`cannot append inbox/notify log: ${firstLine(e)}`); }
      if (!ok) return "agent prompt failed";
      fs.rmSync(p, { force: true }); return "sent";
    });
  } catch (e) { result = `error: ${firstLine(e)}`; }
  finally { delivering = false; }
  if (result === "sent") { attempts = 0; if (outboxMsgs().length) reconcile("next message"); return; } // one message per pass
  attempts++;
  if (attempts >= RETRIES) {
    parked = new Set(outboxMsgs());
    log(`delivery parked after ${attempts} attempts (${result}); ${parked.size} message(s) wait for a new message or outbox/RETRY`);
    return;
  }
  const ms = Math.min(BACKOFF_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  retryTimer = setTimeout(() => { retryTimer = null; reconcile("delivery retry"); }, ms);
  log(`delivery deferred (${result}); attempt ${attempts} of ${RETRIES}; ${msgs.length} message(s) wait ${ms / 1000} s`);
}
const outboxEvent = () => reconcile("outbox"); // unparking is decided in outboxPass, from the directory itself

// ---- org: run -> agent and pane, read in-process -------------------------------------------------------------------------------
function runMeta(run) {
  let meta = null;
  for (const line of fs.readFileSync(ORG_EVENTS, "utf8").split("\n")) {
    if (!line.includes(`"${run}"`)) continue;
    const e = json(line); if (!e || e.id !== run) continue;
    if (e.type === "run.started") meta = { ...(e.meta ?? {}) };
    if (e.type === "run.updated" && meta) Object.assign(meta, e.meta ?? {});
  }
  return meta;
}

// ---- waking a waiting agent ---------------------------------------------------------------------------------------------------
// The waiter file is renamed to .waking before anything else (claim), so each file is woken at most once.
function waiters(ext) {
  let names = []; try { names = fs.readdirSync(WAITERS); } catch { return []; }
  return names.filter((n) => new RegExp(`^R-\\d+\\${ext}$`).test(n))
    .map((n) => { const p = path.join(WAITERS, n); let st; try { st = fs.lstatSync(p); } catch { return null; } return st.isFile() ? { run: n.slice(0, -ext.length), p, at: st.mtimeMs } : null; })
    .filter(Boolean).sort((x, y) => x.at - y.at || (x.p < y.p ? -1 : 1));
}
function claim(w) { const c = `${w.p}.waking`; try { fs.renameSync(w.p, c); return c; } catch { return null; } }
function failWake(run, claimed, kind, why) {
  let failed = claimed.replace(/\.waking$/, ".failed");
  try { fs.renameSync(claimed, failed); } catch (e) { failed = exists(claimed) ? claimed : "gone"; log(`cannot rename ${claimed} to .failed: ${firstLine(e)}`); }
  log(`FAILED to wake ${run} (${kind}): ${why}`);
  notify(`[supervisor-events] could not wake ${run} (${kind}): ${why}. Its waiter is now ${failed} (never retried); check the pane and wake it by hand, or delete that file and have the agent write a new waiter.`);
  return "failed";
}
function unclaim(claimed, original) {
  try { if (exists(original)) fs.rmSync(claimed, { force: true }); else fs.renameSync(claimed, original); } catch { /* gone */ }
}
const waking = new Set();
async function wake(run, claimed, original, kind, text) {
  if (waking.has(run)) { unclaim(claimed, original); return "busy"; }
  waking.add(run);
  try {
    let m; try { m = runMeta(run); } catch (e) { return failWake(run, claimed, kind, `cannot read the org log: ${firstLine(e)}`); }
    if (!m?.pane) return failWake(run, claimed, kind, "no pane recorded in org");
    return await herdrExclusive(async (call) => {
      // an agent that wrote its waiter file is woken only once it has ended its turn; a bounded wait, never a loop
      if (m.agent && (await call(["agent", "wait", m.agent, "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(WAIT_MS)])) === null)
        return failWake(run, claimed, kind, `agent ${m.agent} did not end its turn within ${WAIT_MS / 1000} s, or herdr failed; nothing typed`);
      if (paused()) { unclaim(claimed, original); log(`wake of ${run} held: PAUSED appeared`); return "paused"; }
      if ((await call(["pane", "send-text", m.pane, text])) === null) return failWake(run, claimed, kind, `send-text to ${m.pane} failed`);
      if ((await call(["pane", "send-keys", m.pane, "Enter"])) === null) return failWake(run, claimed, kind, `Enter to ${m.pane} failed after the text was typed; it may sit in the input box`);
      try { fs.rmSync(claimed, { force: true }); } catch (e) { log(`woke ${run} but cannot remove ${claimed}: ${firstLine(e)}`); }
      log(`woke ${run} (${m.pane}): ${text.slice(0, 40)}`);
      return "sent";
    });
  } catch (e) { return failWake(run, claimed, kind, `unexpected error: ${firstLine(e)}`); }
  finally { waking.delete(run); }
}

// ---- the host test slot ----------------------------------------------------------------------------------------------------------
// free: no lock, or its holder process and group are both gone (ESRCH). held: either answers kill(0) or EPERM. unknown: unreadable,
// half-written or malformed lock, or an unexpected probe error: no wake, and a reservation stays. The authoritative check stays in
// test-slot.mjs: a woken agent whose command finds a live holder waits again. PID reuse can make a dead holder look held (a stall,
// never a false "free").
function probe(pid) { try { process.kill(pid, 0); return "alive"; } catch (e) { return e.code === "ESRCH" ? "dead" : e.code === "EPERM" ? "alive" : "unknown"; } }
function slotState() {
  let text; try { text = fs.readFileSync(SLOT_LOCK, "utf8"); } catch (e) { return e.code === "ENOENT" ? "free" : "unknown"; }
  const h = json(text);
  if (!h || !Number.isInteger(h.pid) || h.pid <= 0) return "unknown";
  const p = probe(h.pid); if (p !== "dead") return p === "alive" ? "held" : "unknown";
  if (h.pgid === null) return "free"; // as test-slot.mjs: pgid must be null or a positive integer; anything else (missing too) is unknown
  if (!Number.isSafeInteger(h.pgid) || h.pgid <= 0) return "unknown";
  const g = probe(-h.pgid); if (g !== "dead") return g === "alive" ? "held" : "unknown";
  return "free";
}

// reservation: from the moment a waiter is claimed until the slot is taken, or RESERVE_MS after a successful wake; on disk
let reservation = null, reserveTimer = null;
function setReservation(r) {
  reservation = r; clearTimeout(reserveTimer); reserveTimer = null;
  try { fs.writeFileSync(`${RESERVATION}.tmp`, JSON.stringify(r)); fs.renameSync(`${RESERVATION}.tmp`, RESERVATION); } catch (e) { log(`cannot persist reservation: ${firstLine(e)}`); }
  if (r.until) reserveTimer = setTimeout(() => { clearReservation("timeout"); reconcile("reservation timeout"); }, Math.max(0, r.until - Date.now()));
}
function clearReservation(why) {
  if (!reservation) return;
  clearTimeout(reserveTimer); reserveTimer = null; log(`reservation for ${reservation.run} ended (${why})`); reservation = null;
  fs.rmSync(RESERVATION, { force: true });
}
function checkReservation() { if (reservation?.until && slotState() === "held") clearReservation("slot taken"); }

const SLOT_MSG = "SLOT-FREE: the host test slot is free now (supervisor-events). Run your slot command immediately as one foreground command with BCH_CLOAK_TEST_SLOT_WAIT_SECONDS=10800 (if it exits 75 with TEST_SLOT_HOLDER_UNKNOWN or an EPERM from ps, re-run it with escalated permissions). If the slot is taken again before you start, write your waiter file again and end your turn.";
function slotPass(why) {
  if (paused() || reservation || slotState() !== "free") return;
  const w = waiters(".slot").find((x) => !waking.has(x.run)); if (!w) return; // a run already being woken is left for later
  const claimed = claim(w); if (!claimed) return;
  if (env.SE_TRACE) log(`claim ${w.run}.slot (pass: ${why})`);
  setReservation({ run: w.run, since: Date.now(), until: null }); // pending: no second wake while this one runs
  wake(w.run, claimed, w.p, "slot", SLOT_MSG).then((r) => {
    if (r === "sent") setReservation({ run: w.run, since: Date.now(), until: Date.now() + RESERVE_MS });
    else clearReservation(`wake ${r}`);
  }, (e) => { log(`slot wake of ${w.run} failed: ${firstLine(e)}`); clearReservation("wake error"); })
    .finally(() => reconcile("slot wake done"));
}

// ---- WAITING-FOR-FILE ------------------------------------------------------------------------------------------------------------
const fileWatches = new Map(); // directory -> FSWatcher: each awaited file's directory, or its nearest existing ancestor
function nearestDir(target) { let d = path.dirname(target); while (!exists(d) && d !== path.dirname(d)) d = path.dirname(d); return d; }
function filePass() {
  const wanted = new Set();
  for (const w of waiters(".file")) {
    let target = ""; try { target = fs.readFileSync(w.p, "utf8").split("\n")[0].trim(); } catch { continue; }
    if (waking.has(w.run)) continue; // its other waiter is being woken; this one is looked at when that wake ends
    if (!path.isAbsolute(target)) { const c = claim(w); if (c) failWake(w.run, c, "file", `its first line is not an absolute path: ${target.slice(0, 80)}`); continue; }
    if (exists(target)) {
      if (paused()) continue;
      const claimed = claim(w); if (!claimed) continue;
      wake(w.run, claimed, w.p, "file", `FILE-READY: ${target} now exists (supervisor-events). Continue your brief from here.`)
        .catch((e) => log(`file wake of ${w.run} failed: ${firstLine(e)}`)).finally(() => reconcile("file wake done"));
    } else wanted.add(nearestDir(target));
  }
  for (const dir of wanted) if (!fileWatches.has(dir)) watchDir(fileWatches, dir, () => reconcile(`file event in ${dir}`));
  for (const [dir, wch] of fileWatches) if (!wanted.has(dir)) { wch.close(); fileWatches.delete(dir); }
}

// ---- gate requests: answered, never run --------------------------------------------------------------------------------------------
const GATE_SKIPPED = "skipped: operator policy 2026-10-02 - engineers no longer run the full gate; it runs once at promotion. Write your report now with the targeted suites you ran and their raw exits.";
const GATE_REFUSED = "refused: supervisor-events runs no gates (2026-10-03); the full gate runs once at promotion (promote.sh). Write your report now with the targeted suites you ran and their raw exits.";
const unanswered = new Set();
function gatePass() {
  if (paused()) return;
  let names = []; try { names = fs.readdirSync(GATE_REQ).filter((n) => n.endsWith(".req")); } catch { return; }
  for (const n of names) {
    if (unanswered.has(n)) continue; // could not be answered or set aside; reported once already
    const f = path.join(GATE_REQ, n);
    let text; try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const out = /^out=(.*)$/m.exec(text)?.[1]?.trim();
    const answer = exists(GATES_OFF) ? GATE_SKIPPED : GATE_REFUSED;
    let why = "";
    if (!out || !path.isAbsolute(out)) why = "it names no absolute out=";
    else {
      try { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "gate.raw.exit.tmp"), `${answer}\n`); fs.renameSync(path.join(out, "gate.raw.exit.tmp"), path.join(out, "gate.raw.exit")); }
      catch (e) { why = `cannot write ${out}/gate.raw.exit: ${firstLine(e)}`; }
    }
    if (why) {
      let kept = `${f}.failed`;
      try { fs.renameSync(f, kept); } catch { kept = f; unanswered.add(n); } // never deleted: left in place and skipped from now on
      log(`gate request ${n} unanswered: ${why}; kept as ${kept}`);
      notify(`[supervisor-events] gate request ${n} could not be answered (${why}); kept as ${kept}. An agent waiting on its raw exit file needs a hand wake.`);
      continue;
    }
    fs.rmSync(f, { force: true }); log(`answered gate request ${n}: ${answer.split(":")[0]}`);
  }
}

// ---- event loop ------------------------------------------------------------------------------------------------------------------
let queued = false;
function reconcile(why) {
  if (queued) return; queued = true;
  setImmediate(() => {
    queued = false;
    for (const [name, pass] of [["reservation", checkReservation], ["slot", slotPass], ["file", filePass], ["gate", gatePass], ["outbox", outboxPass]]) {
      try { const r = pass(why); if (r?.catch) r.catch((e) => log(`${name} pass failed: ${firstLine(e)}`)); }
      catch (e) { log(`${name} pass failed: ${firstLine(e)}`); }
    }
    if (env.SE_TRACE) log(`pass (${why}) execs=${execs}`);
  });
}
// A watcher that errors (EMFILE, a removed directory) is closed and dropped; the next sweep re-arms it. It never kills the daemon.
function watchDir(registry, dir, onEvent) {
  try {
    const ino = fs.statSync(dir).ino;
    const w = fs.watch(dir, (_, f) => { try { onEvent(f); } catch (e) { log(`watch callback ${dir} failed: ${firstLine(e)}`); } });
    w.on("error", (e) => { log(`watch ${dir} failed (${e.code ?? firstLine(e)}); dropped until the next sweep`); try { w.close(); } catch { /* closed */ } if (registry.get(dir) === w) registry.delete(dir); });
    w.ino = ino; registry.set(dir, w);
  } catch (e) { log(`cannot watch ${dir} (${e.code ?? firstLine(e)}); the sweep covers it`); }
}
const core = new Map();
const lockBase = path.basename(SLOT_LOCK);
const coreWatches = [
  [path.dirname(SLOT_LOCK), (f) => { if (f === lockBase || f === null) reconcile("slot lock"); }],
  [WAITERS, () => reconcile("waiters")],
  [GATE_REQ, () => reconcile("gate request")],
  [OUTBOX, outboxEvent],
  [SUP, (f) => { if (f === "PAUSED" || f === "engineer-gates-off") reconcile(f); }],
];
// at every sweep: a watch whose directory is gone or was replaced (new inode; it may never report an error) is closed and re-armed
function armCore() {
  for (const [dir, fn] of coreWatches) {
    const w = core.get(dir);
    if (w) { let ino = null; try { ino = fs.statSync(dir).ino; } catch { /* gone */ } if (ino === w.ino) continue; try { w.close(); } catch { /* closed */ } core.delete(dir); log(`watch ${dir} re-armed (directory replaced or gone)`); }
    if (exists(dir)) watchDir(core, dir, fn);
  }
}

function recover() {
  let names = []; try { names = fs.readdirSync(WAITERS); } catch { /* none */ }
  for (const n of names.filter((x) => /^R-\d+\.(slot|file)\.waking$/.test(x))) {
    const [, run, kind] = /^(R-\d+)\.(slot|file)/.exec(n);
    failWake(run, path.join(WAITERS, n), kind, "the daemon stopped during this wake; whether its text was typed is unknown");
  }
  const r = json((() => { try { return fs.readFileSync(RESERVATION, "utf8"); } catch { return "null"; } })());
  if (r?.run) {
    const until = r.until ?? Date.now() + RESERVE_MS; // a wake was in flight: hold the full reservation
    if (until > Date.now()) { setReservation({ ...r, until }); log(`reservation for ${r.run} restored until ${new Date(until).toTimeString().slice(0, 8)}`); }
    else fs.rmSync(RESERVATION, { force: true });
  }
}

function main() {
  fs.writeFileSync(PID, `${process.pid}\n`);
  recover();
  armCore();
  let lastExecs = 0;
  setInterval(() => { if (execs !== lastExecs) { log(`sweep: ${execs} herdr calls since start`); lastExecs = execs; } armCore(); reconcile("sweep"); }, SWEEP_MS);
  log(`started (pid ${process.pid})${paused() ? "; PAUSED exists: no wakes or gate answers until it is removed" : ""}`);
  reconcile("start");
}
