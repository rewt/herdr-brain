#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>

// Hold the actual final-source G, after its handshake, immediately before exit.
static void held_exit(int code) {
  const char *name = getenv("FIXTURE_COMPLETION_BARRIER");
  if (name) {
    struct sockaddr_un address = { .sun_family = AF_UNIX };
#ifdef __APPLE__
    address.sun_len = sizeof(address);
#endif
    if (strlen(name) >= sizeof(address.sun_path)) _exit(126);
    strcpy(address.sun_path, name);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    char release;
    if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address)) ||
        dprintf(fd, "%ld %d\n", (long)getpid(), code) < 0 || read(fd, &release, 1) != 1 || release != 'R') _exit(126);
    close(fd);
  }
  _exit(code);
}
#define _exit held_exit
#define main fixture_main
#include "fixture-lifetime.c"
#undef main
int main(int argc, char **argv) {
  int status = fixture_main(argc, argv);
  if (!status && getenv("FIXTURE_COMPLETION_JOIN_ERROR") && argc == 2 && !strcmp(argv[1], "--join")) return 125;
  return status;
}
