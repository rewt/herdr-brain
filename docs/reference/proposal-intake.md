# Proposal notes and explicit selection

Ordinary report proposals are durable records, with `meta.queue_selected=false`
written at creation. Producer-supplied selection and `dispatch_after` never admit
them. New views derive `proposed` or `lapsed`; selecting the item separately with
`record set ID meta.queue_selected=true` uses the ENG668 seam. Parent selection
does not select descendants. Selection still respects dependencies, holds,
reserved subjects, native ownership and original dispatch attempts.

Every source has `report-proposal/v1:R-n:INDEX` (zero based), the immutable report
hash and the complete normalized proposal payload. More than three ordinary,
nonblocking follow-ups share one architect reshape note. Every source index,
evidence field and finding reference remains in `meta.proposal_sources` and
`proposal.recorded` events. Blocking, reserved, reviewer and Major proposals stay
separate. Formal review engineer proposals use the existing immutable finding
helper and cap1 correction path. Newly allocated formal corrections carry
selection as existing review obligations; intake never lapses or groups them.

Supervisors re-file an exact report proposal with:

```
record proposals file R-n --index N
```

This reads and verifies the stored immutable report, then uses the same helper
inside the final record transaction. A lost acknowledgement or concurrent filing
reuses the original record, including a renamed, active, UNKNOWN or closed owner.
It does not reopen or replace an attempt. Pre-key intake can be recovered from
the full original creation, source run and occurrence in the immutable report;
current titles, parent closure, age and hashes in prose are never duplicate keys.
Conflicting ownership stops allocation. An untyped `record add` remains a new
independent work item; it cannot infer source identity from prose.

No timer lapses notes. Only the actual native project supervisor, resolved from
the owning canonical promotion policy, can explicitly run these dispositions:

```
record proposals token ID
record proposals lapse ID --cut selection --expect TOKEN --why 'Bounded cut reason'
record proposals duplicate ID --into CANONICAL --key SOURCE_KEY --expect TOKEN --successor-expect TOKEN --why 'Typed duplicate'
```

`--cut release` is also supported. Lapse keeps the note and history open and
visible; separate selection revives it. Lapse refuses selected, ever-started,
committed, saved/UNKNOWN, held, reserved, Major, child-bearing and linked work.
The disposition checks current proposal/dependency tokens, native supervisor,
record/project binding, STOP/HOLD and the existing promotion write guard. Duplicate
drop is limited to unattempted nonreserved work with a shared typed key. It adds
all replacement dependency links before removing originals and dropping the
duplicate in the same version-checked transaction. A cycle or changed token stops
the effect. No source cleanup or broad historical reconciliation runs here.

`record proposals metrics` reports UTC creation-date cohorts: work items filed,
items with at least one observed `run.started`, and their share, separately for
report-origin items. It names the event cutoff; today's share is censored by that
cutoff and does not predict how many will ever run later.

The adoption boundary is intake code, then the existing selected installed
consumer's normal adoption. Old folds ignore `proposal.recorded` and understand
the existing conservative selection metadata. No new metadata is required from
saved/legacy selected work, and no historical events are rewritten. Source
landing does not prove a pinned intake/watcher or service loaded this version.
This change updates no pins, saved jobs, services or other project identities.
