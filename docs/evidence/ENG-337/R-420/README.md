# Watcher hold lookup evidence

Run R-420, lane `watch-non-git-hold`, starting commit `bf2d4b2d`.
All commands use offline fixture Herdr adapters; no live cleanup was performed.

The change recognizes Git's explicit non-repository diagnostic only on an initial
checkout probe, in the C locale. Once that probe finds a checkout, canonical Git
discovery and hold checks retain their fail-closed behavior. A broken Git pointer
is an error, even though its diagnostic also contains "not a git repository".

`non-git-before.tap` records the new positive control against the original
production code: exit 1, because the non-Git watcher logged `held`. The closing
assertion is unchanged in the final test; its file wait now uses the existing
bounded polling approach so this control does not require filesystem notifications.

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 \
  '--test-name-pattern=^retirement hold: native watcher closes its tab from a non-Git cwd$' \
  watch/test/watch.test.mjs
```

`hold-after.tap` records the first four completed hold controls after the fix:
non-Git close, linked canonical hold/release, canonical lookup failure, and
indeterminate hold lookup. All four passed. A fifth control for a broken Git
pointer was then added and passed in both full-file runs below. The canonical
failure deliberately reports the same non-repository diagnostic after successful
checkout discovery; each injected failure has a reachability marker.

`required-tests.tap` records the required six-file run in the native sandbox:
93 passed, seven failed with `EMFILE`, one notification test skipped, exit 1.
All failures and the skip were in existing notification-dependent watcher tests;
the changed retirement controls passed, as did all 76 tests in the other five
files. The affected file was rerun with native execution through the harness
approval mechanism, without changing any permission settings.

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 \
  watch/test/args.test.mjs watch/test/existing-project.test.mjs \
  watch/test/lock.test.mjs watch/test/watch.test.mjs \
  test/one-watcher.test.mjs test/retire-paths.test.mjs
```

`watch-native.tap` records that affected-file rerun: exit 0, **25 passed, no
failures or skips**, including the filesystem notification test.
Together the two runs provide passing evidence for all **101 tests** in the six
required files, without replaying the five files that already passed.

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 \
  watch/test/watch.test.mjs
```
