# Technical reference

## Configuration

Every key is optional. A repository can inherit reusable settings from one parent
`.lane.json` and override them in its own canonical-checkout `.lane.json`:

```json
{
  "main": "main",
  "worktree_root": "../.worktrees",
  "validate": "npm test",
  "registry": ".lane/sessions.json",
  "prepare": [
    { "unless": "node_modules", "run": "npm ci" }
  ],
  "dispatch": {
    "kind": "codex",
    "model": "model-name",
    "effort": "high",
    "env": ["KEY=value"],
    "args": ["--agent-flag"]
  },
  "routes": {
    "engineer": {
      "kind": "codex",
      "model": "engineering-model",
      "effort": "xhigh",
      "env": ["ROLE=engineer"],
      "args": ["--agent-flag"],
      "use": "Implementation work that needs full repository context"
    }
  },
  "always_args": {
    "codex": ["-p", "shared-profile"]
  },
  "selection_policy": {
    "primary_implementation_pool": "codex",
    "by_task_class": {
      "implementation": { "codex": "engineer" }
    }
  },
  "seams_doc": "docs/tasks.md"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `main` | `main` | Local integration branch |
| `worktree_root` | see below | Shared base directory for repository worktree containers |
| `validate` | `npm test` | Shell command required for promotion |
| `registry` | `.lane/sessions.json` | Gitignored legacy session array and base path for per-session display records |
| `prepare` | none | `{unless, run}` steps for fresh worktrees |
| `dispatch.kind` | `claude` | Herdr agent kind |
| `dispatch.model` | none | Model passed to the agent |
| `dispatch.effort` | none | Reasoning effort passed to the agent and recorded for routed runs |
| `dispatch.env` | none | Environment added to the Herdr tab |
| `dispatch.args` | none | Raw agent arguments |
| `routes` | none | Named dispatch configurations selected with `--route` |
| `routes.<name>.kind` | `dispatch.kind` | Herdr agent kind for this route |
| `routes.<name>.model` | `dispatch.model` | Model for this route |
| `routes.<name>.effort` | `dispatch.effort` | Reasoning effort for this route |
| `routes.<name>.env` | none | Environment appended after `dispatch.env` |
| `routes.<name>.args` | `dispatch.args` | Raw agent arguments replacing `dispatch.args` when present |
| `routes.<name>.use` | none | Operator note describing when to select the route; dispatch ignores it |
| `always_args.<kind>` | none | Agent options appended to every dispatch of that kind unless already present |
| `selection_policy.primary_implementation_pool` | none | Default opaque pool name used by route selection |
| `selection_policy.by_task_class` | none | Task class to route, directly or through an opaque pool-to-route map |
| `seams_doc` | none | Optional task-map path printed by `seams` |

The same project file may contain `entry.enabled`, `entry.mode` and `entry.policy`
for installed Codex/Claude entry adapters; see [project entry settings](../../discovery/README.md#project-settings).
Lane lifecycle commands preserve those fields without interpreting them. The
entry adapters read only the canonical project's entry preferences.

### File discovery and merging

Without `LANE_CONFIG`, `lane` identifies the canonical checkout through git's common
directory. It searches upward from the canonical checkout's parent and loads only the
nearest `.lane.json` it finds, then loads the canonical checkout's `.lane.json` if
present. Invoking the command in a linked worktree therefore uses the same operational
files as invoking it in main; a linked worktree's copy is not another layer.

For a repository below the current user's home directory, the search excludes home
and every ancestor above it. If the canonical checkout is home, no parent is searched.
Outside home, the search stops before the filesystem root. A missing optional parent
or repository file contributes nothing.

Top-level keys merge shallowly, with the repository value replacing the parent value.
Arrays such as `prepare`, `dispatch.env`, `dispatch.args`, and `always_args.<kind>` never concatenate across
files, and a repository `dispatch` object replaces the parent object as a whole. The
only special case is `routes`: route names merge, while a repository route replaces
the complete same-named parent route. Dispatch's documented global-to-route-to-CLI
resolution occurs after this file merge, so its existing environment append behavior
is unchanged.

The dependency-free resolver is `lanes/routes.mjs`. `lane dispatch` and routed
`record start` consume it. The record copies only declared `effort` metadata;
`resolveLaunchRoute` alone interprets legacy argument-encoded effort for lane
launches. Add explicit effort fields to legacy config so both records agree.
`contrib/settle-watch.mjs` keeps its own reading until
bch-cloak's release-gated switch (ENG-64), because bch-cloak calls it by path with
`--model` and `--effort`. `schema`, `authority`,
`dispatch`, `always_args`, `routes`, and `selection_policy` from bch-cloak's
`routing.json` all load without projection. Pool and task-class names are opaque;
the resolver checks only that every policy choice names a real route.

The mechanism is generic; the values remain project configuration. In bch-cloak,
route names, models, efforts, `use` text, provider-named pools, and the `adopted` and
`rules` policy notes are its choices. Persona/account environment, memory adapter
paths, and other `env`/`args` are also bch-cloak launch plumbing, not Herdr policy.
Herdr only validates and resolves them.

`LANE_CONFIG` selects exactly one file and bypasses both discovered layers. A relative
`LANE_CONFIG` is resolved from the command's invoking directory. The selected file
must exist. Selected files that cannot be read, contain malformed JSON, or give a
known key the wrong type stop the command before git, validation, setup, or Herdr
actions. Optional absent discovered files are allowed. Configuration is parsed as JSON
only; values are not interpolated or executed during loading or `lane config`.

Because `validate` and `prepare[].run` are trusted shell commands, place shared parent
configuration only in directories controlled by the operator.

Repository identity is the real absolute path returned by Git for its common
directory. The canonical checkout is the non-linked checkout whose own Git directory
is that common directory; when invoked in the primary checkout, this also supports a
Git directory stored separately from the working tree. A bare repository or a linked
invocation for which Git cannot identify that primary checkout can still run read-only
`config` and `status` inspection from the linked checkout, but fails clearly before a
lane mutation. Repository basenames, remotes, workspace labels, and author settings
are never treated as ownership.

### Worktree-root precedence

`worktree_root` is a shared base. A relative value is resolved from the directory of
the parent or repository file that defines it, then the canonical repository basename
is appended. New lane paths use this order:

| Winning setting | Repository worktree directory |
| --- | --- |
| `LANE_WORKTREE_ROOT` | `<env-directory>` |
| Repository `worktree_root` | `<resolved-base>/<repo-name>` |
| Parent `worktree_root` | `<resolved-base>/<repo-name>` |
| Parent file present without the key | `<parent-directory>/.worktrees/<repo-name>` |
| No parent and no key | `<home>/.herdr/worktrees/<repo-name>` |

`LANE_WORKTREE_ROOT` intentionally keeps its earlier meaning: it is the final
per-repository directory, so no repository segment is appended. A relative value is
resolved from the invoking directory. When `LANE_CONFIG` is explicit and its one file
omits `worktree_root`, the legacy home default applies; the selected file's directory
does not count as discovered parent configuration.

The legacy default is refused when home is inside a checkout; set `worktree_root` or
`LANE_WORKTREE_ROOT` to a directory outside any repository.

Only `worktree_root` is relative to its defining configuration file. `registry` and
`seams_doc` remain relative to the canonical repository, and `prepare[].unless`
remains relative to the worktree being prepared. Changing root settings affects only
new lanes. Every existing lane operation locates registered worktrees through git and
never moves or adopts them. Before using one, `lane` verifies that its real Git common
directory is the canonical repository identity and that its checked-out branch is the
expected lane branch.

Before creating a lane, `lane` resolves the selected base, repository worktree
directory, destination, and existing ancestors through real paths. It refuses a
destination outside the selected base; in or equal to the canonical checkout, a
registered checkout, or another repository; or already occupied by a foreign
repository. These refusals happen before branch creation or a Herdr mutation. The
created path and Git identity are checked again after Git or Herdr returns. There is
no automatic temporary-directory fallback. Choose distinct worktree bases when two
repositories would otherwise occupy the same destination.

`LANE_VALIDATE` overrides `validate` at execution time. Do not put secrets in tracked
configuration.

### Explain configuration

`lane config` prints deterministic tab-separated rows:

```text
key<TAB>JSON-value<TAB>source
```

It reports `dispatch`, `main`, `prepare`, `registry`, `seams_doc`, `validate`,
`validation.fast`, `validation.promotion`, `validation.release`, `validation.environment`, the
fully resolved per-repository `worktree_root`, and one `routes.<name>` row per merged
route. Rows are sorted by key; JSON values stay on one line. Each source is `env`,
`default`, or the absolute defining file path. A parent-derived `.worktrees` default
names that parent file as its source. `LANE_VALIDATE` and `LANE_WORKTREE_ROOT` appear
with source `env`; `LANE_CONFIG`-selected values name the selected file. The command
does not run prepare/validate commands or contact Herdr. In route keys, backslashes,
tabs, carriage returns, and newlines are escaped as `\\`, `\t`, `\r`, and `\n` so
each TSV record remains one line with three fields.

## Check

`lane check [--cmd <validate command>] [--tier fast|promotion]` validates the current
clean worktree and records the result against its exact tree and current commit.
The worker default is fast; settle and promote use promotion. The canonical
checkout's tracked `.lane.validation.json` overrides individual commands from
`.lane.json` `validation`. Undeclared tiers use legacy `validate`, otherwise
`npm test` (or `node --test` with `test/` and no declared npm test script).
`LANE_VALIDATE` overrides every tier. `--cmd` overrides the command for that run and
is recorded verbatim. Before validation, `check` runs the configured `prepare`
steps in the current worktree just as `promote` does.

The command refuses with exit 1 before validation when `git status --porcelain`
is non-empty. `lane check` writes `.lane/gate.json`; Git must ignore `.lane/`, either
through the target repository's `.gitignore` or the operator's global excludes file,
or the gate makes the worktree dirty and blocks the next `lane check` and
`lane promote`. After validation, `check` atomically writes the gate file even when
validation fails, provided the worktree and branch remain unchanged:

```json
{
  "head": "0123456789abcdef0123456789abcdef01234567",
  "branch": "lane/example",
  "command": "npm test",
  "exit_code": 0,
  "signal": null,
  "started_at": "2026-09-08T14:00:00.000Z",
  "finished_at": "2026-09-08T14:00:03.250Z",
  "duration_s": 3.25
}
```

`head` is the full SHA captured before validation, `branch` is the current branch,
the timestamps are ISO-8601 UTC, and `duration_s` is numeric. The command prints
`GATE <full-head> exit=<n> (<duration>)` after writing the file and exits with the
validation command's exit code, so scripts see a failed gate directly. `signal` is
the terminating signal name or `null`; when validation dies by signal, `exit_code`
uses the shell convention 128 plus that signal's number.

Run `lane check` again after the last commit. The `GATE` line pasted into a report
must read `exit=0 @<head7>` against the lane's current HEAD before handoff. Because
`.lane/gate.json` is untracked, re-running the check does not dirty the worktree.

The gate also names `tree`, `tier`, `environment_fingerprint`, `key`, `log` and
`reused`. Passing evidence is stored in `GIT_COMMON_DIR/lane-validation/`, keyed by
tree, command and fingerprint, with a content-checked log. Equal commands across
tiers can share evidence. An unchanged-tree rebase refreshes the gate's current
head but preserves `validated_head` and original timing; a changed tree reruns.
Worker gate files are display evidence and never cache authority. Failed/old/
malformed receipts, missing/modified logs and dirty or moving trees do not reuse.
Per-key locks prevent overlapping execution; a busy check refuses and a crash
lock requires inspection. See the [lane guide](../README.md) for environment
inputs, ignored dependency revisions and the repository's declared tiers.

## Workspace setup

The canonical checkout must have a Herdr workspace before dispatch:

```sh
cd /path/to/repository
herdr
```

If already inside Herdr (`HERDR_ENV=1`), do not start a nested client. Check the
parent workspace with:

```sh
herdr status server
herdr workspace list
```

Create it only when the repository is not listed:

```sh
herdr workspace create --cwd /path/to/repository --label repository --focus
```

Without Herdr, `open` falls back to `git worktree`; `dispatch` is unavailable.

New lane workspace labels use `<root-label>/<repo-name>:lane-<topic>`. The root is
the real directory containing the inherited parent configuration, or the canonical
repository's real parent when no parent configuration is inherited. If the readable
label exceeds 64 Unicode code points or matches another identity, `lane` keeps
grapheme-safe root/repository/topic fragments and appends a SHA-256 identity suffix.
Digest collisions lengthen the suffix while fragment budgets shrink to retain the
bound. Existing open workspace labels are not renamed.

Workspace controls use opaque Herdr IDs only after `repo_key`, `repo_root`,
`checkout_path`, and linked-worktree metadata match Git's canonical identity and real
path. A stale or foreign match is not used. When `close` encounters that mismatch, it
reports that Herdr was skipped and removes the worktree through Git only. New
workspaces are created or opened from the canonical non-linked repository workspace
even when `lane open` runs in a linked checkout.

## Dispatch options

```sh
lane dispatch <topic> \
  [--route <name> | --kind <agent> --model <model>] \
  [--env KEY=VALUE ...] [--arg <raw-agent-argument> ...] \
  [--memory-checked] [@brief-file | prompt text]
```

Without `--route`, values come from `dispatch`. With a route, its `kind`, `model`,
`effort`, and `args` replace the corresponding dispatch defaults when present; its
`env` entries append to `dispatch.env`. A named route cannot be combined with
`--kind` or `--model`, so the session cannot drift from route metadata. Supplying
any `--arg` replaces route arguments, or `dispatch.args` when
no route is selected. On a named route, `--arg` cannot override canonical model,
effort, profile, or Claude plugin options (including config expressions and
attached/equal forms). Named Codex routes also reject `profiles` and `profiles.*`
config overrides, since profile settings can change canonical launch values.
Trusted configured arguments retain legacy compatibility.
Command-line `--env` entries append after both configured
environment lists. The route's `use` text is descriptive and never passed to Herdr.
List supported kinds with `herdr agent start --help`.

Dispatch and review validate arguments before waiting for
[host memory pressure](../../docs/reference/memory-gate.md) to clear. They show
the reason on stderr while waiting and proceed automatically when pressure clears.
Both check the canonical `.lane/supervisor/STOP` during the wait and before
launch. STOP emits a JSON receipt with `result: stopped` and `reason`, launches
nothing, and exits 0 for dispatch or 3 for review. Retry after STOP clears.
`--memory-checked` is available on both commands for coordinators that already
performed the visible wait; it skips the redundant wait but still checks STOP.

`lane routes` prints each configured route, sorted by name, with its resolved kind,
model, effort, arguments, and `use` note. It exits 1 when no routes are configured. An
unknown `--route` is rejected before any Herdr call.
`lane routes --for <task-class>` resolves `selection_policy` through its primary
pool; `--pool <pool>` selects another configured pool.

Before sending the brief, `dispatch` waits for the pane shell to reach the lane
worktree, starts the agent with a unique name, and verifies the agent cwd reported by
Herdr by real path. A failed cwd check closes the tab without sending the brief. New
agent names use a readable topic stem plus repository-identity and random hexadecimal
suffixes, while staying within Herdr's 32-character naming grammar. Lane never writes
Git author name, email, signing, or other identity configuration.

Before any Herdr call, dispatch also requires the configured registry and its sidecar
directory to resolve inside the canonical checkout without symlinks, remain untracked,
be covered by Git's repository or global ignore rules, and have a writable sidecar
directory. Existing external registries may still be read during cleanup but cannot
receive automated records. File briefs retain their resolved absolute source path.
File goals use the first ATX
Markdown heading outside fenced code with its heading syntax removed, falling back
to the first nonempty prose line. Inline goals use the first nonempty content line
outside fenced code; ATX syntax is removed only when that line is itself a heading,
so a later heading does not replace earlier prose. An input containing only fenced
content, like an empty dispatch, uses the topic. Goals are limited to 200 Unicode code
points; full prompt text is never copied into metadata.

The record is created only after successful startup, cwd verification, and prompt
delivery (or verified readiness for empty dispatch). Startup, cwd, and prompt failures
create no record. If persistence fails after delivery, dispatch exits nonzero, names
the live agent/workspace/pane, says whether the brief was already sent, and does not
prompt again or close the working agent.

## Foreground review

```sh
lane review <topic> --round N [--change <name>] [--brief <path>] \
  [--route <name>] [--route-config <path>] [--timeout <seconds>]
```

`--round` is required and accepts positive safe integers. Supply `--change` for an
OpenSpec-origin lane even when the change name differs from the topic; it loads that
change's proposal, design, tasks, every delta spec, and any corresponding current
spec. `--brief` names a literal supplemental or standalone source and resolves from
the invoking directory. At least one source is required and both may be used. The
route defaults to `review` and must exist in the selected routing configuration.
`--timeout` is an end-to-end foreground deadline in whole seconds,
defaults to 1800, and accepts 3 through 7200. The three-second minimum leaves one
polling interval beyond the mandatory two-second record-settle window; smaller
values refuse before dispatch. Duplicate, missing, empty, unknown, or invalid
options refuse before dispatch.

`--route-config` supplies a routing snapshot for the selected review route and
resolves from the invoking directory, just as for dispatch. It affects launch
routing only; base branch, worktree paths, registry and validation continue to use
the project's lifecycle configuration and its original source-file provenance.
Settle uses this to share its discovered portable defaults with review when a
project config contains only lifecycle or settle preferences.

Review locates `lane/<topic>` through Git worktree metadata from any checkout of the
same repository and verifies its branch and canonical common-directory identity. It
captures the full HEAD, configured base HEAD and merge base, requires a completely
clean target, and passes source text as literal data. A matching `.lane/gate.json` is
disclosed as inherited evidence. A missing, malformed, or mismatched gate is reported
as unavailable at this HEAD and review continues; the command never runs prepare,
check, validation, or a framework executable and never turns a gate into a verdict.

The installed [review template](REVIEW_TEMPLATE.md) overrides generic engineering
instructions with a review-only role. The reviewer may write exactly the designated
private delivery file inside its lane worktree:

```text
.lane-review-<full-head>-r<N>/record.md
```

The CLI creates that private directory with a self-ignoring `.gitignore`, without
changing project ignores or native permissions. Canonical `.lane/` remains protected
from worker writes. After validation and sanitization, the CLI exclusively saves the
validated bytes in the canonical checkout and removes the delivered file:

```text
.lane/reviews/<topic>/<head7>-r<N>.md
```

The archive path must be gitignored, untracked, absent, and free of symlink escapes. The
corresponding `docs/reviews/<topic>/<head7>-r<N>.md` path must be absent, untracked,
trackable, and not ignored; the same command creates the public record after the
unchanged-lane check. Matching abbreviations tied to another full SHA refuse as
ambiguous. The CLI never overwrites, stages, commits, resets, cleans, fixes, retries,
or selects another round.

The reviewer cannot write other files in the lane worktree, including ignored scratch,
cache, dependency, or build paths. Test and mutation copies belong in its private run
temporary directory and must be cleaned afterward. The only repository write it may
make is the required private delivery record. Without an unambiguous supplemental
`Review run budget`, the budget is zero build/test/prepare/install/check commands.
An authorized budget names exact commands
and a finite count for each command and witness. Every authorized build or test waits
for a clear machine-load probe and runs alone; the CLI passes the budget but executes
none of it.

The private record is valid UTF-8 with LF line endings only, at most 1 MiB, ends
with `<!-- lane-review-complete -->`, and has exactly `**PASS**`, `**NEEDS-WORK**`,
or `**FAIL**` as its first nonempty line. Leading and trailing blank-line runs around
the whole record and each section are ignored symmetrically. It uses `Schema:
lane-review/v1`, the captured full SHA/topic/round/review ID/base, and the unique
ordered sections Findings, Re-executed, Non-claims, Unverified, Private identifiers,
and Analysis. Findings are `None` or `[Major]`, `[Moderate]`, or `[Minor]` bullets
with a repository-relative positive `file:line`, the structural ASCII ` - ` separator,
and the literal `; Fix: ` separator. The shared prompt requires this shape for every
route and verdict. Projection preserves malformed finding lines as literal prose
prefixed with `[Unparsed finding]`, with the same path/alias sanitizer, escaping,
and idempotence checks as other public prose. Blank lines in Findings are ignored;
an empty section yields a marked notice that no finding text was supplied. It never
copies Private identifiers or Analysis into Findings, and malformed or ambiguous
section boundaries still refuse publication. Parsed finding locations retain their
structural safety checks. Non-claims and Unverified are `None` or consecutive bullets
with no blank line between them.
Private identifiers is a JSON array of nonempty strings; Analysis is private and may
be empty.

Re-executed is one JSON fenced array. Every object has exactly `command`, `cwd`
(`lane` or `scratch`), integer `exit_code`, nonempty `result`, boolean `tests_pass`,
and `witness`. A witness is null or an object with exactly `kind`
(`negative-control` or `mutation`), `command`, `cwd`, integer `exit_code`, nonempty
`result`, and nonempty `observed_failure`. A tests-pass entry requires exit zero and
an observed witness. Free prose cannot claim tests passed; inherited gates are not
fresh Re-executed evidence. To cite a supplied gate, copy the template's exact
inherited-evidence acknowledgment under Non-claims. Only that whole bullet in that
section is exempt from the prose claim check; appended or paraphrased claims remain
subject to the check. Re-executed command strings, including witness commands,
are machine syntax and are rendered verbatim inside the JSON fence after required path
and alias sanitization. Prose may quote error messages, usage strings, and identifiers
with Markdown or HTML punctuation; public rendering escapes that punctuation as
described below. A finding file-and-line value is structural rather than prose and
keeps the stricter markup and encoding restriction.

After the completion marker appears, the record's size and modification time must
remain unchanged for two continuous seconds; any change restarts that settle
interval. The interval counts against `--timeout`, and the command re-reads the
record bytes immediately before validation. It then validates that final read and
rechecks the exact HEAD, branch, and a completely clean lane before accepting the
verdict. It polls only the selected private path with foreground timers. It does not
infer completion from chat or an agent footer, send follow-up actions, kill the
reviewer, delete partial/late evidence, or leave a watcher behind.
Failure retains the delivery directory and any private evidence there. The timeout
or interruption message names that path for inspection, and the occupied directory
blocks another dispatch at the same HEAD and round, even before a late file arrives.
Recovery uses an explicitly selected later round. A concurrently occupied archive
is never overwritten, and the delivered evidence remains available on refusal.

Only after that unchanged-lane check, the CLI constructs a public envelope from the
validated metadata, Findings, Re-executed, Non-claims, and Unverified sections. It
never copies Analysis, Private identifiers, unknown fields, or raw transcripts. The
public record preserves the verdict, full SHA, findings, evidence, and limits, adds a
Sanitization section, stays within 120 lines and 64 KiB, and is created exclusively at:

```text
docs/reviews/<topic>/<head7>-r<N>.md
```

Every projected string is NFC-normalized. Proven paths inside the reviewed repository
become repository-relative first. Other contiguous absolute POSIX tokens, drive-letter
paths, UNC paths, and file URLs matched by the concrete path pattern become
`[ABS_PATH]`. There is no syntax exemption from that matcher. Regex literals and
slash-delimited phrases in public prose may be replaced by the absolute-path
placeholder; reviewers should spell patterns in words. This over-redaction is
acceptable. The concrete matcher itself only replaces and never refuses; the
ambiguous spaced-path and parenthesized-residue rules still can refuse the whole
publication, including regex-like text.
Shell command-substitution delimiters remain literal, but their bodies and any trailing
path text are scanned normally. Non-file URL-like tokens remain literal when the
concrete matcher does not match them. After repository paths are converted, each
concrete absolute-path match starts a scan that advances to the next whitespace
regardless of any intervening non-whitespace characters. The scan then continues
across subsequent whitespace-delimited tokens, crossing separator-free tokens and
stopping at the end or at another token whose path separators are all covered by
concrete matches; that token is sanitized independently. If a
non-absolute token with a slash or backslash appears first, or if concrete matches in
a separator-bearing token leave an unmatched separator-bearing prefix or suffix,
publication refuses rather than exposing a possible spaced-path suffix.

The path-specific refusals are:

- Ambiguous spaced path: after repository-path conversion, a concrete absolute-path
  match advances through any following non-whitespace characters to the next
  whitespace, then reaches a non-absolute separator-bearing token before the end or
  another independently sanitizable absolute path. A token is independently
  sanitizable only when its concrete matches leave no unmatched separator-bearing
  prefix or suffix.
- Parenthesized path residue: an opening parenthesis immediately after a concrete
  absolute-path match refuses publication, and a closing parenthesis followed by a
  non-whitespace character also refuses rather than expose an unmatched suffix; a
  standalone closing delimiter remains publishable.

Case-insensitive whole path-segment or Unicode
word-boundary matches for the current OS username/home basename, hostname/full first
label, and declared private identifiers become `[USER]`, `[HOST]`, and `[PRIVATE]`.
Matches run longest-first; equal aliases use user, then host, then private precedence.
An underscore is an alias boundary, like other punctuation. Automatic duplicates are
removed. A proper substring relationship between distinct
declared tokens refuses as ambiguous; nested automatic host aliases are safe under
the longest-first rule.

The Sanitization section records counts for absolute-path, user, host, private, and
repository-relative conversions, including zero, plus modified execution fields by
array index/name without original values. Generated placeholders are reserved;
reviewer-supplied reserved placeholders are refused in every projected field,
including protected finding locations. The checker also refuses aliases in protected
file:line or captured metadata, controls/newlines, non-ASCII residue,
residual paths/aliases, and any non-idempotent second pass. A finding description that
contains a declared private identifier is unresolved and refuses publication. After
sanitization, the idempotence rescan operates on the unescaped payload. It decodes
percent octets, numeric character references, and a backslash immediately before a
forward slash in a scratch copy before checking again for paths and aliases. Protected
finding locations decode the same escaped separator before path inspection. Only then
does the renderer backslash-escape every
backslash, backtick, asterisk, underscore, square bracket, and angle bracket in
Findings, Non-claims, and Unverified prose; it also escapes an opening parenthesis
immediately after a generated placeholder. Markdown and HTML therefore display those
characters literally. Commands stay verbatim because the JSON fence already makes
them literal. Prose punctuation and encoded-looking quoted text are not refusal
categories. Publication refuses prose only for non-ASCII or control characters,
unresolved private identifiers, reviewer-written reserved placeholders, ambiguous
spaced paths, parenthesized path residue, and residual paths or aliases after
sanitization. Schema tags, JSON fences and CLI placeholders are structural. The
mechanical policy cannot prove that arbitrary prose contains no undeclared human name
or secret, so the operator still inspects before committing.

The CLI creates the public file only after sanitization and the pre-publication clean
check, without replacement, staging, or committing. It then requires the same HEAD and
branch with exactly that one new untracked file before emitting a verdict. stdout is
exactly `PASS` with exit 0 or `NEEDS-WORK`/`FAIL` with exit 1; stderr names both files.
Before launch, a supervisor STOP instead emits the stopped JSON receipt with exit
3, as described under dispatch above. Review also accepts `--memory-checked`.
Every preflight, dispatch, timeout, incomplete/oversized/invalid record, moved/dirty
target, unverified sanitization, exclusive-write/final-integrity failure, signal, or
pipe refusal exits exactly 2 with no verdict.

A late reviewer may still finish the private file after timeout or interruption. A
late-publication exit 2 can retain an untracked public file when a concurrent mutation
is detected after creation; it is not a successful review result. Inspect both files
and all work before deciding whether to commit or remove anything. A commit changes
HEAD and needs a fresh gate plus an explicitly selected round. To reuse the same HEAD
and round, separately authorize removal of both outputs only after ensuring the old
reviewer cannot write and restoring a clean tree; otherwise retain the evidence and
choose a fresh round. The CLI performs no cleanup or occupied-round bypass.

Round 3 or later should explicitly select an operator-configured
`review-xhigh` route for adversarial, cryptographic, or semantic work, or `review-max`
after repeated NEEDS-WORK. This is advice only: review never advances a round, changes
routes, loops, fixes, commits, promotes, or pushes.

## Model routing guidance

Operators should map stable role names to models using the vendors' own current
recommendations, then record why each mapping exists in the route's `use` field.
The table below summarizes the vendor guidance fetched on 2026-09-07; availability
and recommendations can change, so recheck the linked source when updating routes.

| Model | Vendor positioning | Example route fit |
| --- | --- | --- |
| [`gpt-6-astra`](https://learn.chatgpt.com/docs/models) | OpenAI's most capable model for complex work across code, apps, and research, with stronger judgment | Only when explicitly named by project route configuration |
| [`gpt-6.1-sol`](https://learn.chatgpt.com/docs/models) | Sol for complex coding, computer use, and research; replaced `gpt-5.6-sol` (archived) on 2026-10-01 | Engineering lanes |
| [`gpt-5.6-terra`](https://learn.chatgpt.com/docs/models) | Balanced everyday work at lower cost | Mechanical or isolated changes |
| [`gpt-5.6-luna`](https://learn.chatgpt.com/docs/models) | Fast and affordable for clear, repeatable tasks such as extraction and classification | Repeatable, well-specified work |
| [`claude-opus-5`](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) | Complex agentic coding and enterprise work, including large refactors and complex systems engineering; start at its default `high` effort | Independent review |
| [`claude-sonnet-5`](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) | Speed and capability for everyday coding and agent workloads | Everyday engineering |
| [`claude-haiku-4-5`](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) | Lowest latency and price, including sub-agent tasks | Narrow or high-volume tasks |
| [`claude-fable-5-1`](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) | Highest capability for agent sessions that run for hours and multistep research | Long-running facilitator |

The OpenAI page's reasoning selector presents Low, Medium (default), High, Extra
High, Max, and Ultra. Start at Medium and raise effort when deeper planning or
analysis is needed; Ultra adds automatic subagent delegation for divisible work.
The same page lists `gpt-5.4-mini` as retired from Codex with ChatGPT sign-in on
2026-08-31 and directs those configurations to `gpt-5.6-luna`; API-key-authenticated
Codex and the OpenAI API are not affected by that retirement. Vendor recommendations
are starting points: validate route choices against the repository's real tasks,
latency needs, and budget.

## Status

```text
main 10ca91f
lane/api-change  +2/-1 vs main  /worktrees/lane-api-change  DIRTY  rebase: clean
shared files: lane/api-change × lane/docs-change: src/client.js
```

- `+N`: commits unique to the lane
- `-N`: main commits missing from the lane
- `DIRTY`: uncommitted changes
- `rebase: current`: the lane already contains main; promote fast-forwards it
- `rebase: clean`: clean dry-run replay onto main
- `rebase: CONFLICT <files>`: manual resolution required
- `rebase: merge commit present; ...`: the lane is behind main and carries a
  merge commit, so promote will not rebase it (see below)
- `shared files`: paths changed by more than one lane

## Promotion

`lane promote <topic>`:

1. Requires clean lane and canonical worktrees.
2. If main moved after the lane branched, dry-runs a rebase onto current main.
   A lane that already contains main skips steps 2 to 4.
3. Refuses and lists files on conflict. Also refuses, with no file list, when
   the lane carries a merge commit (for example a `git subtree add`): a plain
   rebase would flatten that history and may conflict.
4. Rebases automatically when clean.
5. Runs missing prepare steps and validation in the lane.
6. Refuses if main moved during validation.
7. Fast-forwards local main without merging or pushing remotely.

Run only one promotion at a time.

Independent review and promotion authority remain the caller's responsibility;
`promote` obtains passing promotion evidence for the exact tree and environment,
reusing a matching pass. It does not enforce a saved review verdict or consume a
worker gate as approval. Run it from the canonical checkout on the
configured integration branch.

## Close and resume

`lane close <topic>` requires a clean lane worktree. A merged branch is deleted. An
unmerged branch is tagged as `archive/lane/<topic>` before deletion.

Close first attempts Herdr-native worktree removal so its workspace retires too.
If Herdr is unavailable or removal fails, it falls back to Git removal; a successful
Git close can therefore leave a visible workspace. Verify the exact workspace and
tab identities after close. Preserve required ignored artifacts outside the lane
before removal; neither a commit nor an archive tag saves them.

Only after those Git operations succeed, close writes done markers for every known
session matching the canonical repository and exact topic. Dirty refusal or archive
failure leaves completion unchanged; promotion alone never marks done. With no
registry state, close remains Git-only and creates no metadata. A post-close marker
write error exits nonzero with `lane closed; metadata update failed` and does not
recreate the already-closed lane. If the configured registry is external, unignored,
or tracked, its automation policy refusal is instead a warning after the successful
Git close and the command exits zero without writing markers. Read errors from
unrelated registry records are also warnings: healthy matching sessions are still
marked and a successful close remains successful.

```sh
lane seams
lane open resumed-task archive/lane/old-task
```

## Common failures

| Message | Action |
| --- | --- |
| `cannot read lane config ...` / `invalid lane config ...` | Fix the named selected file; lifecycle actions have not started |
| `worktree path already exists` | Choose another root/topic, or move the occupant yourself only after verifying ownership |
| `unsafe worktree path` | Move the configured base outside checkouts and remove symlink escapes; no fallback path is selected |
| `worktree path belongs to another repository` | Give the repositories distinct worktree bases |
| `session registry must be gitignored before dispatch` | Ignore both the configured path and `<registry>.d/` in the repository's `.gitignore` or the operator's global excludes file, or configure another repository-local ignored path |
| `partial success: ... brief was already sent` | Inspect and continue the named live agent; do not replay dispatch |
| `lane closed; metadata update failed` | Git close already succeeded; repair the local registry without recreating the lane |
| `registered worktree ... is missing` | Run `git worktree prune`, then reopen or recover the lane as appropriate |
| `repository identity mismatch` | Treat the Herdr entry as stale; reopen the correct canonical repository workspace |
| `herdr workspace: none` | Start Herdr in the canonical checkout and retry dispatch |
| `lane worktree is not clean` | Commit or stash lane changes |
| `current worktree is not clean` | Commit or stash changes before `lane check` |
| `canonical main checkout is not clean` | Commit or stash canonical changes |
| `validation failed ... nothing merged` | Fix the lane and promote again |
| `does not rebase cleanly; conflicts in: ...` | Rebase manually and resolve the listed files |
| `does not rebase cleanly; merge commit present` | Rebuild the merge on current main (redo it from the new main tip) or flatten the history by hand, then promote again |
| `main moved during validation` | Promote again against the new main |

## Development

`npm run test:lanes` (from the herdr-brain root) runs offline behavioral tests
in temporary git repositories. The shared helpers use a fresh temporary `HOME`
and `XDG_CONFIG_HOME`, an isolated global Git config containing only the test
identity, no system Git config, and no inherited environment-level Git config
entries. Operator global excludes and system settings
therefore cannot change fixture behavior. Herdr-only coverage skips when Herdr is
absent.
