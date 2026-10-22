import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native argv refusals identify the denied row, escape comm and retain the original errno', {
  skip: process.platform !== 'darwin' && 'Darwin native source',
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-source-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'fixture.c'), executable = path.join(root, 'fixture');
  // Compile the real reader with deterministic kernel replies. This exercises
  // refusal formatting without changing the bundled reader or host permissions.
  fs.writeFileSync(source, `#include <errno.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
static int argv_error;
static int identity_reads, identity_mode;
static int fixture_sysctl(int *name, unsigned int count, void *output, size_t *size, void *input, size_t input_size) {
  (void)input; (void)input_size;
  if (count == 4 && name[1] == KERN_PROC) {
    identity_reads++;
    if (identity_reads == 2 && identity_mode == 1) { errno = EIO; return -1; }
    if (identity_reads == 2 && identity_mode == 3) { *size = 0; return 0; }
    struct kinfo_proc *info = output;
    memset(info, 0, sizeof(*info)); *size = sizeof(*info);
    info->kp_proc.p_pid = 101; info->kp_eproc.e_ppid = 77; info->kp_eproc.e_pgid = 101;
    info->kp_proc.p_stat = SRUN;
    info->kp_proc.p_starttime.tv_sec = 1700000000; info->kp_proc.p_starttime.tv_usec = 123456;
    memcpy(info->kp_proc.p_comm, "fixture\\\"\\n\\\\", 10);
    if (identity_reads == 2 && identity_mode == 2) {
      info->kp_proc.p_starttime.tv_usec++;
      memcpy(info->kp_proc.p_comm, "replacement", 12);
    }
    return 0;
  }
  if (count == 2 && name[1] == KERN_ARGMAX) { *(int *)output = 4096; *size = sizeof(int); return 0; }
  errno = argv_error; return -1;
}
static int fixture_listpids(uint32_t type, uint32_t uid, void *buffer, int size) {
  (void)type; (void)uid; (void)size;
  if (buffer) *(pid_t *)buffer = 101;
  return sizeof(pid_t);
}
#define sysctl fixture_sysctl
#define proc_listpids fixture_listpids
#define main reader_main
#include ${JSON.stringify(fileURLToPath(new URL('../lib/process-source.c', import.meta.url)))}
#undef main
int main(int argc, char **argv) {
  argv_error = !strcmp(argv[1], "EPERM") ? EPERM : !strcmp(argv[1], "EACCES") ? EACCES : !strcmp(argv[1], "EIO") ? EIO : EINVAL;
  const char *mode = argc == 3 ? argv[2] : "";
  identity_mode = !strcmp(mode, "identity-error") ? 1 : !strcmp(mode, "birth-change") ? 2 : !strcmp(mode, "gone") ? 3 : 0;
  char *args[] = {"reader", "101", NULL};
  return reader_main(!strcmp(mode, "snapshot") ? 1 : 2, args);
}
`);
  const built = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-o', executable, source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(built.status, 0, built.error?.message ?? built.stderr);
  const comm = 'fixture"\n\\';
  for (const error of ['EPERM', 'EACCES']) for (const mode of ['', 'snapshot', 'identity-error', 'birth-change']) {
    const result = spawnSync(executable, [error, ...(mode ? [mode] : [])], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 125, result.stderr);
    assert.equal(result.stdout, '', 'a denied row supplies no identity');
    const message = error === 'EPERM' ? 'Operation not permitted' : 'Permission denied';
    const lines = result.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 2, 'comm cannot inject a diagnostic line');
    const prefix = 'KERN_PROCARGS2 pid=101 p_comm=';
    const suffix = `: ${message} (ppid=77 pgid=101 birth=1700000000:123456)`;
    assert.ok(lines[0].startsWith(prefix), result.stderr);
    assert.ok(lines[0].endsWith(suffix), result.stderr);
    assert.equal(JSON.parse(lines[0].slice(prefix.length, -suffix.length)), comm);
    const finalError = mode === 'identity-error' ? 'Input/output error' : message;
    assert.equal(lines[1], `process source unavailable or incomplete: ${finalError}`);
  }
  for (const error of ['EPERM', 'EACCES']) {
    const result = spawnSync(executable, [error, 'gone'], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 1, 'a confirmed absent row retains the existing gone result');
    assert.equal(result.stdout + result.stderr, '');
  }
  for (const error of ['EIO', 'EINVAL']) {
    const result = spawnSync(executable, [error], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'the existing no-argv fallback remains readable');
    assert.equal(JSON.parse(result.stdout).command, `[${comm}]`);
  }
});
