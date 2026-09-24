#!/usr/bin/env node
// Keeps the modern console open while its code changes, for review during
// iteration. A saved .mjs under console/, lib/ or bin/ restarts it in place;
// after q, Enter reopens it and Ctrl-C ends the loop. Arguments pass through:
//   node console/dev.mjs --project bch-cloak
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = [path.join(root, 'console/app.mjs'), '--modern', ...process.argv.slice(2)];
let child = null, restarting = false, timer = null, waiting = false;

function start() {
  waiting = false;
  process.stdin.removeListener('data', onKey);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  child = spawn(process.execPath, args, { stdio: 'inherit', cwd: root });
  child.on('exit', (code, signal) => {
    child = null;
    if (restarting) { restarting = false; return start(); }
    process.stdout.write(`\nconsole exited (${signal ?? code}). Enter reopens · a save reopens · Ctrl-C stops\n`);
    waiting = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', onKey).resume();
  });
}

function onKey(buf) {
  if (buf.includes(3)) process.exit(0);
  if (buf.includes(13) || buf.includes(10)) start();
}

function restart() {
  if (waiting) return start();
  if (!child) return;
  restarting = true;
  child.kill('SIGTERM');
}

for (const dir of ['console', 'lib', 'bin']) {
  fs.watch(path.join(root, dir), { recursive: true }, (_, file) => {
    if (!file || file.includes('node_modules') || !/\.m?js$/.test(file) || /(^|\/)test\//.test(file)) return;
    clearTimeout(timer); timer = setTimeout(restart, 200);
  });
}
process.on('SIGTERM', () => { child?.kill('SIGTERM'); process.exit(0); });
start();
