# Design: Turn an idea into a brief and dispatched lane

## CLI contract

Depend only on session-registry (2a), which already includes root/config resolution
and automatic dispatch metadata. This command selects --repo explicitly and needs
no machine inventory or UI boundary. The later composer obtains its repository
picker from discovery; that does not delay this independent CLI capability.

```sh
lane new <topic> --repo <path> --route <name> [--edit] -- "task text"
lane routes --repo <path> --json
```

The final positional string is the task; --repo and --route both take explicit
values. Also accept a single @file task input (resolve relative to caller cwd) for
long/multiline ideas; reject mixing @file with extra task operands. Quoted text is
literal data. -- ends option parsing. Reject empty/whitespace input, invalid topic,
unknown/missing route, missing/invalid repo, conflicting options, and extra input.
A path may name a subdirectory or linked checkout; normalize to its canonical repo.
This command works outside git and never acts on whichever pane happens to be
focused. The explicit repository determines config and parent workspace.
An identity root supplies neither a canonical repository nor a lane destination:
refuse with guidance to choose an existing repository or pass its explicit `--repo`.
Do not choose an implicit default, create a scratch repository, run git init, or
start a facilitator. A visible root-default preselection requires a separate
proposal and must still submit an explicit `--repo`.

Use the installed tool's docs/BRIEF_TEMPLATE.md, filling every section with the task
and generic repository instructions rather than leaving instructional placeholders.
Write canonical `<repo>/.lane/briefs/<topic>.md` atomically and exclusively; require
.lane/ to be untracked and ignored first. Preserve task bytes (including quotes,
backticks, dollar signs, newlines, and Unicode) as brief content, never shell code.
For the goal, write a heading from the first nonempty task line (up to 200 Unicode
code points), with the complete original idea under Outcome. Include selected route,
scope to the target lane, required AGENTS/baseline/test-first/handoff rules, and the
`docs/reports/<topic>.md` report convention. No personal/model
defaults or fictional project-specific acceptance tests.
Generated constraints authorize implementation and commits in that lane, forbid
push/publish/promote/close, and require asking for missing material task constraints.

Preflight config/route, canonical identity, branch/destination, ignored safe storage,
brief source/template readability, available Herdr, and canonical parent workspace
before creating a brief or lane. Do not start a facilitator workspace implicitly.
Then write brief; optionally edit; validate edited text; invoke the same open and
dispatch operations once, with the absolute brief path. The lane must be created
from its resolved main branch. No success until dispatch and registration succeed.

## Editor and failure behavior

--edit invokes VISUAL, then EDITOR, falling back to vi, in the canonical repo with
the generated file as a separate safely quoted argument and inherited terminal.
The operator's editor setting is a trusted command; task/path content must never
be interpolated as shell syntax. Document these environment variables and the need
for a waiting editor command. Missing/nonzero editor or empty edited brief cancels
before open, leaves the ignored draft, and exits nonzero. Non-TTY --edit refuses
before writing. Without --edit, the command is noninteractive.

An existing branch, worktree destination, or generated brief is a conflict: refuse
without overwrite or automatic reuse. A failure after creating the brief leaves
that ignored file; after open it also leaves the recoverable lane. Print the actual
paths and next explicit step (inspect/edit the draft, or use lane dispatch for an
unprompted existing lane). Do not rerun lane new automatically or offer to resend
a possibly delivered brief. Unknown prompt delivery stays explicitly ambiguous.
No rollback deletes user work. No queue, job record, retry loop, or promotion.

lane routes --repo --json exposes schema_version=1 and sorted route records with
name, resolved kind/model/args and use note; do not expose env secret values to the
picker. It uses exactly the dispatch resolver and never starts an agent.

Schema audit: `lane routes --repo --json` already provides name, resolved kind,
model, args and use, but **needs field (idea-cli)** for a documented effort
projection from recognized arguments or an explicit resolved effort field. **Needs
field (idea-cli):** a machine-readable lane-new result for success and partial
outcomes, containing the canonical repository, resolved destination when known,
lane/worktree identity, agent/session or registry row identity, brief path, and
delivery/registration stage. Human prose alone cannot support exact composer
selection or distinguish partial outcomes.
