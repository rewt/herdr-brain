# Design: Make lane paths and Herdr labels repository-safe

## Decisions

Canonical repository identity is the real absolute git common-directory path;
do not assume it is always `<checkout>/.git` or derive it from a remote URL. Resolve
the canonical non-linked checkout through git worktree metadata. Bare repositories
or a missing canonical checkout fail clearly for lane mutations.

A root is the directory of the nearest inherited configuration, or the canonical
repository's parent when none exists. Its real path is the root identity. Human
labels use its basename; duplicate labels add the first eight hex characters of a
SHA-256 digest of the full root identity. Repo IDs use the full canonical identity,
not a truncated hash; any displayed digest collision is detected and lengthened.
No identity, account, SSH alias, or git author is set by lane.

The configured per-root layout remains `<root>/.worktrees/<repo>/lane-<topic>`.
Different roots naturally separate same-named repos. If an operator deliberately
points two roots to one shared base, refuse an already occupied foreign destination
and explain the remedy (distinct bases). Never silently relocate an existing lane.
Preserve the legacy default and explicit environment override from roots-config;
collision refusal is safe behavior for those shared locations.

Resolve existing ancestors with realpath before creation and re-check ownership
after Herdr/git returns. Reject paths in or equal to the canonical checkout, a
registered checkout, or another repository, and symlinks that escape the selected
base. New paths never fall back to a temporary directory; the intended root profile
uses sibling .worktrees. Existing git-registered lanes at older paths remain usable.
Test repositories remain under the system temp directory as AGENTS requires; the
test fixture represents a development root, not a production temp fallback.

Use `<root-label>/<repo-name>:lane-<topic>` for new child workspace labels and opaque
IDs for controls. The parent must be the canonical non-linked repository workspace.
Bound each new workspace label to 64 Unicode code points. If it is too long or
collides, reserve an eight-hex-character suffix from the full root/repository/topic
identity and use root/repo/topic fragments of at most 12/16/20 code points:
`<root-fragment>/<repo-fragment>:lane-<topic-fragment>~<digest8>` fits the bound.
Truncate only at grapheme boundaries, counting an ellipsis inside each fragment's
budget. If suffixes collide, lengthen the digest and shrink the fragments to keep
the same overall bound. Preserve the full labels/identities in CLI details; label
truncation never changes a topic, path, or control target.
Keep existing labels. Agent names remain valid Herdr names (lowercase initial
letter, allowed characters, max 32) and unique across live agents; use a sanitized,
bounded stem plus identity and random suffix rather than only topic/time.

## Risk and verification

Exercise long/Unicode/spaced root and repo names, same-named roots at different
paths, duplicate repo basenames, symlink escapes, stale Herdr metadata, and git
separate-common-dir fixtures. A path mismatch never prompts or removes anything.
No Herdr server remains a supported git-only open/status/promote/close path.
