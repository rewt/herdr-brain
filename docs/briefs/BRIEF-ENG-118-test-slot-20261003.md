# ENG-118: host test slot, for any project

bch-cloak built a host-wide test slot (ENG-725): `scripts/test-slot/test-slot.mjs`, `lock-support.mjs` and
`test-slot.test.mjs` in /Users/rewt/development/bastian/bch-cloak (read it; never write that checkout). One lock per
machine; liveness by pid and start time, never command-line patterns; the holder runs its command in its own
process group; nested commands inside a held slot run inside it; refusal exits 75 with one coded line; an optional
wait queues instead. Its WORK-PATTERN adds: a timeout under load is re-run alone once before it counts as a failure,
and exit 75 is a slot refusal, not a test failure.

Port the idea as a Herdr Monitor module any project gets. Promotion-tier validation and the release gate take the
slot, so heavy suites from different lanes and projects never run at once on one machine. While bch-cloak's own lock
(/private/tmp/bch-cloak-test-slot.lock) is held, a run here waits or is refused, never runs alongside. Keep the slot's
location a workspace concern (ARCH-17 will move machine-wide locks into the workspace), so make the path configurable.
The core stays dependency-free.

Run npm run test:fast plus the suites you touch; never the live harness. Commit, write the report, record check it,
commit it, run lane check last. Then stop.
