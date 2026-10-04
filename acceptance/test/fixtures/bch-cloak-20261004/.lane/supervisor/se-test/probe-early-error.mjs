// Exact-function probe of runHerdr (round-4 R4-1): a child that reports an error before it exits must not end the herdr call, and so
// release the queue, before the exit. Usage: node probe-early-error.mjs <supervisor-events.mjs>; exit 0 = holds until exit.
import fs from "node:fs"; import { EventEmitter } from "node:events";
const file = process.argv[2]; const src = fs.readFileSync(file, "utf8");
const fn = src.slice(src.indexOf("function runHerdr("), src.indexOf("\n}\n", src.indexOf("function runHerdr(")) + 2);
let cb, child;
const execFile = (_h, _a, _o, callback) => { cb = callback; child = new EventEmitter(); child.pid = 4242; child.kill = () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); }; return child; };
const active = new Set(); const logs = []; const log = (m) => logs.push(m); let execs = 0; const HERDR = "herdr";
const runHerdr = new Function("execFile", "active", "log", "HERDR", "execs", `${fn}; return runHerdr;`)(execFile, active, log, HERDR, execs);
let resolved = false; const p = runHerdr(["agent", "list"], 50).then(() => { resolved = true; });
setTimeout(() => { cb(Object.assign(new Error("spawn error"), { code: "EPERM" }), ""); }, 10);   // error reported, child still alive
setTimeout(() => {
  const early = resolved, tracked = active.has(child);
  child.emit("exit", null, "SIGKILL");
  setTimeout(() => { console.log(`resolved before exit: ${early}; tracked before exit: ${tracked}; resolved after exit: ${resolved}`); process.exit(early || !resolved ? 1 : 0); }, 20);
}, 300);
