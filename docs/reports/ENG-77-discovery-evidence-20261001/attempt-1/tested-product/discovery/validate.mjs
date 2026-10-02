#!/usr/bin/env node
// Only called by trusted entry code. Project validation and preparation retain
// the native workspace-write sandbox, including protected Git metadata.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [binary, cwd] = process.argv.slice(2);
try {
  const file = process.env.MONITOR_PROJECT_CONFIG;
  const config = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const localFile = path.join(cwd, '.lane.json');
  const localConfig = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : {};
  const settings = { ...config, ...localConfig };
  let validate = settings.validate;
  if (!validate && fs.existsSync(path.join(cwd, 'package.json'))) {
    if (JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts?.test) validate = 'npm test';
  }
  if (!validate && fs.existsSync(path.join(cwd, 'test'))) validate = 'node --test';
  if (!validate) throw new Error('project validation is unknown; set validate in .lane.json to the real project check');
  const steps = [...(settings.prepare ?? []).filter((s) => !s.unless || !fs.existsSync(path.join(cwd, s.unless))).map((s) => s.run), validate];
  for (const step of steps) {
    if (typeof step !== 'string' || !step.trim()) throw new Error('invalid validation command');
    const r = spawnSync(binary, ['sandbox', '-C', cwd, '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_workspace_write.network_access=false', '--', 'sh', '-c', step], { cwd, stdio: 'inherit',
      env: { ...process.env, LANE_CONFIG: '', LANE_VALIDATE: '', MONITOR_REQUEST_DIR: '', ORG_DIR: '' } });
    if (r.error || r.status !== 0) throw new Error(r.error?.message ?? `sandboxed validation exited ${r.status}`);
  }
} catch (e) { console.error(`monitor validation: ${e.message}`); process.exitCode = 1; }
