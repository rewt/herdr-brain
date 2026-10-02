# Validation owner binaries

These four small executables are built from the unchanged
[`../process-supervisor.c`](../process-supervisor.c): macOS arm64/x64 and Linux
arm64/x64. The macOS builds target macOS 11.0 and link the system libSystem;
the Linux builds statically link musl and need no host libc or dynamic loader.
They retain the same kernel lifetime identity, trusted bootstrap, subreaper,
signal handling, deadline and descendant cleanup as a local source build.

`manifest.json` records each executable's SHA-256, its source SHA-256, compiler
version and build flags. The installed manifest and source belong to the same
trusted product distribution; checksums detect damaged or stale bundles, not
an attacker replacing the whole distribution. Runtime reads refuse symlinks,
check both hashes and the native architecture, and copy the verified bytes to
a private system scratch directory before execution. No runtime download or
compiler environment override is used.

Verify all bundled targets without a compiler:

```sh
node discovery/native/build.mjs --check
```

Maintainers rebuild and commit the executables together with the manifest.
macOS rebuilds require the macOS SDK and `/usr/bin/cc`:

```sh
node discovery/native/build.mjs --target darwin-arm64
node discovery/native/build.mjs --target darwin-x64
```

Portable Linux rebuilds use an explicitly selected Zig compiler, on either host
platform. The checked-in Linux binaries use Zig 0.15.2. Obtain the compiler from
the [official downloads](https://ziglang.org/download/) and verify its archive
against the [official checksum index](https://ziglang.org/download/index.json).
The build itself is offline, uses private temporary caches, and is bounded to
180 seconds per compiler invocation:

```sh
node discovery/native/build.mjs --target linux-arm64 --zig /absolute/path/to/zig
node discovery/native/build.mjs --target linux-x64 --zig /absolute/path/to/zig
node discovery/native/build.mjs --check
```

Keep the bundled musl and Zig license notices with the Linux executables.
`MUSL-COPYRIGHT` and `ZIG-LICENSE` are copied from that compiler distribution;
the Arm attribution below covers its AArch64 string routines:

```text
Copyright (c) 2012-2020, Arm Limited.
SPDX-License-Identifier: MIT
```

Rebuilding need not produce identical executable bytes across compiler/SDK
versions; review the manifest changes and run the lifetime tests and release
gate against the rebuilt candidate. A source edit invalidates old entries until
every affected target is rebuilt. Installation snapshots and Git archives carry
these files without an additional build/install step.

If a bundle is missing, redirected, damaged, stale or has the wrong architecture,
runtime explains the rejection and tries the existing `/usr/bin/cc` source build
in private scratch, with its 15-second deadline. If that also fails, validation
returns 125 before executing the project command. Other operating systems still
refuse descendant containment; unbundled Darwin/Linux architectures require a
working local compiler. No permissive cleanup fallback is available.
