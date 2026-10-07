---
run: R-273
outcome: done
summary: |
  Updated the promotion gate profile example to install dependencies unconditionally with --prefer-offline, retaining generic unless support and explaining why it must not guard dependency installs. General gate-profile fixtures no longer require zsh; only the two real kernel-lock cases skip when /bin/zsh is absent. Interrupted batch results and notices now preserve their host receipt link. Implementation is committed in ce4f7fe. All 11 profile cases pass, the simulated no-zsh run passes all nine general cases with two explicit skips, and three existing train recovery cases pass. This report precedes its record check, report commit, and required final lane check.
headline: Gate profiles refresh dependencies and retain guard refusal evidence on resume.
blockers: []
proposals: []
learnings:
  - An existing node_modules directory does not prove dependency preparation remains valid after a rebase; install unconditionally, using --prefer-offline to allow missing cache entries to be fetched.
artifacts:
  - "Implementation commit ce4f7fe"
  - "Branch lane/gate-profile"
  - "promote/README.md"
  - "promote/promote.mjs"
  - "test-slot/test/gate-profile.test.mjs"
  - "docs/reports/ENG-220-gate-profile-20261006.md"
  - "/Users/rewt/development/rewt/.org/runs/R-273/report.md"
decisions: []
questions: []
challenges: []
---

The only old install pattern under promote/ was the README example. There is
no built-in dependency-install default or node_modules shortcut to remove.
The README now uses `pnpm install --prefer-offline --ignore-scripts --frozen-lockfile`
without an `unless` guard. Generic relative `unless` remains supported; the
host profile integration test proves an existing valid path still skips its
associated preparation step.

The external kernel lock is opt-in in the test fixture. Both real fcntl lock
tests retain their lock contention, bounded wait, integration, and held-lock
preparation checks. Other profile tests run without invoking zsh.

The batch exception handler attaches an existing host-gate.json path to each
interrupted result. The resumed-cap regression checks the queued history,
saved interrupted batch, and actual notice journal for this path. It also
proves the validated fast-forward checkpoint survives and resumes without
another gate execution.

Validation was offline and used disposable Git projects, isolated fleet state,
and a refusing Herdr adapter. Host-capable execution was needed for the socket
and PTY fixtures.

- Before editing, the unchanged profile test on canonical main at 1032c6a
  passed all 11 cases, as required by the run's test-change lesson.
- `node --test test-slot/test/gate-profile.test.mjs`: 11 passed.
- `NODE_OPTIONS=--require=/private/tmp/R-273-no-zsh.cjs node --test test-slot/test/gate-profile.test.mjs`:
  nine passed, two explicitly skipped. The temporary preload makes /bin/zsh
  appear absent and rejects every attempt to invoke it. This simulates the
  missing dependency on the macOS host; no Linux host was used.
- `node --test --test-name-pattern='^(interrupted validation preserves|promotion lock contention delivers|a crash after the fast-forward resumes)' promote/test/train.test.mjs`:
  all three selected recovery cases passed, with 26 unselected cases skipped.
- `git diff --check`: passed before the implementation commit.

No promotion, release, or full lane suite was run. The final command after
report validation and its commit is `node lanes/lane.mjs check`, using the
configured fast tier.
