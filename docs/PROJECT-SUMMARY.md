# Owner-published project summary

From the canonical project checkout, `record summary publish` writes the owner's
model-free projection to `ORG/published/summary.json` and `summary.md`.
`--json` prints the same JSON; the default prints its short Markdown rendering.
Publication never appends record events, calls a model, starts a schedule, grants
read access, or creates an endpoint or socket. Linked worktrees cannot publish.
The operator chat's later identity and read enforcement remain separate decisions.

The JSON schema is `project-summary/v1`. Its explicit field allowlist is:

- `project`: a hash of canonical Git common-directory identity and a display name,
  with no filesystem path. Projects sharing a record cannot overwrite another
  project's published summary; use one owning record per publisher.
- `generated_at`, `stale_after_seconds`: observation time and refresh allowance.
- `status.counts`: counts of the existing derived item statuses.
- `today`: local calendar date and UTC bounds (the same day definition as
  `record today`), landings and decisions, with item/run ids, times and one-line
  summaries. Landings require a promoted queue result belonging to this record;
  a finished engineering report alone is not a landing. Decisions use only their
  explicit plain summary; answered questions use their title. Missing summaries
  are named, never replaced by raw note text or answers.
- `lanes`: the six counts from `lib/retire-status.mjs`, including tab and pane
  rows, plus up to ten oldest unresolved rows (tabs, worktrees, promotions or
  diagnostics). The oldest list coalesces tab/pane duplicates and publishes only
  class, ids, owner, start time and age in seconds. For a recorded run, age is
  elapsed time since the earliest run start on that row; promotion-only rows use
  queue time. Unknown owners/ages remain null with named exceptions. WAITING and
  IDLE-NONTERMINAL use the projection's next actor when known. This is display
  data and supplies no lifecycle authority.
  Promotion rows use the same validated Brain source as the lanes view, including
  pending phases, train/attempt/gate facts and the recent-results window. Summary
  worktree inventory skips untracked and ignored file enumeration.
- `releases.current`, `releases.pinned`: release ids only. Main had no per-project
  pin helper when this was implemented. `readProjectReleaseIds` is the single
  ENG-386 integration seam. Until that helper lands, current means the unpinned
  installed `current` link, using the same input and home override as
  `herdr/release.sh status`; pinned is null with `release-pin-unavailable`.
  Missing/unrecognised current links stay null, never a candidate or guessed tag.
- `exceptions`: sorted, fixed names for missing summaries, partial record tails,
  unknown/unavailable lanes or worktrees, unknown owner/age, a retirement hold,
  unreadable promotion queue, and unavailable release ids/status.

Sources are the owner's event fold, its promotion queue and canonical checkout,
the shared retirement status projection's existing Git/Herdr facts, housekeeping
configuration, and release-status link metadata. No adapter scripts or logs are
executed or read to publish the summary. Source errors become fixed exception
names; their raw messages are excluded. Note bodies, question answers, report
bodies, prompts, transcripts, arbitrary metadata, file contents and source paths
are excluded. Editorial titles, report headlines and explicit decision summaries
are flattened and bounded; common credential markers and paths/URLs are redacted
as additional protection. These editorial fields should always be plain summaries.

`published` is a publisher-owned relative symlink to a content-addressed generation
under `ORG/.published-summaries`. The summary and cycle-time publishers share
`lib/project-publication.mjs`: each replaces its own pair and carries the other's
latest pair forward under the same lock. All files are complete before one atomic
rename switches the link. Identical source facts, observation time and timezone produce
identical bytes. The current and prior generations are retained; older generated
files are removed on a successful refresh. Existing ordinary `published`
directories, foreign generation links and a different publisher identity are
refused. A `.summary-publish.lock` directory serializes writers; a crash leaves
the lock for owner inspection instead of silently replacing an uncertain writer.

Housekeeping refreshes on its existing canonical live cleanup pass, without a new
daemon or schedule. Publication follows cleanup and recovery and reuses that pass's
retirement observation; recovery-only ticks, previews and workspace-scoped checks
never publish. Publication failure is logged and cleanup/recovery continue.
The stale allowance is the larger of five minutes or three configured cleanup
intervals. A stopped/failed publisher leaves the last observation on disk.

`record summary` (or `--json`) reads only the published JSON and reports `fresh`,
`stale`, `missing` or `invalid`, including elapsed age and the stale allowance.
Supervisor status also reports these freshness facts. Missing/invalid observations
have null age; file modification time never substitutes for observation time.
Readers must check freshness when using the files, and can pin the resolved
generation directory if they need to open both formats from exactly one refresh.
