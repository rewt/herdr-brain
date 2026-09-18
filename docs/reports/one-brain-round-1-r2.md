---
run: R-9
outcome: blocked
summary: |
  All five independent-review findings are corrected and tested. The lane remains rebased onto main 033cc09 with no merge commits; npm test passes 138/138, the console suite passes 91/91, and the herdr-org 140x45 frame renders. ENG-3 still requires the operator's permission to read one real Claude transcript, and the bch-cloak frame remains unrun because its live configuration points into the tree this brief forbids reading.
headline: The review findings are fixed; two operator-controlled checks remain
blockers:
  - ENG-3 still requires operator permission for a read-only, first-lines-only check of one real Claude transcript.
  - The bch-cloak live frame would read /Users/rewt/development/bastian, which the governing brief explicitly forbids.
proposals: []
learnings:
  - Herdr-lanes shortens long lane topics before adding two six-hex suffixes to generated agent names.
  - Terminal string controls must be sanitized before truncation, and an unterminated control must not consume later lines.
  - Answered questions and brain result rows are separate question-title display sites from the Waiting list.
artifacts:
  - "branch lane/brain-console-v1: 6e2f269, 25d7c5e, 11ccf18, 015b09a, e662b8e, and this report commit"
  - "npm test: 138 pass; npm --prefix console test: 91 pass"
  - "node console/app.mjs --print 140x45 --project herdr-org: exit 0"
---

The lane is based on current local `main` at `033cc098856461c68ae2b050046643aadb596729`.
`main` is an ancestor of the lane and `main..HEAD` contains no merge commit. Promotion was not
attempted; the amended acceptance leaves that to the operator after independent review.

## Defects

ENG-2 — no longer applies: `98fd0c2` moved decisions into the separate History view, so they
cannot bury session rows on the repository board.

ENG-3 — needs the operator: the standing decision still withholds permission for the requested
read-only, first-lines-only check of one real Claude transcript.

ENG-4 — still real, fixed in `0ba82a9` and completed in `25d7c5e`: core views now strip terminal
controls, sanitize before truncation, preserve later lines after an unterminated OSC/DCS-family
introducer, and sanitize `org start`, `org ingest`, and `org sync` confirmations. Regression tests
cover an unterminated OSC, a long OSC 8 sequence crossing a truncation boundary, survival of the
brief report section, and escape-bearing sync output.

ENG-5 — no longer applies: `98fd0c2` replaced the old Running and Session-notes sections with a
repository-grouped board whose rows explicitly report `working`, `idle`, `done`, `gone`, or
`unknown`.

ENG-8 — still real, fixed in `523804c` and completed in `015b09a`: worktree naming now recognizes
the shortened-topic, two-hex-suffix agent names Herdr-lanes actually generates, with a regression
case matching this lane's real naming shape.

ENG-9 — still real, fixed in `e4aa7eb`: the console reads the optional lane session registry
read-only and names matching review agents `review <topic>` by Herdr name or transcript session id.

ENG-12 — still real, fixed in `92613f4` and completed in `11ccf18`: the marked fallback now covers
Waiting rows, answered-question History rows, and brain result rows; the raw title remains in
Context. The regression test covers both Waiting and History.

## Independent-review findings

- The Moderate sanitizer finding is fixed in `25d7c5e`.
- The answered-question headline finding is fixed in `11ccf18`.
- The shortened generated lane-name finding is fixed in `015b09a`.
- The unsanitized start/ingest/sync confirmation finding is fixed in `25d7c5e`.
- The missing naming-precedence and fallback documentation is fixed in `e662b8e`.

## Commits

1. `6e2f269` — Add One brain review round 1 record.
2. `25d7c5e` — ENG-4 harden terminal sanitization boundaries.
3. `11ccf18` — ENG-12 protect every question headline.
4. `015b09a` — ENG-8 recognize shortened lane agent names.
5. `e662b8e` — Document console session naming precedence.
6. This commit — add the R-9 correction-round report.

## Verification

- Pre-change `npm test`: 138/138 passed.
- Targeted sanitizer test: 1/1 passed.
- Targeted console model tests: 17/17 passed.
- Targeted console board tests: 9/9 passed.
- `npm --prefix console ci`: installed 40 packages from the lockfile.
- Final `npm test`: 138/138 passed.
- Final `npm --prefix console test`: 91/91 passed.
- `node console/app.mjs --print 140x45 --project herdr-org`: exited 0 and drew a complete frame.
- `node console/app.mjs --print 140x45 --project bch-cloak`: deliberately not run; its live
  project points under `/Users/rewt/development/bastian`, which the governing brief forbids reading.
- `bin/` and `lib/` still have only `node:` and relative imports. The correction adds no dependency.
- Production search still finds `events.jsonl` creation and mutation only in `lib/store.mjs`; the
  console watches that file and writes organization state only through the org CLI.
- No push, main update, live organization write, real-transcript read, or forbidden-tree access was
  performed.
