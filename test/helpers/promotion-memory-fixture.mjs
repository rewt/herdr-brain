import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../lib/files.mjs';

export const healthyMemory = { available: 8 * 1024 ** 3, swap_used: 0 };
export const pressuredMemory = { ...healthyMemory, available: 128 * 1024 ** 2 };

let directory, sequence = 0;
// Each fixture owns its sample: neither the host nor a pressure injection in a
// sibling fixture may decide whether its real lifecycle gate can start.
export function healthyMemoryEnvironment(env = process.env) {
  if (!directory) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthy-memory-'));
    process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
  }
  const file = path.join(directory, `${++sequence}.json`);
  fs.writeFileSync(file, JSON.stringify(healthyMemory));
  const preload = new URL('./memory-fixture.mjs', import.meta.url).href;
  return { ...env, TEST_MEMORY_FILE: file,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` };
}

// Native measurements are faked, but promotion's real locks and slot remain in
// use. A one-shot preload injects pressure exactly after the chosen acquisition.
export function promotionMemoryFixture(f, stage) {
  const file = path.join(f.root, 'memory.json'), ready = path.join(f.root, 'memory-injected');
  const armed = path.join(f.root, 'memory-armed'), preload = path.join(f.root, 'inject-memory.mjs');
  const set = value => writeFileAtomic(file, JSON.stringify(value));
  set(healthyMemory); fs.writeFileSync(armed, 'armed');
  f.env.TEST_MEMORY_FILE = file;
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const inject = () => {
  if (!fs.existsSync(${JSON.stringify(armed)})) return;
  fs.unlinkSync(${JSON.stringify(armed)});
  fs.writeFileSync(${JSON.stringify(file + '.tmp')}, ${JSON.stringify(JSON.stringify(pressuredMemory))});
  fs.renameSync(${JSON.stringify(file + '.tmp')}, ${JSON.stringify(file)});
  fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
};
${stage === 'project-lock' ? `const original = fs.mkdirSync;
fs.mkdirSync = function(directory, ...args) {
  const result = original.call(this, directory, ...args);
  if (String(directory) === ${JSON.stringify(path.join(f.repo, '.git/lane-promote.lock'))}) inject();
  return result;
};
syncBuiltinESMExports();` : `if (process.argv[2] === ${JSON.stringify(stage)}) inject();`}
`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(new URL('./memory-fixture.mjs', import.meta.url).href)} --import=${JSON.stringify(preload)}`;
  return { file, ready, set };
}
