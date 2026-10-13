// The test file alone holds the FIFO's writer. EOF survives SIGKILL, blocked
// JS and detached product launchers. A guard signals only its still-live parent:
// reparenting proves that the original target has gone, so PID reuse is harmless.
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void guard(const char *fifo, int seconds, pid_t owner) {
  int fd = open(fifo, O_RDONLY | O_NONBLOCK);
  struct timespec start, now;
  if (clock_gettime(CLOCK_MONOTONIC, &start)) _exit(125);
  for (;;) {
    if (getppid() != owner) _exit(0);
    struct pollfd pipe = { .fd = fd, .events = POLLIN };
    int result = fd < 0 ? -1 : poll(&pipe, 1, 5);
    if (result < 0 && errno == EINTR) continue;
    // Nonblocking read distinguishes no data (EAGAIN) from no writer (EOF).
    // Do not depend on platform-specific FIFO readiness notifications.
    char byte;
    int eof = fd >= 0 && read(fd, &byte, 1) == 0;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) _exit(125);
    if (result < 0 || eof || (result && (pipe.revents & (POLLHUP | POLLERR | POLLNVAL))) ||
        now.tv_sec - start.tv_sec >= seconds) {
      if (getppid() == owner) kill(owner, SIGKILL);
      _exit(0);
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 4) return 125;
  int seconds = atoi(argv[3]);
  if (seconds < 1) return 125;
  if (!strcmp(argv[1], "--watch")) guard(argv[2], seconds, getppid());
  if (strcmp(argv[1], "--exec") || argc < 5) return 125;
  pid_t owner = getpid(), child = fork();
  if (child < 0) return 125;
  if (!child) {
    // A guard must never retain the target's IPC or output pipes.
    long maximum = sysconf(_SC_OPEN_MAX);
    for (int fd = 0; fd < maximum; fd++) close(fd);
    guard(argv[2], seconds, owner);
  }
  execvp(argv[4], &argv[4]);
  return 125;
}
