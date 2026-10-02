#!/usr/bin/env node
// Network namespaces do not hide filesystem Unix sockets. Deny creation of
// every socket as well, so project commands cannot reach a host control socket.
import fs from 'node:fs';
import { validationSyscalls } from './syscalls.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function socketFilter(arch = process.arch) {
  const spec = { x64: { audit: 0xc000003e, column: 1 }, arm64: { audit: 0xc00000b7, column: 2 } }[arch];
  if (!spec) throw new Error(`bubblewrap socket guard unavailable on ${arch}`);
  // Deny by default. Unknown/new syscalls, every networking entry point,
  // io_uring, ptrace, BPF and namespace attachment receive no allow rule.
  // Kill mismatched ABIs and deny x32 before comparing explicit ABI numbers.
  const instructions = [
    [0x20, 0, 0, 4], [0x15, 1, 0, spec.audit], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001],
    // libc retries ordinary clone after ENOSYS; clone3 stays denied.
    [0x15, 0, 1, 435], [0x06, 0, 0, 0x00050026],
    ...[...new Set(validationSyscalls.map((row) => row[spec.column]).filter((nr) => nr != null))]
      .flatMap((nr) => [[0x15, 0, 1, nr], [0x06, 0, 0, 0x7fff0000]]),
    [0x06, 0, 0, 0x00050001],
  ];
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], i) => {
    bytes.writeUInt16LE(code, i * 8); bytes[i * 8 + 2] = yes; bytes[i * 8 + 3] = no; bytes.writeUInt32LE(value, i * 8 + 4);
  });
  return bytes;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [optIn, binary, ...args] = process.argv.slice(2);
  let fd;
  try {
    if (optIn !== '--experimental-bubblewrap' || !path.isAbsolute(binary ?? ''))
      throw new Error('bubblewrap is experimental and disabled by default; explicit --experimental-bubblewrap ABSOLUTE_BWRAP is required (ENG-92)');
    const bytes = socketFilter();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-seccomp-'));
    const file = path.join(directory, 'sockets.bpf');
    try {
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); fd = fs.openSync(file, 'r');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    const child = spawn(binary, ['--seccomp', '3', ...args], { stdio: ['inherit', 'inherit', 'inherit', fd] });
    fs.closeSync(fd); fd = undefined;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
    child.on('close', (code) => { process.exitCode = code ?? 1; });
  } catch (e) { if (fd !== undefined) fs.closeSync(fd); console.error(e.message); process.exitCode = 1; }
}
