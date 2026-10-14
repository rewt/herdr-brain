**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ee0b9c6419d36ebb0320ad3121267b58ed385f5b
Topic: verify-queue
Round: 1
Review ID: lr-4d45399e95b61b37b32647099748cf35
Base branch: main
Base commit: fa25bbaa244f38b0ca723c39bdc0021b3c2cf751

## Findings
- [Moderate] verify/verify.mjs:151 - Admission still binds whatever the untrusted inbox holds at the instant admit runs, not the specification the supervisor inspected: admit takes bare job IDs and copies the current inbox row (line 176 Object.assign overwrites an existing trusted row), while status at line 434 shows the stale trusted row for any job already in the trusted store, so after runnerError or recover returns a job to pending-admission a submitter can rewrite its argv, prepare, desk, org, submitter, to or herdr in the inbox at leisure, status keeps displaying the old trusted spec, and the next admit silently runs the edited spec with the supervisor's permissions (for never-admitted jobs the same substitution is a race between status and admit), and admit prints only the IDs so the substitution is not visible before the detached worker starts; Fix: have status report, for every job not currently admitted, the inbox spec and its jobDigest rather than the stale trusted row, make admit accept JOB=SPEC\_SHA256 (or a required digest option) and refuse any job whose current inbox digest differs, print the admitted ID-to-digest map, and add a fixture that resets a job to pending, edits its inbox argv and proves admit with the previously displayed digest refuses.
- [Moderate] verify/verify.mjs:123 - An absolute desk is accepted at any location, including system temp, the repository, a lane worktree or a configured untrusted root, even though the same root set is treated as submitter-writable for the trusted store; the runner creates the worktree there with the supervisor's permissions, checks the tree before the slot wait, and then the command, file and JSON expectations read desk files a submitter can rewrite between the tree check and execution, so the receipt can attest pass at the exact SHA and tree for code and artifacts that were not that commit (the existing absolute-desk fixture at verify/test/verify.test.mjs line 524 places the desk under system temp); Fix: in submit, admit and deskFor refuse any desk that resolves inside the checkStore untrusted root set (repository, Git common directory, registered worktrees, record, system temp and configured untrusted roots) or restrict desks to the trusted store's desks directory, document that desks need the same isolation as the store, and add a fixture proving an absolute desk under system temp or the repository is refused.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: verify/test/verify.test.mjs
- Test evidence not re-executed: test/tier-plan.test.mjs
- Test evidence not re-executed: test/suite.test.mjs
- Report record-check validation not independently executed.
- Whether the default trusted store under the user state directory is actually unwritable from bch-cloak and lane worker sandboxes was not checked; the module cannot inspect native sandbox policy and the report states no adopter sandbox was probed, so the forged-receipt defences depend on the documented adoption probe being run.
- Runtime behaviour of the forged-receipt, inbox-edit, probe-store and recovery fixtures was reviewed from code only; no fixture was executed under the zero-command budget.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
