# Design: Resolve development-root configuration

## Context and decisions

The supplied roots brief is this first task. Its config hierarchy, route-name merge,
source display, docs, offline matrix, foreign-path refusal, and report are retained.
Two clarifications follow from current code:

1. **Compatibility correction:** `LANE_WORKTREE_ROOT` currently is the final
   per-repository container; it does not get a repository suffix. Preserve that
   behavior. The new `worktree_root` key is a shared base and gets `/<repo-name>`.
   The supplied brief's word "unchanged" takes precedence over interpreting its
   generic path formula as an environment-variable migration.
2. Resolve root configuration from the canonical checkout identified through git's
   common directory, even when invoked in a linked lane. This prevents sibling
   worktree ancestry from selecting a different root or ignored config disappearing.
   The repository file for operational settings is the canonical checkout's
   `.lane.json`; a lane-local copy is not a third config layer. This is an intentional
   documented behavior change in this lane, requiring no contract amendment, and
   needs regression coverage. Check and promote use the same resolver and preserve
   validation parity. A1 is applied in roots-identity (1b) and retroactively
   describes the path placement delivered here.

Use only the **nearest** parent file, not an arbitrary-depth merge. For repositories
under home, exclude home and every ancestor above it. Elsewhere stop before the
filesystem root; if the canonical checkout is home, do not search its parents.
No configuration is inherited across that boundary.

Merge top-level keys shallowly; the only exception is routes, merged by route name
with a whole repository route replacing a same-named parent route. Thus a repository
dispatch object replaces the parent dispatch object entirely, and prepare/env/args
arrays replace rather than concatenate across files. Existing dispatch-to-route-to-
CLI environment concatenation happens afterward and stays unchanged.

Only `worktree_root` gets defining-file-relative resolution in this slice.
Existing registry and seams_doc paths stay canonical-repository-relative;
prepare.unless remains relative to the worktree being prepared. Relative
LANE_CONFIG and LANE_WORKTREE_ROOT keep caller-cwd resolution. Do not interpolate
shell variables or execute configuration while inspecting it.

## Resolved path matrix

| Winning setting | Final lane path |
| --- | --- |
| LANE_WORKTREE_ROOT | `<env-directory>/lane-<topic>` (legacy exact meaning) |
| Repository worktree_root | `<resolved-base>/<repo-name>/lane-<topic>` |
| Nearest parent worktree_root | `<resolved-base>/<repo-name>/lane-<topic>` |
| Parent file present, key absent | `<parent-directory>/.worktrees/<repo-name>/lane-<topic>` |
| No parent and no key | `<home>/.herdr/worktrees/<repo-name>/lane-<topic>` |

LANE_CONFIG loads exactly its chosen file; the presence of its directory does not
count as parent discovery. With no worktree_root in that file, use the legacy default.

## Risk and verification

Fail clearly on malformed, unreadable, or wrongly typed selected config instead of
silently launching with unrelated defaults; missing optional files are allowed.
Explicit LANE_CONFIG missing is an error. No validation/setup/Herdr calls occur in
lane config. Document this stricter error handling as a compatibility change.
No migration, git identity edits, UI refactor, or machine configuration is included.
The broader realpath and workspace-label rules land in the next independent lane.
