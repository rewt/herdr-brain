# Test process identities

`../processes.mjs` uses `/proc/<pid>/stat` (kernel start ticks) and `cmdline` on
Linux. On macOS these two bundled non-setuid executables read `proc_pidinfo`
and `KERN_PROCARGS2`, preserving start seconds **and microseconds**. Both sources
confirm the start identity again after reading argv. The macOS snapshot covers
the current uid, which owns every fixture and suite group. A disappeared process
is omitted; a refused, malformed, changed or truncated read fails the lookup.
When a live macOS process has no readable argv during exec/exit (`EINVAL`/`EIO`),
its kernel command name supplies a bracketed command, as with Linux kernel
threads; permission errors still refuse. Zombies are explicitly marked. A change
between the full argv and the bracketed name prevents a command match.
Snapshots must include their live caller. Cleanup still confirms the exact birth
and command immediately before signalling, and verifies group leadership.

The runner requires neither `ps` nor a C compiler. Unsupported platforms, missing
or damaged bundles and denied kernel reads refuse with a process-source error;
there is no permissive cleanup fallback. `manifest.json` records the source and
binary SHA-256 values; runtime verifies both, Mach-O architecture and executable
type, and refuses setuid/setgid files. These checks detect a stale or damaged
checkout; the checkout has the same trust boundary as the JavaScript callers.

Maintainers rebuild both Darwin architectures with the macOS SDK:

```sh
node lib/native/build.mjs
```

Commit the source, executables and manifest together. Runtime never compiles or
downloads anything. Focused acceptance tests live in
`test/no-setuid-processes.test.mjs`; the seatbelt test explicitly skips if it is
already inside a nontrivial macOS sandbox, where seatbelt cannot nest. Run that
test on the promotion host to prove kernel refusal of setuid `ps` alongside
successful bounded runner execution and group cleanup.
