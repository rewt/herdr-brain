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
static int lookup(pid_t pid) {
  struct proc_bsdinfo before, after;
  errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)) return gone() ? 0 : -1;
  char *command = NULL;
  if (before.pbi_status == 5) command = strdup("<defunct>");
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
      errno = 0;
      if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) return gone() ? 0 : -1;
      if (before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec) return -1;
      if (after.pbi_status == 5) command = strdup("<defunct>");
      // Like ps, retain the kernel command name when no argument vector exists
      // (e.g. during exec/exit). A denied read never receives this fallback.
      else if (error == EINVAL || error == EIO) {
        command = calloc(sizeof(after.pbi_comm) + 3, 1);
        if (command) snprintf(command, sizeof(after.pbi_comm) + 3, "[%.*s]", (int)sizeof(after.pbi_comm), after.pbi_comm);
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
  errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) {
    int absent = gone(); free(command); return absent ? 0 : -1;
  }
  if (before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec ||
      before.pbi_pid != after.pbi_pid) { free(command); return -1; }
  const char *states[] = {"?", "I", "R", "S", "T", "Z"};
  if (after.pbi_status < 1 || after.pbi_status > 5) { free(command); return -1; }
  printf("{\"pid\":%u,\"ppid\":%u,\"pgid\":%u,\"state\":\"%s\",\"identity\":\"%llu:%llu\",\"command\":",
    after.pbi_pid, after.pbi_ppid, after.pbi_pgid, states[after.pbi_status],
    (unsigned long long)after.pbi_start_tvsec, (unsigned long long)after.pbi_start_tvusec);
  json_string(command); puts("}"); free(command); return 1;
}
int main(int argc, char **argv) {
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
