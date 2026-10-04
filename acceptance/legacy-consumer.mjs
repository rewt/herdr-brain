// Run the restored event service only in acceptance scratch, through its scoped
// Herdr adapter. A ChildProcess handle owns teardown; saved PIDs never authorize
// signals. The copied service's bytes and modes remain the rollback baseline.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { waitUntil } from './load.mjs';

export async function startLegacyConsumer({ root, copy, org, herdr, target, env, evidence,
  launch = spawn, onStart = () => {}, load, timeoutMs = 10_000 }) {
  root = fs.realpathSync(root);
  const scoped = file => {
    file = path.resolve(file);
    let ancestor = file;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const rel = path.relative(root, file);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || fs.realpathSync(ancestor) !== ancestor)
      throw new Error(`legacy consumer path outside scratch: ${file}`);
    return file;
  };
  copy = scoped(copy); org = scoped(org); herdr = scoped(herdr); evidence = scoped(evidence);
  const script = scoped(path.join(copy, '.lane/supervisor/supervisor-events.mjs'));
  const sup = scoped(path.join(copy, '.lane/supervisor'));
  if (!fs.statSync(script).isFile() || !fs.statSync(herdr).isFile() || !fs.statSync(org).isDirectory())
    throw new Error('legacy consumer requires copied service, scratch record and scoped adapter');
  if (typeof target !== 'string' || !target.trim()) throw new Error('legacy consumer target missing');
  fs.mkdirSync(evidence, { recursive: true });
  const instance = fs.mkdtempSync(path.join(root, 'legacy-consumer-'));
  const readyFile = path.join(instance, 'ready.json');
  const receiptFile = path.join(evidence, `${path.basename(instance)}.json`);
  const output = path.join(evidence, `${path.basename(instance)}.log`);
  const worker = path.join(instance, 'start.mjs');
  // Observe the service's own instance lock. Port 0 asks the kernel for an
  // unused private port; never reserve/release a guessed port or try 47391.
  fs.writeFileSync(worker, `import fs from 'node:fs'; import net from 'node:net';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  if (args[0] !== 0 || args[1] !== '127.0.0.1') throw Error('unexpected legacy instance lock');
  net.Server.prototype.listen = listen;
  this.once('listening', () => { fs.writeFileSync(${JSON.stringify(`${readyFile}.tmp`)}, JSON.stringify({pid:process.pid,...this.address()})); fs.renameSync(${JSON.stringify(`${readyFile}.tmp`)}, ${JSON.stringify(readyFile)}); });
  return listen.apply(this, args);
};
await import(${JSON.stringify(pathToFileURL(script).href)});
`);
  const selected = { ...env };
  for (const key of Object.keys(selected)) if (/^(SE_|NW_|HERDR_(PANE|TAB|WORKSPACE)_ID$)/.test(key)) delete selected[key];
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']) delete selected[key];
  Object.assign(selected, { ORG_DIR: org, ACCEPTANCE_PINNED_ORG: org,
    SE_ROOT: copy, SE_SUP: sup, SE_WAITERS: path.join(instance, 'waiters'),
    SE_GATE_REQ: path.join(instance, 'gates'), SE_SLOT_LOCK: path.join(instance, 'slot.lock'),
    SE_ORG_EVENTS: path.join(org, 'events.jsonl'), SE_HERDR: herdr, SE_SUPERVISOR: target,
    SE_LOCK_PORT: '0' });
  const receipt = { kind: 'cutover-legacy-consumer', copy, org, target, script, instance,
    requestedPort: 0, states: [] };
  const save = (state, details = {}) => {
    receipt.states.push({ state, at: new Date().toISOString(), ...details });
    fs.writeFileSync(`${receiptFile}.tmp`, JSON.stringify(receipt, null, 2));
    fs.renameSync(`${receiptFile}.tmp`, receiptFile);
  };
  save('starting');
  const fd = fs.openSync(output, 'a');
  let child;
  try { child = launch(process.execPath, [worker], { cwd: copy, env: selected, stdio: ['ignore', fd, fd] }); }
  catch (error) { save('failed', { error: error.message }); throw error; }
  finally { fs.closeSync(fd); }
  receipt.pid = child.pid;
  let ended = false, failure, stopping, receiptFailure;
  const observe = (state, details) => { try { save(state, details); } catch (error) { receiptFailure = error; } };
  child.once('error', error => { failure = error; ended = true; observe('failed', { error: error.message }); });
  child.once('exit', (code, signal) => { ended = true; observe('exited', { code, signal }); });
  const handle = { receiptFile, instance, pid: child.pid,
    stop() {
      return stopping ??= (async () => {
        const errors = [];
        const record = (state) => { try { save(state); } catch (error) { errors.push(error); } };
        if (!ended) {
          record('stopping'); child.kill('SIGTERM');
          try { await waitUntil(() => ended, 'legacy consumer stopped', timeoutMs, { load }); }
          catch {
            record('killing'); child.kill('SIGKILL');
            await waitUntil(() => ended, 'legacy consumer killed', timeoutMs, { load });
          }
        }
        for (const name of ['supervisor-events.log', 'inbox.log', 'notify-log.tsv']) {
          const file = path.join(sup, name === 'supervisor-events.log' ? 'watch-logs' : '', name);
          try { if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, `${path.basename(instance)}-${name}`)); }
          catch (error) { errors.push(error); }
        }
        record('stopped');
        if (receiptFailure) errors.push(receiptFailure);
        if (errors.length) throw new AggregateError(errors, 'legacy consumer stopped but lifecycle receipt failed');
      })();
    },
  };
  try {
    // Register the handle synchronously, before any readiness wait, so global
    // signal cleanup can drain even a partially started consumer.
    onStart(handle);
    save('spawned');
    await waitUntil(() => {
      if (ended) throw failure ?? new Error(`legacy consumer exited before ready; see ${output}`);
      if (!fs.existsSync(readyFile)) return false;
      const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      if (ready.pid !== child.pid || ready.address !== '127.0.0.1' || !Number.isInteger(ready.port) || ready.port <= 0)
        throw new Error('legacy consumer instance receipt mismatch');
      const pidFile = path.join(sup, 'watch-logs/supervisor-events.pid');
      if (!fs.existsSync(pidFile) || Number(fs.readFileSync(pidFile, 'utf8').trim()) !== child.pid) return false;
      receipt.port = ready.port;
      return true;
    }, 'legacy consumer ready', timeoutMs, { load });
    save('ready', { port: receipt.port });
    return handle;
  } catch (error) {
    try { save('startup-failed', { error: error.message }); }
    finally { await handle.stop(); }
    throw error;
  }
}
