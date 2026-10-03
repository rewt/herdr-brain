# ARCH-17 scratch transcripts (R-151, 2026-10-03)

All runs used the session scratchpad. Nothing on the machine was changed. The live record was only
copied (no lock taken; a torn tail would have been tolerated).

## e1: neighbour leak through parent files

Layout: `dev/root/{.org (record init + one item), .lane.json (engineer route "secret-model-A",
args -p projA-memory), projA, projB, a/app, b/app}`; every child is its own Git repository.

```
--- record seen from projB (no record of its own):
…/e1/dev/root/.org · 1 events · 2026-10-03 11:17
--- lane config seen from projB:
routes.engineer  {"kind":"codex","model":"secret-model-A","args":["-p","projA-memory"],"use":"projA only"}  …/dev/root/.lane.json
worktree_root    "…/dev/root/.worktrees/projB"  …/dev/root/.lane.json
--- worktree roots for a/app and b/app:
"/dev/root/.worktrees/app"
"/dev/root/.worktrees/app"
--- lane open t1 in a/app, then in b/app (HERDR_SOCKET_PATH pointed at nothing):
a/app: base: 0ec00e3 (main); herdr workspace: none (herdr unavailable)
b/app: lane: worktree path belongs to another repository: /dev/root/.worktrees/app/lane-t1; choose distinct worktree bases
```

## e4: Unix socket path length (macOS, Node v20.19.4)

```
100 bound; file at path: true ; connect: ok
103 bound; file at path: true ; connect: ok
104 bound; file at path: true ; connect: ok
105 bound; file at path: false ; connect: ok      <- silently truncated
150 bind error EADDRINUSE                         <- misleading code
157 python: AF_UNIX path too long
34  bound via a short symlink to a 150+ character directory; connect ok
```

Today's validation temp prefix (`…/lane-workspace/.lane/validation-tmp/`) is 88 characters;
macOS `TMPDIR` is 49.

## e5: herdr-brain record move rehearsal (copy of rewt/.org, 1,750 events, 19 MB)

```
== before (record at rewt/.org)
snapshot: 22664 chars; coach (sibling repo, no record) resolves /rewt/.org
events.jsonl sha256 b7d05ab571180ad9…
== after mv to home/.herdr-monitor/projects/herdr-brain/record + symlink at rewt/.org
snapshot identical; coach still resolves /rewt/.org through the symlink (leak persists)
== after move, ORG_DIR at the new location
snapshot identical after normalizing the record path (only the printed CLI line differs)
== rollback (rm symlink, mv back)
events.jsonl sha256 b7d05ab571180ad9…
```

Location-bound facts in the live record: 435 event lines embed `/Users/rewt/development/rewt/.org`
(575 occurrences); `watch/watch.mjs:288` and `contrib/settle-watch.mjs:218` hash
`path.resolve(org)` (not the real path) into their lock names under `os.tmpdir()`.

## e6: git clean and the default in-checkout record

```
$ echo .org/ >> .git/info/exclude; git clean -fdx -n
Would remove .org/
```

## Prototype

`workspace.mjs` (resolver, areas, short temp, stricter-wins merge, counted leases), `demo.mjs`
(run against this machine's real checkouts with read-only Git queries), `temp.mjs` (path budgets);
output in `demo-output.txt`; the example file in `workspace.example.json`.

The prototype's example file still lists directory roots and an `identity` field so that both
options could be exercised; the design recommends no directory roots (Q2) and stores the checkout.
