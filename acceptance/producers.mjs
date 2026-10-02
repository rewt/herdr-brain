import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const marker = root => path.join(root, 'producers-stopping');
export const producersStopping = root => fs.existsSync(marker(root));
export function assertProducing(root) {
  if (producersStopping(root)) throw new Error('acceptance producers stopped; no further commands allowed');
}
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

// Publish BEFORE testing the stop marker. Any admitted producer is therefore
// visible to cleanup; a registration racing after the marker cannot run work.
export function registerProducer(root, kind) {
  if (!fs.statSync(root).isDirectory()) throw new Error('acceptance scratch root missing');
  const directory = path.join(root, 'producers');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  const receipt = { pid: process.pid, kind, children: [] };
  const save = () => {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(receipt)); fs.renameSync(temporary, file);
  };
  save();
  try { assertProducing(root); }
  catch (error) { fs.rmSync(file, { force: true }); throw error; }
  let released = false;
  const release = () => {
    if (released) return;
    // Retain an orphan's receipt until its child also exits. Cleanup never
    // mistakes the parent's exit for completion of an active native call.
    if (receipt.children.some(alive)) return;
    fs.rmSync(file, { force: true }); released = true;
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return {
    release,
    child(pid, running = true) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      receipt.children = running ? [...new Set([...receipt.children, pid])] : receipt.children.filter(value => value !== pid);
      save();
    },
  };
}

export function stopProducers(root) {
  const fd = fs.openSync(marker(root), 'a');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export async function awaitProducers(root, { timeoutMs = 120_000 } = {}) {
  const directory = path.join(root, 'producers');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = [];
    for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(directory, entry);
      let receipt;
      try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 1 || !Array.isArray(receipt.children) ||
          receipt.children.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw new Error(`invalid producer receipt: ${entry}`);
      if (alive(receipt.pid) || receipt.children.some(alive)) pending.push(receipt);
      else fs.rmSync(file, { force: true });
    }
    if (!pending.length) return;
    if (Date.now() >= deadline) throw new Error(`acceptance producers did not stop: ${JSON.stringify(pending)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
export async function stopAndAwaitProducers(root, options) {
  stopProducers(root);
  await awaitProducers(root, options);
}
