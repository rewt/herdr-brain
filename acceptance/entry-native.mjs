// Transparent transport for the no-inference entry canary. Its parent already
// confines the whole installed entry and native UI with a scratch-only sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nativeEntryReceipt } from './entry.mjs';
const [file, ...args] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
const receipt = nativeEntryReceipt(spec.kind, args, spec.installation, process.cwd());
if (spec.kind === 'codex' && typeof receipt.policy === 'string') {
  // This freshly generated home has no user settings. Match the existing UI
  // canary's scratch trust setup so readiness observes the actual native UI.
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), `[projects.${JSON.stringify(process.cwd())}]\ntrust_level="trusted"\n`);
}
const child = spawn(spec.binary, args, { stdio: 'inherit', env: process.env });
child.on('spawn', () => {
  // Native sandbox capability probes use this executable too. They carry no
  // entry policy and must never overwrite the actual session's receipt.
  if (typeof receipt.policy === 'string') fs.writeFileSync(spec.receipt, JSON.stringify({ ...receipt, nativePid: child.pid }, null, 2));
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  // Observe the actual UI child before transport/adapter cleanup. Capability
  // probes must not overwrite the interactive session's termination evidence.
  if (typeof receipt.policy === 'string') fs.writeFileSync(spec.nativeDone, JSON.stringify({ nativePid: child.pid, code, signal }));
});
child.on('close', code => { process.exitCode = code ?? 1; });
