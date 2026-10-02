// alarm survives exec and SIGALRM keeps its default disposition in Node.
// Even an event-loop hang or suite SIGKILL cannot outlive this kernel deadline.
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 2) return 125;
  signal(SIGALRM, SIG_DFL);
  sigset_t signals; sigemptyset(&signals); sigaddset(&signals, SIGALRM);
  if (sigprocmask(SIG_UNBLOCK, &signals, NULL)) return 125;
  char group[32]; snprintf(group, sizeof(group), "%ld", (long)getpgrp());
  if (setenv("HERDR_FIXTURE_PGID", group, 1)) return 125;
  alarm(6);
  execvp(argv[1], &argv[1]);
  return 125;
}
