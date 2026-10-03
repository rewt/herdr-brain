// Read-only Darwin process source. No setuid executable or compiler at runtime.
#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

static int gone(void) { return errno == ESRCH || errno == ENOENT; }
static void json_string(const char *text) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static int identity_only;
// KERN_PROC_PID exposes births across uids without setuid. PROC_PIDTBSDINFO
// restricts unprivileged callers to their own uid, hiding foreign PID reuse.
// Only an absent kernel row proves exit; denied or incomplete reads refuse.
static int read_identity(pid_t pid, struct kinfo_proc *info) {
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  size_t size = sizeof(*info);
  memset(info, 0, size);
  errno = 0;
  if (sysctl(mib, 4, info, &size, NULL, 0)) return gone() ? 0 : -1;
  if (!size) return 0;
  if (size != sizeof(*info) || info->kp_proc.p_pid != pid ||
      info->kp_proc.p_starttime.tv_sec <= 0 || info->kp_proc.p_starttime.tv_usec < 0 ||
      info->kp_proc.p_starttime.tv_usec >= 1000000) { errno = EIO; return -1; }
  return 1;
}
static int same_birth(const struct kinfo_proc *before, const struct kinfo_proc *after) {
  return before->kp_proc.p_pid == after->kp_proc.p_pid &&
    before->kp_proc.p_starttime.tv_sec == after->kp_proc.p_starttime.tv_sec &&
    before->kp_proc.p_starttime.tv_usec == after->kp_proc.p_starttime.tv_usec;
}
static char *kernel_command(const struct kinfo_proc *info) {
  char *command = calloc(sizeof(info->kp_proc.p_comm) + 3, 1);
  if (command) snprintf(command, sizeof(info->kp_proc.p_comm) + 3, "[%.*s]", (int)sizeof(info->kp_proc.p_comm), info->kp_proc.p_comm);
  return command;
}
static int lookup(pid_t pid) {
  struct kinfo_proc before, after;
  int result = read_identity(pid, &before);
  if (result != 1) return result;
  char *command = NULL;
  if (identity_only) command = kernel_command(&before);
  else if (before.kp_proc.p_stat == SZOMB) command = strdup("<defunct>");
  else {
    int limit, key[] = {CTL_KERN, KERN_ARGMAX}; size_t size = sizeof(limit);
    if (sysctl(key, 2, &limit, &size, NULL, 0) || limit <= 0 || limit > 16 * 1024 * 1024) return -1;
    char *args = calloc((size_t)limit + 1, 1);
    if (!args) return -1;
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid}; size = limit;
    if (sysctl(mib, 3, args, &size, NULL, 0)) {
      int error = errno; free(args);
      // Exit may change a readable live row into a zombie between these calls.
      // Confirm that through a new kernel read, never infer absence from EIO.
      result = read_identity(pid, &after);
      if (result != 1) return result;
      if (!same_birth(&before, &after)) return -1;
      if (after.kp_proc.p_stat == SZOMB) command = strdup("<defunct>");
      // Like ps, retain the kernel command name when no argument vector exists
      // (e.g. during exec/exit). A denied read never receives this fallback.
      else if (error == EINVAL || error == EIO) {
        command = kernel_command(&after);
      } else { errno = error; return -1; }
    } else {
      if (size < sizeof(int)) { free(args); return -1; }
      int argc; memcpy(&argc, args, sizeof(argc));
      char *cursor = args + sizeof(argc), *end = args + size;
      char *zero = memchr(cursor, 0, end - cursor);
      if (!zero || argc < 1) { free(args); return -1; }
      cursor = zero + 1;
      while (cursor < end && !*cursor) cursor++;
      command = calloc(size + 1, 1);
      if (!command) { free(args); return -1; }
      size_t used = 0;
      for (int i = 0; i < argc; i++) {
        zero = cursor < end ? memchr(cursor, 0, end - cursor) : NULL;
        if (!zero) { free(command); free(args); return -1; }
        if (i) command[used++] = ' ';
        size_t length = zero - cursor; memcpy(command + used, cursor, length); used += length;
        cursor = zero + 1;
      }
      free(args);
    }
  }
  if (!command || !*command) { free(command); return -1; }
  result = read_identity(pid, &after);
  if (result != 1) {
    free(command); return result;
  }
  if (!same_birth(&before, &after)) { free(command); return -1; }
  const char *states[] = {"?", "I", "R", "S", "T", "Z"};
  if (after.kp_proc.p_stat < 1 || after.kp_proc.p_stat > 5) { free(command); return -1; }
  printf("{\"pid\":%d,\"ppid\":%d,\"pgid\":%d,\"state\":\"%s\",\"identity\":\"%llu:%llu\",\"command\":",
    after.kp_proc.p_pid, after.kp_eproc.e_ppid, after.kp_eproc.e_pgid, states[(int)after.kp_proc.p_stat],
    (unsigned long long)after.kp_proc.p_starttime.tv_sec, (unsigned long long)after.kp_proc.p_starttime.tv_usec);
  json_string(command); puts("}"); free(command); return 1;
}
int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--identity")) { identity_only = 1; argc--; argv++; }
  if (argc == 2) {
    char *end; long pid = strtol(argv[1], &end, 10);
    if (*end || pid < 1 || pid > INT32_MAX) return 125;
    int result = lookup((pid_t)pid);
    if (result >= 0) return result ? 0 : 1;
  } else if (argc == 1) {
    // All owned groups have this uid. Other users' argv may be unreadable and
    // cannot be fixtures; do not make their permissions a suite prerequisite.
    int bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
    if (bytes <= 0) goto failed;
    int capacity = bytes + 4096;
    pid_t *pids = calloc(1, capacity);
    if (!pids) goto failed;
    int count = proc_listpids(PROC_UID_ONLY, getuid(), pids, capacity);
    if (count <= 0 || count >= capacity || count % sizeof(pid_t)) { free(pids); goto failed; }
    for (int i = 0; i < count / (int)sizeof(pid_t); i++) {
      if (pids[i] > 0 && lookup(pids[i]) < 0) { free(pids); goto failed; }
    }
    free(pids); return 0;
  }
failed:
  fprintf(stderr, "process source unavailable or incomplete: %s\n", strerror(errno)); return 125;
}
