# Second-project adoption

Source audit for ENG-1092 / R-1490 against **rc-20261030-98002dc75c**
(`98002dc75cb064dd639e79c922ddeb98d3781bc2`). These are owner-run recipes,
not evidence of live adoption. Brain's maintainer performs no BCH effects and
does not read BCH's record or archive. Each project retains its own Git common
directory, record, native supervisor, workspace, line and saved watchers.

| Question | Supported path or gap | Command | Release |
| --- | --- | --- | --- |
| Q1: workspace and standard-slot enrollment | `record adopt` enrolls the existing invoking canonical native supervisor and its workspace, with KEEP plus observed-adoption controller evidence. It does not create the workspace or enroll arbitrary other occupied tabs. Missing chat creation has a separate scoped authorization. | `node "$ADOPTION_PRODUCT/bin/org.mjs" adopt . --inspect --expires "$ADOPTION_EXPIRY"`, then `adopt . --scope "$ADOPTION_SCOPE" --decision "$ADOPTION_ANSWER"` | Existing command in rc-20261030-98002dc75c. Native bootstrap / additional occupied-slot selection gap: ENG-1093, no carrying release yet. |
| Q2: default triage holds | No native enforcement/materialization/activation adapter can satisfy these requirements today. A committed home Workspace containing only chat/supervisor is a supported narrower scope; existing explicit resources remain requirements. | Generate the composition below, commit it, then `node "$ADOPTION_PRODUCT/setup/setup.mjs" plan --project "$ADOPTION_PROJECT"` | Scoping already in rc-20261030-98002dc75c. Automatic initial scope: ENG-1094, no carrying release yet. |
| Q3: canonical native owner and line recipient | An actual distinct native supervisor in the new canonical project is required. A name, shell `cd`, actor or inherited pane is insufficient. Existing install accepts that owner / a same-project live recipient, but there is no Brain native bootstrap or fresh release-only line initialization. | After its supported development-source cutover, `node "$ADOPTION_PRODUCT/line-service/launchd.mjs" install --repo "$ADOPTION_PROJECT" --org "$ORG_DIR" --to "$ADOPTION_SUPERVISOR" --herdr "$ADOPTION_HERDR" --socket "$HERDR_SOCKET_PATH"`; see limits below | Ownership/install guards in rc-20261030-98002dc75c. Bootstrap: ENG-1093. Release-only initialization/install preview: ENG-1095. Neither fix has a carrying release yet. |

This documentation correction ships in the next qualified release containing
its landed commit. It adds no runtime onboarding capability. The follow-ups are
filed, unselected work, not a promise that a later release already implements them.

## Enroll an existing supervisor

Run from the **new project's canonical checkout inside its own actual native
supervisor session**, under its owning identity. The old bch-cloak supervisor
continues to own its existing project. A separate unique native name such as
`supervisor-rehearsal` avoids trying to reuse `supervisor-opus` concurrently.
This is a proposed name, not a claim that such a session exists. Its native
cwd, workspace repository/common-directory binding, pane, terminal and live
conversation must all agree. `HERDR_AGENT_NAME`, `HERDR_PANE_ID` and
`HERDR_WORKSPACE_ID` must describe that real session; changing environment values
does not create it. Brain currently has no command to bootstrap this prerequisite
from the other project's supervisor (ENG-1093).

Select the actual installed product root from the project's accepted READY
release. Use the pinned runtime. For this ask the new project path is:

```sh
ADOPTION_NODE=/Users/rewt/.nvm/versions/node/v20.19.4/bin/node
ADOPTION_PRODUCT=/ABS/installed/releases/rc-20261030-98002dc75c
ADOPTION_PROJECT=/Users/rewt/development/bastian/covenant-shielded-pool-rehearsal-canonical
cd "$ADOPTION_PROJECT"
export ORG_DIR="$ADOPTION_PROJECT/.org"
# Set ORG_ACTOR to the actual new canonical supervisor's name.
ADOPTION_EXPIRY=REPLACE_WITH_BOUNDED_FUTURE_UTC_TIMESTAMP
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/bin/org.mjs" adopt . \
  --inspect --expires "$ADOPTION_EXPIRY" > /tmp/rehearsal-adoption-scope.json
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
using the prepared new record's existing root `G-1`:

```sh
ADOPTION_QUESTION=$("$ADOPTION_NODE" "$ADOPTION_PRODUCT/bin/org.mjs" add \
  'Authorize adopting this rehearsal workspace and supervisor?' \
  --role human --parent G-1 --meta category=security)
ADOPTION_SCOPE_JSON=$("$ADOPTION_NODE" -e \
  'process.stdout.write(JSON.stringify(require(process.argv[1]).scope))' \
  /tmp/rehearsal-adoption-scope.json)
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
  --project "$ADOPTION_PROJECT" --workspace home > /tmp/rehearsal-setup.json
"$ADOPTION_NODE" "$ADOPTION_PRODUCT/setup/setup.mjs" apply \
  --project "$ADOPTION_PROJECT" --workspace home --execute \
  --authorization "$ADOPTION_AUTHORIZATION" --plan /tmp/rehearsal-setup.json
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
the product's desired agent-discovered default (ENG-1094).

## Canonical native owner and line installation

`messages/operator-inbox.mjs:nativeSender` checks the real native caller against
its project/record. `line-service/launchd.mjs` additionally requires its canonical
checkout, and `line-service/retarget.mjs:liveRecipient` requires a live recipient
from that same Git identity. `--to supervisor-opus` cannot target the existing
bch-cloak session for the rehearsal repo. Omit `--to` to select the installing
canonical native owner, or explicitly name a real same-project recipient.
Preserve all old project sessions, recipients, watchers and jobs.

There is **no supported fresh release-only line install sequence** on the audited
release. `launchd install` requires `serviceCutoff`; `cutoff --initialize` rejects
installed bundles and requires matching canonical development source. For an
owner separately authorized to use development source, the existing initializer
is (run inside the new project's actual canonical native session):

```sh
HERDR_BRAIN_ROOT=/Users/rewt/development/rewt/herdr-brain \
  "$ADOPTION_NODE" /Users/rewt/development/rewt/herdr-brain/line-service/cutoff.mjs \
  --repo "$ADOPTION_PROJECT" --org "$ORG_DIR" \
  --id rehearsal-initial-line-boundary --initialize
```

That command records an immutable actual canonical-main boundary and starts no
runtime. The owner would then install with the **same development source** using
the table's install command with `ADOPTION_PRODUCT` set to that source, and later
use the supported [stopped-service migration](../line-service/README.md#move-a-stopped-development-source-service-to-an-accepted-release)
to its accepted release. This is a development bootstrap, not a release-only
solution or authorization to start it. No such effects were performed here.

`fleet join` has no dry run and only registers discovery/config; it does not
create native ownership or standard-slot enrollment. `launchd install --dry-run`
is rejected; dry-run exists only for migrate/upgrade/retarget. Do not use a real
join or install as a preview, invent an installation/cutover event, or pretend
an existing stopped-service migration initializes a fresh project. ENG-1095
owns the smallest release-only initialization and install-preview extension.
