// The test file alone holds the FIFO's writer. EOF survives SIGKILL, blocked
// JS and detached product launchers. A guard signals only its still-live parent:
// reparenting proves that the original target has gone, so PID reuse is harmless.
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/event.h>
#endif

static int completion = -1, guard_created;
static int transfer(int fd, void *bytes, size_t size, int writing) {
  while (size) {
    ssize_t count = writing ? write(fd, bytes, size) : read(fd, bytes, size);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      if (!count) errno = EPIPE;
      return -1;
    }
    bytes = (char *)bytes + count;
    size -= (size_t)count;
  }
  return 0;
}

// Deprecated NOTE_REAP still needs host proof. No NOTE_EXIT/EOF/time fallback.
static int join_guard(void) {
#ifdef __APPLE__
  pid_t pid;
  char ack = 'R';
  int queue = kqueue(), status = 125;
  struct kevent change, event;
  signal(SIGPIPE, SIG_IGN);
  if (queue < 0) { perror("fixture guard kqueue"); return 125; }
  if (transfer(0, &pid, sizeof(pid), 0)) goto done;
  if (!pid) { status = 126; goto done; } // Explicit pre-fork NO_GUARD.
  if (pid <= 1) { errno = EPROTO; goto done; }
  EV_SET(&change, pid, EVFILT_PROC, EV_ADD, NOTE_REAP, 0, NULL);
  if (kevent(queue, &change, 1, NULL, 0, NULL) < 0) goto done;
  if (transfer(3, &ack, 1, 1) || transfer(0, &ack, 1, 0)) goto done;
  if (ack != 'R') { errno = EPROTO; goto done; }
  int count;
  do { count = kevent(queue, NULL, 0, &event, 1, NULL); } while (count < 0 && errno == EINTR);
  if (count == 1 && (event.flags & EV_ERROR)) errno = (int)event.data;
  if (count == 1 && event.ident == (uintptr_t)pid && event.filter == EVFILT_PROC &&
      !(event.flags & EV_ERROR) && (event.fflags & NOTE_REAP) &&
      dprintf(1, "%ld %d %u\n", (long)pid, event.filter, event.fflags) > 0) status = 0;
done:
  if (status == 125) perror("fixture guard join failed");
  close(0); close(3); close(queue);
  return status;
#else
  return 125;
#endif
}

static void guard(const char *fifo, pid_t owner, int out, int ack_fd) {
  int fd = open(fifo, O_RDONLY | O_NONBLOCK);
  int confirmed = ack_fd < 0, finished = 0;
  pid_t pid = getpid();
  if (out >= 0 && transfer(out, &pid, sizeof(pid), 1)) _exit(125);
  for (;;) {
    if (getppid() != owner) finished = 1;
    if (finished && confirmed) _exit(0);
    struct pollfd pipes[2] = { { .fd = fd, .events = POLLIN }, { .fd = ack_fd, .events = POLLIN } };
    int result = poll(pipes, confirmed ? 1 : 2, 5);
    if (result < 0 && errno == EINTR) continue;
    // Nonblocking read distinguishes no data (EAGAIN) from no writer (EOF).
    // Do not depend on platform-specific FIFO readiness notifications.
    char byte;
    int eof = fd >= 0 && read(fd, &byte, 1) == 0;
    if (!finished && (fd < 0 || result < 0 || eof || (pipes[0].revents & (POLLHUP | POLLERR | POLLNVAL)))) {
      if (getppid() == owner) kill(owner, SIGKILL);
      finished = 1;
    }
    if (!confirmed && pipes[1].revents) {
      char ack;
      if (transfer(ack_fd, &ack, 1, 0) || ack != 'R' || transfer(out, &ack, 1, 1)) _exit(125);
      close(out); close(ack_fd);
      confirmed = 1;
    }
  }
}

static int launch(int argc, char **argv) {
  if (argc < 4) return 125;
  // Preserve the legacy launcher argument; it is no longer an execution limit.
  int seconds = atoi(argv[3]);
  if (seconds < 1) return 125;
  if (!strcmp(argv[1], "--watch")) {
    if (argc < 5) return 125;
    char *end;
    long pid = strtol(argv[4], &end, 10);
    if (end == argv[4] || *end || pid <= 1 || (long)(pid_t)pid != pid) return 125;
    pid_t owner = (pid_t)pid;
    if (getppid() != owner) return 0;
    guard(argv[2], owner, -1, -1);
  }
  if (strcmp(argv[1], "--exec") || argc < 5) return 125;
  pid_t owner = getpid(), child = fork();
  if (child < 0) return 125;
  guard_created = 1;
  if (!child) {
    if (completion >= 0) signal(SIGPIPE, SIG_IGN);
    // A guard must never retain the target's IPC or output pipes.
    long maximum = sysconf(_SC_OPEN_MAX);
    for (int fd = 0; fd < maximum; fd++)
      if (completion < 0 || (fd != completion && fd != completion + 1)) close(fd);
    guard(argv[2], owner, completion, completion < 0 ? -1 : completion + 1);
  }
  if (completion >= 0) { close(completion); close(completion + 1); }
  execvp(argv[4], &argv[4]);
  return 125;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--join")) return join_guard();
  const char *value = getenv("HERDR_FIXTURE_COMPLETION_FD");
  if (value) {
    char *end;
    long number = strtol(value, &end, 10);
    if (end == value || *end || number < 3 || number >= INT_MAX) return 125;
    completion = (int)number;
    unsetenv("HERDR_FIXTURE_COMPLETION_FD");
  }
  int status = launch(argc, argv);
  if (completion >= 0 && !guard_created) {
    pid_t none = 0;
    void (*previous)(int) = signal(SIGPIPE, SIG_IGN);
    transfer(completion, &none, sizeof(none), 1);
    signal(SIGPIPE, previous);
    close(completion); close(completion + 1);
  }
  return status;
}
