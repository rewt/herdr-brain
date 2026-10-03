---
run: R-178
outcome: done
summary: |
  Fixed the copied discovery probe in commit 05d49e6. Its snapshot omitted herdr/entry-lock.mjs, which lib/fleet.mjs now imports, so both harnesses failed before setup completed. The snapshot now includes herdr/. The probe and its scripted workers use isolated scratch fleet and console paths. Both requested copied-product acceptance tests pass, with their original expectations retained and new dependency and fleet-isolation assertions.
headline: Copied Codex and Claude products can load the fleet and finish offline acceptance.
blockers: []
proposals: []
learnings:
  - The missing dependency was herdr/entry-lock.mjs, not lib/fleet.mjs. The probe already copied lib/, while the installed plugin runtime already includes both lib/ and herdr/.
  - Clearing inherited HERDR_ variables must be followed by an explicit scratch HERDR_MONITOR_FLEET; otherwise automatic entry falls back to the user's machine fleet.
artifacts:
  - "commit 05d49e6: Fix fleet dependencies and isolation in copied discovery probe"
  - "discovery/acceptance.mjs"
  - "discovery/test/acceptance.test.mjs"
  - "docs/reports/evidence/ARCH-17-fleet-ci-20261003/acceptance-red.tap"
  - "docs/reports/evidence/ARCH-17-fleet-ci-20261003/acceptance-sandbox-denied.tap"
  - "docs/reports/evidence/ARCH-17-fleet-ci-20261003/acceptance-green.tap"
  - "docs/reports/ARCH-17-fleet-ci-20261003.md"
---

`git rebase main` completed first: the lane already contained main at `adf6f5b`,
so no commits needed replaying. The supplied promotion failure was reproduced
with `node --test discovery/test/acceptance.test.mjs`. Adding probe stdout and
stderr to the existing setup assertion exposed `ERR_MODULE_NOT_FOUND` for
`product/herdr/entry-lock.mjs` in both harnesses. The committed red evidence
records those errors before the implementation fix.

The probe snapshot now copies `herdr/`, preserving the fleet lock dependency.
No plugin manifest correction was needed: the plugin's runtime snapshot already
includes that directory. Both the probe and the acceptance test scrub inherited
machine settings, then explicitly select their own scratch fleet and console
configuration paths. This prevents automatic entry from writing the real user's
fleet or adopting a real console mapping.

The new assertions check that the copied lock module exists, that the probe
joins only its scratch entry project, that it does not write the caller's fleet,
and that scripted worker entry maps only the unrelated scratch project's own
checkout and record. The original setup, pending-live, usage, validation,
promotion, record, routing, and clean fast-forward expectations remain intact.
There is no intentional contract change.

Verification ran only the requested test file:

```sh
node --test discovery/test/acceptance.test.mjs
```

The first post-fix run reached worker launch but the shell sandbox denied `ps`,
which the fixture uses to establish ownership before managing child processes.
An authorized run outside that shell sandbox passed both tests: 2 passed,
0 failed, 0 skipped, in 15.16 seconds. All transport executables were scripted;
the probe used `--skip-live`, recorded no usage, and made no model calls. TAP
evidence is committed with trailing whitespace normalized. No hooks were trusted
or changed, and no live harness, full suite, promotion, push, pane mutation, or
housekeeping loop was run.

I reviewed the diff against the requested scope and `git diff --cached --check`
passed before committing the implementation and evidence. This report is checked
with `node bin/org.mjs check` before its separate commit. The final work step is:

```sh
node lanes/lane.mjs check --cmd 'node --test discovery/test/acceptance.test.mjs'
```

The explicit command keeps lane validation within the requested test file.
The final commit's gate result and validation log are retained by lane check in
`.lane/gate.json` and the shared Git validation cache. Promotion CI remains the
supervisor's next integration step.
