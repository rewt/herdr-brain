# Publication-readiness audit — 2026-10-02

**Do not publish this tree or its history yet.** This is an inventory and a
recommendation per entry. It makes no deletion, redaction, license choice,
namespace change, push, release activation or publication. Existing live pilot
compatibility remains intact.

The exact file list is [publication-files.tsv](adoption/publication-files.tsv):
468 entries, each with an action, recommendation and source line references
where applicable. [publication-history.tsv](adoption/publication-history.tsv)
adds 704 paths requiring outgoing-history review or exclusion. Directory
entries below cover every descendant, including
files without a regex hit. The TSV expands them into individual paths. File
line numbers refer to the lane's source at the audit, not future rewritten files.

## Scope and method

Inspected all **741 tracked paths** at the lane's base (`a49d6be`, “Briefs for
ENG-100 (adoption), ENG-101 (settle rebase), ENG-102 (Phase 4 completion)”), plus
the new adoption artifacts. Read install/archive behaviour, legacy launchers,
account resolvers, UI fixture/prototype sources and dependency manifests. Searched
all tracked text for personal home paths and shorthand, publisher/user names,
pilot/workspace aliases, account/memory profiles, email/host/IP patterns and
credential/private-key-shaped literals. Reviewed hits as runtime code, private
evidence, synthetic fixtures or portable system paths. Examined tracked file modes;
there are no tracked symlinks or submodules at this base.

Also enumerated historical tracked names across all local refs and scanned
2898 reachable unique blobs (about 54 MB) without printing their contents.
The historical inventory includes previously removed raw acceptance logs,
transcripts, ownership receipts, private pilot scripts and older folded-lanes
reports/specs. Its counts are a snapshot of locally reachable refs, not a promise
about future refs. The credential-shaped searches found no key-shaped literals
in either the tracked tree or those reachable blobs.
This is a bounded content audit, not a claim that all Git metadata, private directories
or all possible credential formats are safe. Never copy a secret hit into public
review evidence. Re-run on the exact proposed publication commit and outgoing
history; concurrent work can add new paths.

Corrective inspection at `1816a2f` ("Add adoption independent review round 1")
covered the **749 tracked paths** then present and read the 50 tracked Markdown/
text documents absent from the original current-path TSV. This added the private
`docs/INVENTORY.md`, the production-derived review fixture, the pilot-themed memo,
internal study/approval references in two module/prototype READMEs, and the new
adoption review. The adopter README also needs its private audit links replaced
before publication. The current-path inventory includes those seven paths and this run's
new private report; the historical inventory adds seven paths and updates its
already-listed README recommendation. The original blob scan above is inherited evidence; this
correction does not claim a fresh whole-history secret scan.

The 43 remaining unlisted Markdown/text documents were inspected: the Herdr,
lanes, MCP, promote and settle READMEs; the supervisor protocol and lane brief/
review templates; two generic interruption fixtures; and 33 console prototype
snapshots. These contain supported product behaviour, placeholder examples or
synthetic `harbor`/`orchard` data, not private pilot chronology or real branch/
review receipts. Snapshot provenance was checked against the synthetic sources
`console/proto/fixtures.mjs` and `autonomy.mjs`. Keep them subject to the normal
exact-candidate scan; a generic word such as "operator" is not itself private
history.

## Private material to exclude

| Path (all descendants) | Tracked files | Recommendation before publication |
| --- | ---: | --- |
| `kit/bch-cloak-20261001/` | 29 | Keep the protective private snapshot privately; exclude from public source and archives. It carries personal account/profile/harness settings, absolute home/project paths, workspace IDs, operating instructions and copied scripts. Preserve it here until the existing project's gated switch; replace dependent tests first. |
| `docs/reports/` | 239 | Exclude operational reports and captured acceptance evidence: paths, machine settings, model usage, session/pane IDs, private project history and source receipts are not public product documentation. Publish a separately reviewed synthetic summary if needed. Includes both adoption run reports. |
| `docs/reviews/` | 73 | Exclude historical reviews and operator studies. Even sanitized review projections refer to internal work/history; do not assume a directory named reviews is public-safe. |
| `docs/briefs/` | 43 | Exclude internal dispatch asks, authority/boundary instructions and private operational context. |
| `docs/archive/` | 4 | Keep the archived pilot protocol and launch scripts private. |
| `docs/config/` | 1 | Exclude the operator's harness effort patch; never apply it to adopters. |
| `docs/design/` | 8 | Rewrite generic designs into separate public documents or exclude. Remove private narratives, paths, accounts and evidence links. |
| `docs/reference/` | 10 | Rewrite captured UI examples/source snapshots using synthetic projects; verify provenance and remove private originals from distribution. |

Exclude `.claude/settings.json` from the distribution: it contains this project's
canary SessionStart hook and promotion allowance tied to a private authority note.
Keep `herdr/canary-env.sh` private or explicit development opt-in. The generic
entry policy does not need either.

Historical pilot/spec files outside these directories are also individually
listed: `docs/pilot-M1.md`, `docs/pilot-M1-results-2026-09-16.md`,
`docs/design-M2-supervisor-homes.md` and every `docs/spec-*.md`. Retain private
originals and extract current portable requirements if publication needs them.
Rewrite `docs/north-star.md` and `docs/roadmap.md` for public readers, removing
personal record locations, private evidence links and operator/project history.
**Rewrite or exclude `docs/INVENTORY.md` explicitly.** It reproduces private
pilot/operator-study chronology, internal branch/commit/review receipts and the
reference graph of excluded reports/specifications. Its lack of personal absolute
paths does not make that operational history public product documentation.
Keep the original privately; publish only a separately reviewed portable inventory
if one is needed. Both TSVs list it individually, outside directory exclusions.

## Runtime and fixture changes

| Paths | Required recommendation |
| --- | --- |
| `console/lib/config.mjs` | Replace the personal `.org`, checkout, ledger, Claude-account and Brain executable paths in the classic-console example. Modern mode discovers projects without that config; a fresh classic launch must not write operator-specific data. |
| `brain/lib/digest.mjs`, `brain/lib/start.mjs`, `brain/README.md` | Remove the literal personal `ai` path and mandatory private account-launcher assumptions. Make memory/account integrations explicit optional config and native launch portable. The legacy Brain service is optional, so adoption proof does not establish its portability. |
| `supervisor/continue.sh`, `supervisor/arm-watch.sh`, `supervisor/settle.sh`, `supervisor/SETTLE.md`, `supervisor/KICKOFF.md` | Replace private roots/record/route/authority references with discovery, or keep legacy project helpers out of public packages after the gated compatibility switch. Generic `PROTOCOL.md` and installed supervisor entry are the public replacement. |
| `lanes/test/routes.test.mjs` | Uses the private kit and asserts personal persona/memory-profile launch args. Replace with a complete synthetic route fixture before excluding the kit. Preserve opaque routing/schema coverage. |
| `acceptance/test/cutover.test.mjs` | Also copies the private kit and contains personal path/workspace assumptions. Replace its input with synthetic legacy files before kit removal. |
| `acceptance/run.mjs`, `acceptance/cutover.mjs`, `acceptance/security.mjs`, `acceptance/test/results.test.mjs`, `acceptance/test/security.test.mjs` | Public acceptance must be independently reproducible; it currently models a specific private pilot migration (the full gate reads a supplied live project, not the inventory kit). Generalize relocation/layout premises and use a synthetic legacy fixture. Preserve forbidden-root checks and safety classification. |
| `brain/test/fixtures/codex-final.txt`, `brain/test/fixtures/codex-typed-composer.txt`, `console/test/model.test.mjs` | Replace captured personal paths/identity text with synthetic screenshots/transcripts while preserving parser layout and terminal behaviour. |
| `lanes/test/fixtures/board-cli-pass-review.md` | Replace the sanitized production-derived review with a wholly synthetic full-schema fixture. It still carries real internal commit/review receipts and historical measurements; preserve multi-finding and execution/witness projection coverage. |
| `console/test/fixtures/memo.md` | Replace the pilot-themed theft/O1 decision wording alongside its matching console model fixture with a generic synthetic decision memo, preserving document parsing coverage. |
| `console/proto/README.md`, `discovery/README.md` | Remove private study/evidence links, work-item/approval history and internal review-round narratives; keep synthetic prototype usage, supported validation commands and explicit experimental limits. |
| `README.md` | Replace links to the private publication audit with reviewed public installation/distribution information when the candidate is approved. Keep the portable adopter introduction. |
| Remaining matching code/tests/docs in the TSV | Replace pilot names, personal aliases or unapproved namespace literals with synthetic examples or the approved identity. Source line references identify each file's hits. Keep the behaviour and safety assertions. |

`contrib/settle-watch.mjs` is a compatibility surface. Its remaining pilot-specific
comment is listed for eventual rewrite; do not remove, relocate or change its
flags/behaviour before the existing project's release-gated switch. Audit advice
is not authorization to disrupt that live caller.

## Distribution identity, licensing and archive contents

- `herdr-plugin.toml` uses a personal publisher namespace and a manifest version
  different from root/console package versions. The operator must approve the
  publication identity and release version. Coordinate all manifest action IDs,
  `herdr/release.sh`, `brain/lib/service.mjs`, acceptance probes/tests and guide
  commands. Preserve installed plugin/LaunchAgent receipts and rollback migration
  if any identity changes. The TSV lists every current namespace hit.
- There is **no root LICENSE**. `lanes/LICENSE` contains an MIT notice for folded
  lanes code; retain its attribution and verify provenance. It does not establish
  a license for the entire repository. The operator chooses the root license and
  distribution terms; do not erase a legal copyright name as a privacy redaction.
  Inspect copied kit/reference code provenance and dependency license/notice
  obligations before distribution. No licensing change is made here.
- Root, console and MCP `package.json` are `private: true`; retain that until an
  intentional packaging decision. Choose the public distribution mechanism,
  manifest/release version policy and owned repository/marketplace URL, then
  update the guide. No marketplace or public URL is asserted today.
- `herdr/release.sh build` uses `git archive TAG` with **no export exclusions**:
  it ships all tracked kit/docs/harness configuration. Add and test an explicit
  distribution allowlist or reviewed export exclusions before a distributable
  build. The entry snapshot's runtime allowlist does not sanitize the full plugin
  or release archive. Inspect the extracted archive as well as source.
- `docs/PUBLISHING-AUDIT.md`, `docs/adoption/publication-files.tsv`, `docs/adoption/publication-history.tsv`, the walkthrough's
  local evidence pointers and the run report are private audit evidence too.
  Retain the portable guide/rehearsal; remove local evidence and internal
  inventories from the eventual public package.

## Other paths and outgoing history

| Path/state | Recommendation |
| --- | --- |
| `.git/` objects, reachable history, refs/tags, author/committer metadata and commit messages | A clean final tree is insufficient: earlier private kit/docs/paths remain reachable. Inspect every ref planned for push and the entire outgoing history for content and identifying metadata. Prefer a reviewed public export with deliberate history; any rewriting/deletion remains an operator decision. Do not publish existing private tags blindly. |
| Git remotes and config, `.git/worktrees/`, logs and local `info/exclude` | Never bundle Git internals, private URLs, worktree/account paths or local excludes as product files. Review the actual push destination separately. |
| `.org/`, `.lane/`, `.agents/`, `.codex/`, `.aws/`, `.env*`, authentication files, transcript/ledger/session registries | Keep private; these are runtime/account locations rather than publication inputs. Do not inspect or export unrelated account contents. `.org/` and `.lane/` are currently ignored; verify they remain absent from archives, including newly tracked exceptions. |
| `node_modules/`, `.DS_Store`, scratch roots, generated binaries/logs, machine installation receipts, releases/current/previous/before and entry runtimes | Omit from source publication. Build dependencies from lockfiles inside a clean distribution; never upload a machine install/state directory as a package. |
| Console/MCP lockfiles and ordinary public dependency URLs | Retain pinned versions and integrity fields after dependency/provenance review; public registry URLs are not personal data. |
| Synthetic test emails and `/Users/me`, system paths `/usr`, `/opt/homebrew`, `/private/tmp`, denied `/Users`/`/home` roots, loopback probes | Retain intentional portable/platform-specific fixtures and confinement paths. Do not perform blind path replacement that weakens sandbox or sanitization coverage. Real account/machine aliases in fixtures must be synthetic instead. |

No binary data, submodule or symlink bypass was found among the tracked paths.
The exact publication candidate still needs an outgoing-history secret/privacy
scan and operator approval after the remediation above. This lane leaves all
listed existing files unchanged, except the separately requested adopter README.
