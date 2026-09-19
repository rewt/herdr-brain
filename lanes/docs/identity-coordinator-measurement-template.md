# Identity coordinator pilot measurement template

Copy to a project-approved private location; do not fill this tracked template with
real identities, paths, usage records, transcripts or credentials. One row is one
candidate milestone; mark it accepted only after the named integration owner checks
project acceptance evidence. Rejected/reworked attempts stay linked and their costs
remain in the eventual accepted milestone's totals if one exists. Mark unavailable
usage `unknown`; compute per-accepted-milestone comparisons only from verified rows.

## Selection and precommitted limits

Date/timezone: `<...>`  Identity label: `<private>`  Protocol review: `<pointer>`

| Project | Canonical common dir (private) | Outcome IDs (1-2) | Integration owner | Project supervisor? | Baseline source | Acceptance/evidence source |
| --- | --- | --- | --- | --- | --- | --- |
| A | `<verified>` | `<...>` | `<acknowledged>` | `<yes/no>` | `<...>` | `<...>` |
| B | `<verified>` | `<...>` | `<acknowledged>` | `<yes/no>` | `<...>` | `<...>` |

Per-milestone hard caps: total input `<...>`; output `<...>`; model turns `<...>`;
elapsed `<...>`; operator interventions `<...>`; coordinator/supervisor overhead
`<...>`; stop decision time `<...>`. No blank cap is unlimited. Active engineering
limit: two milestones per project. Dependency/unblock evidence: `<...>`.

## Milestone accounting

| Arm/project/outcome/milestone | Accepted? and evidence SHA/pointer | Work class/complexity | Model/effort by role | Input total | Cached input | Uncached input | Output | Turns | Repeated reads | Operator interventions | Elapsed start→accept | Coordination input/output/turns/time | Review/rework and confounders |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| project-only/A/`<...>` | `<yes/no; pointer>` | `<...>` | `<...>` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | `<...>` |
| coordinated/A/`<...>` | `<yes/no; pointer>` | `<...>` | `<...>` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | `<...>` |
| project-only/B/`<...>` | `<yes/no; pointer>` | `<...>` | `<...>` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | `<...>` |
| coordinated/B/`<...>` | `<yes/no; pointer>` | `<...>` | `<...>` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | `<...>` |

For every numeric cell, record the source/export and coverage below. Cached input
is a subset of total input; never add it again to total. Compute uncached only from
known total and cached values. Turns are model responses, not tool calls or Herdr
pane transitions. Elapsed includes waits and review until accepted. Count
interventions as operator decisions, corrections or manual checks beyond planned
acceptance, noting each trigger. Count repeated reads only at an unchanged artifact
revision. Coordination overhead includes coordinator and any project-supervisor
work, on both baseline and coordinated arms when present.

## Evidence and decision log

| Event | Assignment/revision/report ID | Time | Evidence source and coverage | Decision/owner | Next action |
| --- | --- | --- | --- | --- | --- |
| `<baseline selected>` | `<...>` | `<...>` | `<...>` | `<...>` | `<...>` |

Usage source/coverage by role and missing fields: `<...>`

Workload, model/effort, cached-input, concurrency and reviewer confounders: `<...>`

Per-accepted-milestone comparison and coordination overhead: `<calculate only from observed rows>`

Cap/stop events and operator continue/revise/stop decision: `<...>`

No pricing or savings claim unless separately verified; missing usage remains
unknown rather than zero. Retain primary gate, review and closeout evidence at the
project's declared durable destination before any lane cleanup.
