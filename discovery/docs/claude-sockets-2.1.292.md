# Claude Code 2.1.292 socket evidence

Measured on macOS arm64 on 2026-10-06 with the native binary at
`/Users/rewt/.nvm/versions/node/v20.19.4/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
No authentication, session, model, Herdr request, or live acceptance harness was
used. `discovery/claude-socket-probe.mjs` exits from a Bun preload before the
CLI's entry point and calls the binary's own exported `rTe` temp selector and
`Nir` macOS sandbox wrapper. It discovers their private module paths from the
binary's import statements. This is deliberately a version-specific manual
probe, separate from the default offline suite.

```sh
node discovery/claude-socket-probe.mjs \
  /Users/rewt/.nvm/versions/node/v20.19.4/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
```

The wrapper receives the generated socket network settings and filesystem
write grants/denies, plus Claude's default working-directory and shell-temp
write grants. It denies direct network access without starting the model's
network proxy. The command exports the value returned by `rTe`, matching the
export in Claude's sandboxed Bash command builder. Scratch sockets, directories,
settings and the Herdr symlink are removed afterwards. Socket connect attempts
send no application data.

The successful probe returned:

```json
{"version":"2.1.292 (Claude Code)","limit":44,"runTemp":"/private/tmp/c228-5oYQng/run-temp/r-YGrobf","socketGrants":["/private/tmp/c228-5oYQng/run-temp/r-YGrobf","/private/tmp/claude-501"]}
{"tmpdir":"/tmp/claude-501","checks":["shell TMPDIR: bind/connect OK","run temp: bind/connect OK","sibling run bind: EPERM","sibling prefix bind: EPERM","peer checkout bind: EPERM","peer record bind: EPERM","peer temp bind: EPERM","peer worktrees bind: EPERM","sibling run connect: EPERM","peer temp connect: EPERM","Herdr control connect: EPERM","Herdr symlink connect: EPERM","localhost TCP bind: EPERM","PTY with default settings: EPERM"]}
```

An initial attempt inside the worker's outer sandbox failed before the command
ran (`sandbox-exec: sandbox_apply: Operation not permitted`). The successful
probe ran outside that nested boundary. No policy was disabled in the generated
Claude sandbox.

## Temp selection

The 2.1.292 binary's `cg()` uses `CLAUDE_CODE_TMPDIR`, and its internal temp
selector appends `claude-${process.getuid()}`. `kSr` is **44**. `rTe()` returns
that internal temp when its UTF-8 byte length is at most 44; otherwise it tries
`/tmp/claude-<uid>`. The Bash command builder exports this selected temp whenever
the sandbox's filesystem isolation is enabled. The observed fallback is thus
caused by the length cap, not a missing launcher environment variable.
Internal files still use the configured run temp.

Monitor grants the canonical fallback only for run paths exceeding this cap;
short run paths need only their own directory. The fallback is per-user, shared
across sessions. Its socket isolation cannot distinguish runs or projects that
also choose to put sockets there. Other project roots and sibling fleet run
directories remain denied. This uses the fallback exception in the item ask;
no all-user/system-temp or all-socket allowance is added.

The native documentation also describes the appended UID directory and long
path fallback: [Claude temp environment](https://code.claude.com/docs/en/env-vars#claude-code-tmpdir)
and [sandbox temporary directories](https://code.claude.com/docs/en/sandboxing#temporary-directories).
The exact 44-byte threshold above comes from the inspected binary and the
model-free native selector, rather than an approximation in the documentation.

## Socket and PTY policy

The bundled macOS profile generator adds `system-socket` for AF_UNIX creation,
then `network-bind` and `network-outbound` with `unix-socket (subpath ...)` for
each `allowUnixSockets` path. The probe verifies both operations for unknown
socket filenames under the allowed directories and rejects a sibling prefix.
`allowLocalBinding` and `allowAllUnixSockets` remain unset, with native false
defaults. Inherited settings retain native merge/lock behavior; supplied CLI
arrays are merged in the generated file. Broad operator overrides remain
explicit and produce source-naming warnings.

The bundled runtime's `allowPty` is a boolean. Its profile grants `pseudo-tty`,
ioctl/read/write access to `/dev/ptmx`, and every `/dev/ttys*`, with no path or
per-session selector. No scoped PTY option appears in the inspected Claude
settings schema. The probe's `os.openpty()` fails with EPERM under the default
policy. PTY-dependent tests still need a separate product decision; Monitor
does not enable an unscoped allowance.

The upstream [runtime source](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts)
describes the corresponding socket subpath rules and global PTY switch. On
Linux, [the runtime schema](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/sandbox-config.ts)
states that scoped Unix socket paths are ignored: seccomp cannot inspect paths.
This change makes no Linux all-sockets exception and changes no Codex launch
settings.
