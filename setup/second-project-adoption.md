# Second-project adoption

These are owner-run recipes. Each project retains its own Git common
directory, record, native supervisor, workspace, line and saved watchers.
Use values from the adopting project's own accepted release and native session.

| Question | Supported path or gap | Command | Availability |
| --- | --- | --- | --- |
| Q1: workspace and standard-slot enrollment | `record adopt` enrolls the existing invoking canonical native supervisor and its workspace, with KEEP plus observed-adoption controller evidence. It does not create the workspace or enroll arbitrary other occupied tabs. Missing chat creation has a separate scoped authorization. | `node "$ADOPTION_PRODUCT/bin/org.mjs" adopt . --inspect --expires "$ADOPTION_EXPIRY"`, then `adopt . --scope "$ADOPTION_SCOPE" --decision "$ADOPTION_ANSWER"` | Existing enrollment command. Native bootstrap and additional occupied-slot selection remain gaps. |
| Q2: default triage holds | No native enforcement/materialization/activation adapter can satisfy these requirements today. A committed home Workspace containing only chat/supervisor is a supported narrower scope; existing explicit resources remain requirements. | First generate and commit the [initial workspace composition](#scope-the-initial-workspace), then capture adoption scope and enroll. After enrollment, run `node "$ADOPTION_PRODUCT/setup/setup.mjs" plan --project "$ADOPTION_PROJECT"`. | Existing manual scoping. Automatic initial scope remains a gap. |
| Q3: canonical native owner and line recipient | An actual distinct native supervisor in the new canonical project is required. A name, shell `cd`, actor or inherited pane is insufficient. Fresh release installation now has an exact plan/apply path; apply records the actual canonical cutoff and starts one job. | `launchd.mjs install --id initial-line --dry-run`, then the identical command with `--expected-plan SHA256`; exact bindings below | Requires a qualified READY release containing fresh-install plan/apply support. Native bootstrap remains a gap. |

Use a qualified release containing each required extension. Source changes and
fixture checks do not prove live adoption or acceptance of a carrying release.

## Enroll an existing supervisor

**Scope first, then enroll.** If using the narrower initial workspace, set the
variables below, complete [Scope the initial workspace](#scope-the-initial-workspace)
and commit the composition before running `adopt --inspect` below. Then return
here to capture the adoption scope, obtain its exact authorization and enroll.
Copied templates retain `template-supervisor`, while implicit defaults use
`default-supervisor-<hash>`; enrollment is keyed by UID. Committing the composition
after adoption changes that UID and loses the enrolled supervisor's KEEP.
Re-adopting a changed scope is refused with "saved scope differs from the original
binding; owner disposition required". If already in that state, preserve the
original binding and seek its owner's disposition rather than retrying adoption.

Run from the **new project's canonical checkout inside its own actual native
supervisor session**, under its owning identity. Each existing supervisor
continues to own its existing project. Use a separate unique native name for
the new project's actual supervisor. Its native cwd, workspace
repository/common-directory binding, pane, terminal and live
conversation must all agree. `HERDR_AGENT_NAME`, `HERDR_PANE_ID` and
`HERDR_WORKSPACE_ID` must describe that real session; changing environment values
does not create it. Brain currently has no command to bootstrap this prerequisite
from the other project's supervisor.

Select the actual installed product root from the project's accepted READY
release. Use the pinned Node 20.19.4 runtime. Replace the absolute-path
placeholders below with that runtime, the accepted product root and the new
project's canonical checkout:

```sh
ADOPTION_NODE=/ABS/path/to/node-v20.19.4/bin/node
ADOPTION_PRODUCT=/ABS/installed/releases/ACCEPTED_READY_RELEASE
ADOPTION_PROJECT=/ABS/path/to/new-project-canonical
cd "$ADOPTION_PROJECT"
export ORG_DIR="$ADOPTION_PROJECT/.org"
# Set ORG_ACTOR to the actual new canonical supervisor's name.
ADOPTION_EXPIRY=REPLACE_WITH_BOUNDED_FUTURE_UTC_TIMESTAMP
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/bin/org.mjs" adopt . \
  --inspect --expires "$ADOPTION_EXPIRY" > /tmp/adoption-scope.json
```

This is a scope capture, **not a write-free dry run**: it writes the canonical
saved scope under `<common>/config-home/scopes/` while making no native actions.
It discovers config/record/worktree sources and requires a compatible READY
effective release. Prepared pin or promotion policy must match its accepted
committed source. `fleet join` is not a prerequisite: adoption validates and
publishes its home binding into the existing project-discovery union itself.

Create a human question in the new owning record and store the returned JSON's
**scope object**, unchanged, in that question's
`meta.adoption_authorization` **before** the attributed human answers. For example,
set `ADOPTION_PARENT` to the prepared new record's existing owning goal:

```sh
ADOPTION_QUESTION=$("$ADOPTION_NODE" "$ADOPTION_PRODUCT/bin/org.mjs" add \
  'Authorize adopting this workspace and supervisor?' \
  --role human --parent "$ADOPTION_PARENT" --meta category=security)
ADOPTION_SCOPE_JSON=$("$ADOPTION_NODE" -e \
  'process.stdout.write(JSON.stringify(require(process.argv[1]).scope))' \
  /tmp/adoption-scope.json)
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/bin/org.mjs" set "$ADOPTION_QUESTION" \
  "meta.adoption_authorization=$ADOPTION_SCOPE_JSON"
```

Present that scope to the actual owner/operator. The existing attributed human
`record answer HUM-n yes` transaction is required; an agent must not author a
human answer or substitute an old general approval. If an exact valid answer
already exists, reuse it. `ADOPTION_ANSWER` is `HUM-n:SEQ`, where SEQ is the
answer note's sequence, not the later update or close event. Use the original
`scopeFile` returned by capture; do not edit the saved file or any receipt.

```sh
ADOPTION_SCOPE=RETURNED_CANONICAL_SCOPE_FILE
ADOPTION_ANSWER=HUM-n:ANSWER_NOTE_SEQUENCE
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/bin/org.mjs" adopt . \
  --scope "$ADOPTION_SCOPE" --decision "$ADOPTION_ANSWER"
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/sessions/sessions.mjs" plan \
  --project "$ADOPTION_PROJECT" --workspace home
```

Read-back must KEEP the enrolled supervisor without prompt replay. Adoption
records observed ownership, not a fabricated launch/context receipt. STOP,
unknown/manual other occupants, pending operations and capability holds survive.
The CLI's capture selects only the supervisor tab; there is no public selection
flag for adopting existing chat/log tabs. Never edit its scope to add them.

For a **missing** chat, the existing `sessions authorize` / `setup apply` path
can create it after enrollment. The attributed action scope must explicitly
include `create-standard-slot` (and `start-standard-slot` if needed). Run:

```sh
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/sessions/sessions.mjs" authorize \
  --project "$ADOPTION_PROJECT" --workspace home --role supervisor \
  --actor "$ORG_ACTOR" --actions create-standard-slot,start-standard-slot \
  --operator-decision "$ADOPTION_ACTION_ANSWER" --expires "$ADOPTION_EXPIRY"
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/setup/setup.mjs" apply \
  --project "$ADOPTION_PROJECT" --workspace home > /tmp/adoption-setup.json
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/setup/setup.mjs" apply \
  --project "$ADOPTION_PROJECT" --workspace home --execute \
  --authorization "$ADOPTION_AUTHORIZATION" --plan /tmp/adoption-setup.json
```

Here `ADOPTION_ACTION_ANSWER` names a separate exact action-scope human answer
and `ADOPTION_AUTHORIZATION` is the returned authorization file. Follow
[sessions authorization](../sessions/README.md#explicit-authorization-and-single-action-apply-wave-a2) for the
closed `meta.session_authorization` scope. Adoption approval alone grants no
create/start permission. The saved setup dry run must be fresh (60 seconds)
and planned/unchanged, with native trust/authentication verified by its owner.

## Scope the initial workspace

`setup/setup.mjs:capabilityHolds` explicitly holds triage activation, every
Session profile other than `identity-default`, and required context sources
outside its implemented materializers. Creating files cannot satisfy those
missing adapters. Do not relabel triage permissions or mark required context
optional. `doctor` reports these requirements even when a missing logs layout
can be skipped by `plan`/`apply`.

For a fresh project with **no existing `.sessions` directory**, its own agent
can generate a narrower committed composition from shipped templates before
capturing adoption scope. This retains chat/supervisor requirements and never
declares triage activated. The script refuses an existing directory; existing
declared resources or native occupants require their owner's explicit handling.
Run in the canonical checkout with the variables above:

```sh
"$ADOPTION_NODE" --input-type=module - "$ADOPTION_PRODUCT" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const templates = path.join(process.argv[2], 'sessions/templates');
fs.mkdirSync('.sessions');
fs.mkdirSync('.sessions/initial');
for (const name of ['chat', 'supervisor'])
  fs.copyFileSync(path.join(templates, name + '.md'), '.sessions/initial/' + name + '.md');
const text = fs.readFileSync(path.join(templates, 'workspace.md'), 'utf8');
const workspace = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/u)[1]);
workspace.spec.sessions = ['initial/chat.md', 'initial/supervisor.md'];
fs.writeFileSync('.sessions/workspace.md', '# Initial home workspace\n\n## Manifest\n\n```json\n' +
  JSON.stringify(workspace, null, 2) + '\n```\n', { flag: 'wx' });
NODE
git add -- .sessions
git commit -m 'Declare initial chat and supervisor workspace'
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/setup/setup.mjs" plan --project "$ADOPTION_PROJECT"
```

Only canonical committed HEAD participates in discovery; staged/untracked files
do not. A valid home Workspace suppresses implicit defaults, while independently
committed top-level resources remain validated. Enrollment and other real holds
still apply. This manual/generated configuration is a current workaround, not
the product's desired agent-discovered default.

## Canonical native owner and line installation

`messages/operator-inbox.mjs:nativeSender` checks the real native caller against
its project/record. `line-service/launchd.mjs` additionally requires its canonical
checkout, and `line-service/retarget.mjs:liveRecipient` requires a live recipient
from that same Git identity. A supervisor from another project cannot serve as
the new project's recipient. Omit `--to` to select the installing
canonical native owner, or explicitly name a real same-project recipient.
Preserve all old project sessions, recipients, watchers and jobs.

For Q3, select the exact accepted READY installed release containing fresh-install
plan/apply support, then run inside the new project's actual canonical native
supervisor session.
Do not set a development source override or run `cutoff --initialize` to simulate
a release installation.
The project must have clean canonical main, an accepted explicit release pin,
no project STOP/HOLD, no retained service configuration, cutoff or UNKNOWN
installation, and no loaded job for this project's exact launchd target.

```sh
ADOPTION_PRODUCT=/ABS/installed/releases/QUALIFIED_READY_RELEASE
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/line-service/launchd.mjs" install \
  --repo "$ADOPTION_PROJECT" --org "$ORG_DIR" --id initial-line \
  --herdr "$ADOPTION_HERDR" --socket "$HERDR_SOCKET_PATH" --interval 30 \
  --dry-run > /tmp/adoption-line-plan.json
ADOPTION_LINE_PLAN=$("$ADOPTION_NODE" --input-type=module -e \
  'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected_plan)' \
  /tmp/adoption-line-plan.json)
# Inspect the full plan and its recipient, transport, runtime and cutoff first.
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/line-service/launchd.mjs" install \
  --repo "$ADOPTION_PROJECT" --org "$ORG_DIR" --id initial-line \
  --herdr "$ADOPTION_HERDR" --socket "$HERDR_SOCKET_PATH" --interval 30 \
  --expected-plan "$ADOPTION_LINE_PLAN"
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/line-service/launchd.mjs" status \
  --repo "$ADOPTION_PROJECT" --org "$ORG_DIR"
```

Omitting `--to` selects that actual native owner. If selecting another live
same-project recipient, add the same `--to NAME` to both commands. Preview reads
the exact target's launchd status but writes no config, receipt, lock, record or
service directory and performs no launchd mutation. The redirected JSON file
above is a caller-owned inspection artifact, not an installation receipt.

Apply rechecks the plan under control, pass, promotion and record locks. The
supported writer retains an exclusive immutable install intent and records
`line-service.cutover` at actual canonical main, then writes bindings and calls
bootstrap once. No historical/Phase0 boundary or development migration is
invented. A changed record, source, native owner/recipient, transport or plan
refuses apply; capture a new preview only if there is no retained attempt.
Partial or refused installs remain fenced, with the original intent and any
cutoff/config/STOP retained. Do not replace them, retry under another ID, edit
receipts or replay bootstrap. Completed fresh installs use the existing
stop/restart, retarget and release-upgrade controls; no migration is needed.
Saved workers/watchers, pins, other project lines and UNKNOWN jobs are untouched.

`fleet join` has no dry run and only registers discovery/config; it does not
create native ownership or standard-slot enrollment. The new install preview
does not enroll sessions, change pins or authorize any other project's effects.
