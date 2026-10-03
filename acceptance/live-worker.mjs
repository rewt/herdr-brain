// Runs a real Codex session in an owned Herdr PTY. Runtime files use a scratch
// home; the native workspace-write sandbox confines the agent's tool writes.
import { loadTimeout } from './deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { permissionArgs, sessionEnv } from './security.mjs';
import { registerProducer, producersStopping } from './producers.mjs';
const [root, name] = process.argv.slice(2);
const producer = registerProducer(root, 'live-worker');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'live-jobs', `${name}.json`), 'utf8'));
const log = path.join(root, 'evidence', `${name}.jsonl`);
const errors = path.join(root, 'evidence', `${name}.stderr`);
const out = fs.openSync(log, 'w'), err = fs.openSync(errors, 'w');
const child = spawn(spec.entryBinary ?? spec.binary, [...(spec.entryBinary ? ['--'] : ['--no-daemon']), 'exec',
  '--ephemeral', '--ignore-user-config', '--ignore-rules', '--add-dir', spec.temp, '--json',
  ...permissionArgs(spec), '--output-schema', spec.schema,
  ...(spec.entryBinary ? [] : ['-C', spec.repo]), '--model', spec.model, '-c', `model_reasoning_effort=${spec.effort}`,
  '-c', `log_dir=${JSON.stringify(path.join(root, 'codex-logs'))}`,
  '-c', `sqlite_home=${JSON.stringify(path.join(root, 'codex-state'))}`,
  '-c', 'features.shell_snapshot=false', '-c', 'web_search="disabled"',
  '-c', 'approval_policy="never"', '-c', 'allow_login_shell=false',
  '-c', 'shell_environment_policy.inherit="all"', '-o', path.join(root, 'evidence', `${name}.txt`), spec.prompt], {
  cwd: spec.repo, env: { ...sessionEnv(process.env, spec), ...(spec.entryBinary ? {
    MONITOR_RUNTIME_DIR: path.join(spec.temp, 'entry-requests'), MONITOR_WORKTREE_ROOT: spec.worktreeRoot,
  } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
producer.child(child.pid);
child.stdout.on('data', (v) => { fs.writeSync(out, v); process.stdout.write(v); });
child.stderr.on('data', (v) => { fs.writeSync(err, v); process.stderr.write(v); });
let killTimer;
const stop = () => {
  child.kill('SIGTERM');
  killTimer ??= setTimeout(() => child.kill('SIGKILL'), loadTimeout(1000));
};
const timer = setTimeout(stop, loadTimeout(180_000));
const stopTimer = setInterval(() => {
  if (!producersStopping(root)) return;
  clearInterval(stopTimer);
  stop();
}, 25);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });
child.on('error', (e) => { fs.writeSync(err, e.message); });
child.on('close', (code, signal) => {
  clearTimeout(timer); clearInterval(stopTimer); clearTimeout(killTimer);
  producer.child(child.pid, false);
  fs.closeSync(out); fs.closeSync(err);
  fs.rmSync(spec.runtimeHome, { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'live-jobs', `${name}.done`), JSON.stringify({ code, signal }));
  producer.release();
});
