# Bootstrap completion and ordinary upgrades

The supervisor completes a development-bootstrap trial only after its installed
exact candidate has independently qualified for ordinary READY acceptance and
the explicit project pin selects that root. The installed runtime must include
the completion reader; execute this command from that exact installed root.
Completing an older bundle with a newer canonical tool is refused.

Stop the service through its existing owner first and retain its own STOP.
Preview, then apply that exact plan:

```sh
"$NODE" "$INSTALLED_ROOT/line-service/launchd.mjs" probation-complete --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --id "$TRIAL_ID" --dry-run
"$NODE" "$INSTALLED_ROOT/line-service/launchd.mjs" probation-complete --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --id "$TRIAL_ID" --expected-plan SHA256
```

Native supervisor identity, trial ownership, clean canonical main, project
STOP/HOLD, service STOP, positively stopped native service and the existing
control/pass/promotion locks remain enforced. Preview does not convert the
installation. A completed exact-plan retry reads the existing anchor.
The existing completion invocation without `--expected-plan` remains supported;
it captures and validates the same immutable plan under the locks. Supplying a
plan always enforces its exact hash, including on a completed retry.

The immutable `probation-completions/TRIAL_ID.json` records the exact bootstrap
installation/plist, original authority and cutover, final trial-history sequence,
normal accepted tuple and converted installation. One transaction records a
typed `line-service.runtime-migrated` anchor (`mode: probation-completion`) and
the original trial's completion referencing that anchor. Installation now carries
the ordinary `migration` reference; bootstrap/successor fields remain in the
archive. Original recovery, authority, switch/successor/fence archives, cutover,
jobs, claims and saved watcher/callback roots are retained. No READY evidence or
pin is manufactured, and no native service is started.

Runtime history verifies the original trial chain through the anchor, then
follows ordinary upgrades, login registrations and recipient changes. Ordinary
upgrade still requires the exact accepted target pin and its compatible reader.
The existing upgrade preview/apply and `upgrade --rollback` restore the previous
ordinary installation/plist, including this anchor. They do not restore the
ended trial exception. A missing, changed or partial completion archive is
UNKNOWN: retain the original intent and route it to the supervisor, without
replaying completion or replacing its ID.

After this conversion resolves the frozen recovery obligation, the supervisor
owns the separately required stopped-service `register-login` preview/exact-plan
operation, followed by supported restart. Its next release/soak must retain a
real completion, upgrade preview/apply to the next accepted release, rollback
return and ordinary-pass witness. Producer fixture checks are offline evidence;
they do not supply those live witnesses. Candidate successor-profile review,
release qualification and activation remain with their existing owners.
