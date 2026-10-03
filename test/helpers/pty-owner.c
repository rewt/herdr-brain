// script execs this owner as its session leader. Keep that session identity
// alive through cleanup; no process outside the session can join it. The Node
// fixture policy prevents new sessions in its descendants. Native test commands
// that deliberately detach still need their own independent lifetime owner.
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
#ifdef __APPLE__
#include <libproc.h>
#include <mach/message.h>
struct identity { uint8_t uuid[16]; uint64_t unique, parent; int32_t version; uint32_t r2; uint64_t r3, r4; };
static int signal_member(pid_t pid, int sig) {
  struct identity id;
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, 17 /* PROC_PIDUNIQIDENTIFIERINFO */, 0, &id, sizeof(id)) != sizeof(id)) return 0;
  if (getsid(pid) != getpid()) return 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return -1;
  if (info.pbi_status == 5 /* zombie */) return 0;
  // The token pins this candidate even if it exits/reuses its PID after getsid.
  audit_token_t token = {{0}}; token.val[5] = pid; token.val[7] = id.version;
  int error = proc_signal_with_audittoken(&token, sig);
  return error && error != ESRCH ? -1 : 1;
}
static int sweep(int sig) {
  int size = proc_listallpids(NULL, 0);
  if (size <= 0) return -1;
  int capacity = size + 1024, found = 0;
  pid_t *pids = calloc(capacity, sizeof(*pids));
  if (!pids) return -1;
  int count = proc_listallpids(pids, capacity * sizeof(*pids));
  if (count <= 0 || count >= capacity) { free(pids); return -1; }
  for (int i = 0; i < count; i++) {
    if (pids[i] <= 1 || pids[i] == getpid()) continue;
    int member = signal_member(pids[i], sig);
    if (member < 0) { free(pids); return -1; }
    found += member;
  }
  free(pids); return found;
}
#else
#include <dirent.h>
#include <sys/syscall.h>
static int sweep(int sig) {
  DIR *directory = opendir("/proc");
  if (!directory) return -1;
  struct dirent *entry; int found = 0;
  while ((entry = readdir(directory))) {
    char *end; long value = strtol(entry->d_name, &end, 10);
    if (*end || value <= 1 || value == getpid()) continue;
    pid_t pid = (pid_t)value;
    if (getsid(pid) != getpid()) continue;
    int fd = syscall(SYS_pidfd_open, pid, 0);
    if (fd < 0) { if (errno == ESRCH) continue; closedir(directory); return -1; }
    // Confirm membership after pinning the process, never signal a reused PID.
    if (getsid(pid) != getpid()) { close(fd); continue; }
    char file[64], line[4096]; snprintf(file, sizeof(file), "/proc/%d/stat", pid);
    FILE *stat = fopen(file, "r");
    if (!stat) { close(fd); continue; }
    char *read = fgets(line, sizeof(line), stat); fclose(stat);
    char *state = read ? strrchr(line, ')') : NULL;
    if (!state) { close(fd); closedir(directory); return -1; }
    if (state[2] == 'Z') { close(fd); continue; }
    int result = syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0), error = errno;
    close(fd);
    if (result && error != ESRCH) { closedir(directory); return -1; }
    found++;
  }
  closedir(directory); return found;
}
#endif
static volatile sig_atomic_t stopped;
static void interrupted(int sig) { stopped = sig; }
static uint64_t milliseconds(void) { struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now); return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000; }
static void pause_scan(void) { struct timespec delay = {0, 10000000}; nanosleep(&delay, NULL); }
int main(int argc, char **argv) {
  if (argc < 4 || getsid(0) != getpid() || !isatty(0)) {
    fprintf(stderr, "PTY owner requires its own live terminal session\n"); return 125;
  }
  char *end; unsigned long duration = strtoul(argv[1], &end, 10);
  // The JavaScript transport passes its measured-load allowance. Keep the
  // native watchdog finite without rejecting allowances above the 15s base.
  if (*end || !duration || duration > INT32_MAX) return 125;
  unsigned long cleanup_duration = strtoul(argv[2], &end, 10);
  if (*end || !cleanup_duration || cleanup_duration > INT32_MAX) return 125;
  uint64_t deadline = milliseconds() + duration;
  pid_t parent = getppid();
  signal(SIGTERM, interrupted); signal(SIGINT, interrupted); signal(SIGHUP, interrupted);
  pid_t child = fork(); if (child < 0) return 125;
  if (!child) {
    // Inherit script's foreground group and controlling terminal. Interactive
    // shells may manage their own job groups; cleanup covers the whole session.
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
    char session[32]; snprintf(session, sizeof(session), "%ld", (long)getppid());
    if (setenv("HERDR_TEST_PTY_SESSION", session, 1)) _exit(125);
    execvp(argv[3], &argv[3]); perror("PTY exec"); _exit(125);
  }
  int status = 0, complete = 0, expired = 0;
  for (;;) {
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) { complete = 1; break; }
    if (result < 0) { if (errno == EINTR) continue; stopped = SIGTERM; break; }
    if (getppid() != parent) stopped = SIGHUP;
    if (stopped || milliseconds() >= deadline) { expired = !stopped; break; }
    pause_scan();
  }
  // Freeze producers before killing session members, including separate job
  // groups and grandchildren whose parent already exited. Repeat to close forks
  // that raced the first enumeration; the retained session leader is the anchor.
  uint64_t cleanup = milliseconds() + cleanup_duration; int empty = 0, failed = 0;
  while (empty < 3 && milliseconds() < cleanup) {
    if (sweep(SIGSTOP) < 0) { failed = 1; break; }
    int count = sweep(SIGKILL);
    if (count < 0) { failed = 1; break; }
    if (!complete && waitpid(child, &status, WNOHANG) == child) complete = 1;
    empty = count ? 0 : empty + 1; pause_scan();
  }
  if (failed || empty < 3) { fprintf(stderr, "PTY session cleanup unconfirmed\n"); return 125; }
  if (expired) { fprintf(stderr, "PTY command %s exceeded %lu milliseconds\n", argv[3], duration); return 124; }
  if (stopped) return 128 + stopped;
  return complete && WIFEXITED(status) ? WEXITSTATUS(status) : complete ? 128 + WTERMSIG(status) : 125;
}
