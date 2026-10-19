# Read-only project setup

This first slice provides a foreground, dependency-free prerequisite check and
planning interface over the existing modules. It uses Node **20.19.4**, Git, an
installed Herdr endpoint, the project's discovered record, existing routing and
validation configuration, and the existing per-project release pin contract.

```sh
node /path/to/product/setup/setup.mjs doctor --project /path/to/project
node /path/to/product/setup/setup.mjs plan --project /path/to/project
node /path/to/product/setup/setup.mjs --help
```

Both commands emit JSON and accept only `--project PATH`, `--workspace REF`
(default `home`) and `--help`. Unknown verbs, options and positional arguments
fail before observation. There is **no `init` or `apply` command** in this module.
No executable name or installation alias is added in this slice.

`doctor` returns `schema: project-setup-doctor/v1`, an `outcome` (`ready` or
`held`), canonical project identity, and named checks with `state` (`ok`, `held`
or `advisory`), `observed` and coded `reasons`. Only `held` checks prevent a ready
outcome. It checks:

- The executing Node version against the product's `.nvmrc`.
- Canonical Git common-directory identity, committed manifests and route layers.
- Record discovery and readability, including incomplete-tail holds.
- Existing project routing and validation declarations, without running them.
- The accepted committed `.herdr-release.json` pin and selected installed release,
  separately from the product executing the command. Each project's pin is
  independent of global `current`; a broken accepted pin holds without fallback.
- Herdr reachability through a bounded snapshot and agent metadata reads.
- Native trust and capability requirements. Native trust/authentication are
  **unverified** for Sessions and reported as an `advisory`: this interface has no
  authoritative native trust probe. This advisory does not change the outcome or
  exit status. The owner must verify project trust and authentication in the native
  harness before launch. Presence of a config file or manifest is not proof.
  Unsupported native profiles, required memory adapters, context materializers
  and later-stage triage activation have explicit holds.

`plan` returns `schema: project-setup-plan/v1`, its doctor result, diagnostics,
errors and one `changes` row per desired session. Rows identify UID, logical
workspace, standard tab/pane position, concrete observed target where available,
and an `outcome` of `create`, `keep` or `refuse`, with coded reasons and separate
`advisories` for unverifiable native trust. Advisories do not prevent a create
preview or change its exit status. The existing
session planner supplies canonical enrollment, incarnation and journal checks.
Only a proven empty, already adopted standard slot can produce a `create`
preview (`start-standard-slot`). A missing workspace is refused with
`workspace-not-enrolled`; this slice cannot create or enroll layouts. Matching
live incarnations stay `keep`, with trust uncertainty still visible. Unknown,
foreign or manual occupants are refused and preserved. No session is adopted,
closed, restarted or prompted by planning. The planner selects at most one
action per pass; other rows can remain deferred/held.

Plan outcomes are `planned`, `unchanged`, `held` or `refused`. Both commands exit
0 for a ready/planned/unchanged result and 1 for a held/refused result or invalid
invocation. Exit 1 often means a prerequisite needs owner attention, not a
transport crash. The preview grants no authority, is not an apply receipt, and
cannot be passed to the existing session apply command as a saved session plan.

Neither command writes a record, lease, journal, status cache, config, pin or
enrollment. It starts no daemon, wrapper, hook, permission change or schedule.
Herdr reads never read pane text or native conversations, send prompts, focus
panes or invoke a lifecycle action. Model work remains outside this interface.

## Workspace composition

Copy [`sessions/templates/workspace.md`](../sessions/templates/workspace.md) to
the canonical project's `.sessions/workspace.md`, alongside complete existing
Session and LogViewer templates. The same Markdown parser, closed root/metadata
fields and API version apply. Workspace `spec` accepts exactly:

| Field | Meaning |
| --- | --- |
| `workspaceRef` | Existing logical workspace reference; `home` is canonical. |
| `sessions` | Nonempty array of unique relative Markdown paths inside canonical `.sessions/`. Every reference must resolve to a complete Session or LogViewer with matching `workspaceRef`. |
| `routeProfileRef` | `project-default`: use the existing layered project routes. |
| `validationProfileRef` | `project-default`: use the existing lane validation declarations and `.lane.validation.json`. |

`project-default` binds established configuration, not a new profile registry.
Unknown profile names, inline commands/policy, unknown fields, duplicate decoded
JSON keys, absolute/traversing paths, dangling links, symlink escapes, nested
Workspace references and duplicate composition membership are rejected. UID
uniqueness includes Workspaces and Sessions; each logical workspace can have one
composition. A composition owns no second record, queue, controller or triage.

Discovery reads top-level `.sessions/*.md` and exact nested resource paths
referenced by a valid committed top-level Workspace from one frozen
**canonical committed HEAD**. Other nested Markdown remains opaque, including
untracked notes.
Referenced resources must be committed regular blobs in that same snapshot.
Untracked/index/working-tree bytes cannot replace them; diagnostics name ignored
changes at those discovered paths. A valid committed Workspace suppresses
implicit bundled session defaults only for a matching selected `workspaceRef`;
independently committed top-level Session/LogViewer declarations remain inspected
and validated. Other workspace selections retain their bundled defaults. Without
a Workspace, existing session discovery/defaults continue.
The existing `sessions/sessions.mjs inspect` also expands Workspace files into
`entries`, with compositions separately in `workspaces`. Explicit file inspection
is a working-file preview; Workspace files and their references must still live
inside canonical `.sessions/`. There is no interpolation of names or paths.

## Synthetic fresh-project walkthrough

This walkthrough uses a disposable repository and an already installed product.
It is an operator-run example: setup itself creates nothing. It requires no
private repository, production record, live canary or model call.

```sh
# Select Node 20.19.4 using your existing Node installation.
product=/absolute/path/to/herdr-brain
demo=$(mktemp -d)
git -C "$demo" init -b main
printf '{}\n' > "$demo/.lane.json"

node "$product/setup/setup.mjs" doctor --project "$demo"
```

Expect JSON naming the canonical identity and whichever prerequisites are
missing. With no record it includes `record-unavailable`; with no reachable
Herdr it includes `herdr-unavailable`. A missing installation selection includes
`release-unavailable`. Default Sessions surface `native-trust-unverified`, and
the home triage Session also shows activation/native profile holds. Native trust
is advisory; the record, release, reachability and capability holds determine the
held outcome. The empty `.lane.json` matches the synthetic test fixture and uses
the suggested route preset without project overrides. Exit 1 is
expected while those holds remain. The project files and native trust settings
are untouched.

An owner can now declare the desired standard workspace with complete templates:

```sh
mkdir "$demo/.sessions"
for name in workspace chat supervisor logs-viewer logs-triage; do
  cp "$product/sessions/templates/$name.md" "$demo/.sessions/$name.md"
done
# Review names, UIDs, routes and policy requirements in these files.
git -C "$demo" add .lane.json .sessions
git -C "$demo" commit -m 'Declare the home workspace'

node "$product/setup/setup.mjs" doctor --project "$demo"
node "$product/setup/setup.mjs" plan --project "$demo"
node "$product/setup/setup.mjs" plan --project "$demo"
```

With ordinary Git author configuration, the composition now resolves four
complete resources: chat, supervisor, logs/viewer and logs/triage. Both plans
list those desired positions and `workspace-not-enrolled`, alongside any record,
release or capability holds and a separate native trust advisory. The repeated
preview creates no duplicate sessions, directories or records. Establishing the project's record,
accepting its release pin, verifying native trust, enrollment and live adoption
remain explicit owner work through the existing contracts. A later reviewed
slice will define initialization and application; this walkthrough does not
claim those mutation paths or triage enforcement exist.
