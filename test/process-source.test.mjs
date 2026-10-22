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
static int fixture_sysctl(int *name, unsigned int count, void *output, size_t *size, void *input, size_t input_size) {
  (void)input; (void)input_size;
  if (count == 4 && name[1] == KERN_PROC) {
    struct kinfo_proc *info = output;
    memset(info, 0, sizeof(*info)); *size = sizeof(*info);
    info->kp_proc.p_pid = 101; info->kp_eproc.e_ppid = 77; info->kp_eproc.e_pgid = 101;
    info->kp_proc.p_stat = SRUN;
    info->kp_proc.p_starttime.tv_sec = 1700000000; info->kp_proc.p_starttime.tv_usec = 123456;
    memcpy(info->kp_proc.p_comm, "fixture\\\"\\n\\\\", 10);
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
  char *args[] = {"reader", "101", NULL};
  return reader_main(argc == 3 ? 1 : 2, args);
}
`);
  const built = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-o', executable, source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(built.status, 0, built.error?.message ?? built.stderr);
  const comm = 'fixture"\n\\';
  for (const error of ['EPERM', 'EACCES']) for (const snapshot of [false, true]) {
    const result = spawnSync(executable, [error, ...(snapshot ? ['snapshot'] : [])], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 125, result.stderr);
    assert.equal(result.stdout, '', 'a denied row supplies no identity');
    const message = error === 'EPERM' ? 'Operation not permitted' : 'Permission denied';
    assert.deepEqual(result.stderr.trimEnd().split('\n'), [
      `KERN_PROCARGS2 pid=101 p_comm=${JSON.stringify(comm)}: ${message} (ppid=77 pgid=101 birth=1700000000:123456)`,
      `process source unavailable or incomplete: ${message}`,
    ]);
  }
  for (const error of ['EIO', 'EINVAL']) {
    const result = spawnSync(executable, [error], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'the existing no-argv fallback remains readable');
    assert.equal(JSON.parse(result.stdout).command, `[${comm}]`);
  }
});
