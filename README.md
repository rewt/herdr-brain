# Herdr Monitor

Herdr Monitor gives coding agents a durable record and isolated Git lanes. A fresh
session recovers tasks, reports and decisions from the record instead of a long
chat history.

Use [`record lookup`](docs/LOOKUP.md) to retrieve decisions, confirmed mistakes
and their original evidence from the owning record, including supersession.

Install a release once and dispatch work into explicit Git lanes.

**Start with [the adoption guide](docs/ADOPTING.md).** It covers installation,
uninstall, project overrides, the agent cycle and release rollback.
This repository is still a local development candidate; no public repository or
marketplace installation is promised. The [publication audit](docs/PUBLISHING-AUDIT.md)
lists the work required before any publication.

## What happens

- A worker gets its own checkout, the project's instructions, record context and
  the lane and record commands to commit, validate, integrate and report its work.
- A supervisor dispatches recorded work, receives a final watch notice, settles
  reports through independent review, and authorizes queued local promotion.
- Housekeeping handles finished worker tabs and interrupted sessions. Only the
  canonical project supervisor starts its schedule.

Coordination is deterministic. The dependency-free record core runs in the
foreground and never calls a model. Workers and reviews use your native harnesses;
routes and budgets remain visible, and exceeding an advisory budget does not
refuse work. Promotion requires clean trees, a clean rebase, green validation and
a local fast-forward. Background pane creation preserves Herdr focus.

A reviewer-role child holds its parent work item and its dependents while
unresolved or done with a non-PASS verdict, just like a linked review blocker.
Done reviews with PASS or no verdict, and dropped reviews, release derived status;
promotion still requires explicit PASS from every done review. Reopening a review
holds the work again. Reviewer proposals hold their parent regardless of `blocking`;
that flag controls the recorded link, which is optional and counts the review once.
A review linked to wait for its parent, directly or through other work, can proceed
after its prerequisites' work reports while other dependents wait for the review.
Explicit work closure and active runs keep their existing status precedence.
Unlinking a NEEDS-WORK child review does not release its parent. For an explicit
exception, close the child review as dropped with the reason in its note:
`record close REV-n --dropped --note "Reason for the exception"`.
A dropped review releases its parent.

`record today` ranks open operator questions by the work they block, then by
age, oldest first. The count includes unique unresolved dependents (including
transitive links), their open runs or current waiting reports, and recorded plan
steps that name the question. A current blocked or needs-human report can also
name a question in its blockers without a dependency link. Plans are the latest
note per unresolved item or current run marked `Plan:` or `## Plan`, with numbered
or bulleted steps; completed `[x]` steps do not count. Older plan notes and ordinary
prose mentions do not count.

Questions older than seven elapsed days collapse into one count in the text view.
`record today --parked` lists them; add `--json` for structured output.
The default `record today --json` keeps every open question in impact order and
adds `blocked_count`, `blocked_work` (`items`, `runs`, `plan_steps`), and `parked`
for consumers. Parking is a read-time presentation choice and changes no events
or item status.

## Requirements and limits

Node.js 20+, Git 2.38+ and native Codex or Claude are needed for agent work.
Herdr supplies panes and agent launches. Bash manages local releases; the
promotion kernel-lock bridge uses zsh, and the release gate uses npm (bundled with Node.js).
The product has no npm dependencies. Native harness configurations own permissions
and sandboxing. The bundled non-setuid process reader supports process identity
checks inside harness sandboxes.

## References

| Module | Reference |
| --- | --- |
| Record | `node bin/org.mjs help` (`org` is the permanent `record` alias); [Lessons](docs/reference/lessons.md), [Acceptance amendments](docs/reference/acceptance-amendments.md) |
| Fleet and project chats | [Discovery](discovery/README.md) |
| Machine installation | [Herdr](herdr/README.md) |
| Lanes and routes | [Lanes](lanes/README.md) |
| Dispatch / watch | [Dispatch](dispatch/README.md), [Watch](watch/README.md) |
| Review and integration | [Settle](settle/README.md), [Promote](promote/README.md) |
| Supervisor / housekeeping | [Supervisor](supervisor/README.md), [Housekeeping](housekeeping/README.md) |
| Host test slot | [Test slot](test-slot/README.md) |
| Live promotion view | [Promotion board](board/README.md) |
| Release batching and validation | [Machine releases](herdr/README.md), [Acceptance](acceptance/README.md) |
| Intent | [North star](docs/north-star.md), [Roadmap](docs/roadmap.md) |

## Development

Ship the tests for a lane change and run its relevant files as needed. The
promotion batch runs `npm run test:promotion` once before merging; settle reviews
run no suite. `npm run test:fast` gives checks that finish in seconds.
A tagged release build runs the complete offline `npm run test:release` once
per candidate; `build TAG --live` adds optional live acceptance. See [test tiers](docs/reference/test-tiers.md)
for file selection, fixture ownership and prerequisite skips.
The product has no npm dependencies. The console was removed on 2026-10-12 and is archived at tag
`archive/console-20261012`; restore it with `git checkout archive/console-20261012 -- console`.

Tests stay offline and call no model. The dependency-free runner bounds tests,
files and suites; each fixture has owned cleanup. Standalone hang regressions use
`ORG_ACTOR=developer node test/helpers/run.mjs test/test-hangs.test.mjs` and retain
real cancellation boundaries, finite native descendant deadlines and load-aware
startup allowances.

Develop in an isolated lane. Projects use immutable releases: merging development
code does not activate it. See [AGENTS.md](AGENTS.md) for repository boundaries,
including the legacy watcher that an existing pilot still calls.
