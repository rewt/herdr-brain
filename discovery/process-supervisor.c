// Foreground validation owner. No process names, argv, environment, PID guesses
// or broad process-group signals authorize cleanup.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
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
extern int sandbox_check(pid_t, const char *, int, ...);
extern const int SANDBOX_CHECK_NO_REPORT;
struct identity { uint8_t uuid[16]; uint64_t unique, parent; int32_t version; uint32_t r2; uint64_t r3, r4; };
static const char *allowed, *denied;
static int identity(pid_t pid, struct identity *id) {
  return proc_pidinfo(pid, 17 /* PROC_PIDUNIQIDENTIFIERINFO */, 0, id, sizeof(*id)) == sizeof(*id);
}
static int tagged(pid_t pid) {
  int filter = 1 /* SANDBOX_FILTER_PATH */ | SANDBOX_CHECK_NO_REPORT;
  return sandbox_check(pid, "file-read-data", filter, allowed) == 0 &&
    sandbox_check(pid, "file-read-data", filter, denied) == 1;
}
static int signal_identity(pid_t pid, struct identity *id, int sig) {
  audit_token_t token = {{0}}; token.val[5] = pid; token.val[7] = id->version;
  return proc_signal_with_audittoken(&token, sig);
}
static int sweep(int sig) {
  int bytes = proc_listallpids(NULL, 0);
  if (bytes <= 0) return -1;
  int capacity = bytes + 1024;
  pid_t *pids = calloc(capacity, sizeof(*pids));
  if (!pids) return -1;
  int count = proc_listallpids(pids, capacity * sizeof(*pids)), found = 0;
  if (count <= 0 || count >= capacity) { free(pids); return -1; }
  for (int i = 0; i < count; i++) {
    pid_t pid = pids[i]; struct proc_bsdinfo info; struct identity before, after;
    if (pid <= 1 || pid == getpid()) continue;
    if (!tagged(pid)) continue;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != getuid()) { found++; continue; }
    if (info.pbi_status == 5 /* zombie */) continue;
    if (!identity(pid, &before) || !tagged(pid) || !identity(pid, &after) || before.unique != after.unique || before.version != after.version) { found++; continue; }
    int error = signal_identity(pid, &after, sig);
    if (error && error != ESRCH) { free(pids); return -1; }
    found++;
  }
  free(pids); return found;
}
#else
#include <sys/prctl.h>
static int sweep(int sig) {
  // Subreaper-adopted children cannot have their PIDs reused until we reap them.
  char file[128]; snprintf(file, sizeof(file), "/proc/self/task/%d/children", getpid());
  FILE *stream = fopen(file, "r"); if (!stream) return -1;
  int pid, count = 0;
  while (fscanf(stream, "%d", &pid) == 1) { if (kill(pid, sig) && errno != ESRCH) { fclose(stream); return -1; } count++; }
  fclose(stream); return count;
}
#endif
static volatile sig_atomic_t stopped;
static void interrupted(int sig) { stopped = sig; }
static uint64_t milliseconds(void) { struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now); return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000; }
static void pause_scan(void) { struct timespec delay = {0, 10000000}; nanosleep(&delay, NULL); }
int main(int argc, char **argv) {
#ifdef __APPLE__
  if (argc >= 5 && !strcmp(argv[1], "--enter")) {
    allowed = argv[2]; denied = argv[3];
    if (!tagged(getpid())) { fprintf(stderr, "validation lifetime marker is absent\n"); return 125; }
    // Ready receipt precedes all untrusted code; supervisor owns fd 3.
    if (write(3, "R", 1) != 1) return 125;
    close(3); execvp(argv[4], &argv[4]); perror("validation exec"); return 125;
  }
  if (argc < 6) return 125;
  allowed = argv[2]; denied = argv[3]; int first = 4;
#else
  if (argc < 3 || prctl(PR_SET_CHILD_SUBREAPER, 1)) { perror("validation subreaper"); return 125; }
  int first = 2;
#endif
  pid_t parent = getppid();
#ifndef __APPLE__
  if (prctl(PR_SET_PDEATHSIG, SIGTERM)) return 125;
#endif
  uint64_t duration = strtoull(argv[1], NULL, 10), deadline = milliseconds() + duration;
  if (!duration) return 125;
  signal(SIGTERM, interrupted); signal(SIGINT, interrupted); signal(SIGHUP, interrupted);
  int receipt[2]; if (pipe(receipt)) return 125;
  // A provider that retained fd 3 must not turn a missing receipt into a hang.
  if (fcntl(receipt[0], F_SETFL, O_NONBLOCK)) return 125;
  pid_t root = fork(); if (root < 0) return 125;
  if (!root) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
    close(receipt[0]); if (receipt[1] != 3) { dup2(receipt[1], 3); close(receipt[1]); }
    execvp(argv[first], &argv[first]); perror("validation launch"); _exit(125);
  }
  close(receipt[1]);
  int status = 0, expired = 0, reaped = 0;
  // waitid WNOWAIT holds the direct child's identity until all cleanup completes.
  for (;;) {
    siginfo_t info = {0};
    if (waitid(P_PID, root, &info, WEXITED | WNOHANG | WNOWAIT)) { status = 125 << 8; break; }
    if (info.si_pid) { status = info.si_code == CLD_EXITED ? info.si_status << 8 : info.si_status; break; }
    if (getppid() != parent) stopped = SIGTERM;
    if (stopped || milliseconds() >= deadline) { expired = !stopped; break; }
    pause_scan();
  }
  // The unreaped direct child is positively owned. Kill it first on Linux so
  // every orphan, including double forks/new sessions, is adopted by this owner.
  kill(root, SIGKILL);
  uint64_t cleanup_deadline = milliseconds() + 3000;
  int empty = 0, cleanup_error = 0;
  while (empty < 3 && milliseconds() < cleanup_deadline) {
    int count = sweep(SIGSTOP); if (count < 0) { cleanup_error = 1; break; }
    count = sweep(SIGKILL); if (count < 0) { cleanup_error = 1; break; }
#ifndef __APPLE__
    pid_t pid; int child_status;
    while ((pid = waitpid(-1, &child_status, WNOHANG)) > 0) { if (pid == root) reaped = 1; }
    if (pid < 0 && errno == ECHILD) count = 0; else if (!count) count = 1;
#endif
    empty = count == 0 ? empty + 1 : 0; pause_scan();
  }
  if (empty < 3) cleanup_error = 1;
  if (!reaped) waitpid(root, NULL, 0);
#ifdef __APPLE__
  char ready; if (read(receipt[0], &ready, 1) != 1 || ready != 'R') {
    if (!status) status = 125 << 8;
  }
#endif
  close(receipt[0]);
  if (cleanup_error) { fprintf(stderr, "validation descendant cleanup could not be confirmed\n"); return 125; }
  if (expired) { fprintf(stderr, "sandbox command exceeded %llu milliseconds\n", (unsigned long long)duration); return 124; }
  if (stopped) return 128 + stopped;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
