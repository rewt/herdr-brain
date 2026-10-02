// Runs a real Codex session in an owned Herdr PTY. Runtime files use a scratch
// home; the native workspace-write sandbox confines the agent's tool writes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [root, name] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(path.join(root, 'live-jobs', `${name}.json`), 'utf8'));
const log = path.join(root, 'evidence', `${name}.jsonl`);
const errors = path.join(root, 'evidence', `${name}.stderr`);
const out = fs.openSync(log, 'w'), err = fs.openSync(errors, 'w');
const child = spawn(spec.binary, ['--no-daemon', 'exec',
  '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write', '--add-dir', root, '--json',
  '-C', spec.repo, '--model', spec.model, '-c', `model_reasoning_effort=${spec.effort}`,
  '-c', `log_dir=${JSON.stringify(path.join(root, 'codex-logs'))}`,
  '-c', `sqlite_home=${JSON.stringify(path.join(root, 'codex-state'))}`,
  '-c', 'features.shell_snapshot=false', '-c', 'web_search="disabled"',
  '-c', 'approval_policy="on-request"', '-c', 'allow_login_shell=false',
  '-c', 'shell_environment_policy.inherit="all"', '-o', path.join(root, 'evidence', `${name}.txt`), spec.prompt], {
  cwd: spec.repo, env: { ...process.env, CODEX_HOME: spec.runtimeHome, PATH: spec.path, TMPDIR: root, ORG_ACTOR: name, ACCEPTANCE_ROOT: root },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (v) => { fs.writeSync(out, v); process.stdout.write(v); });
child.stderr.on('data', (v) => { fs.writeSync(err, v); process.stderr.write(v); });
const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });
child.on('error', (e) => { fs.writeSync(err, e.message); });
child.on('close', (code, signal) => {
  clearTimeout(timer); fs.closeSync(out); fs.closeSync(err);
  fs.rmSync(spec.runtimeHome, { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'live-jobs', `${name}.done`), JSON.stringify({ code, signal }));
});
