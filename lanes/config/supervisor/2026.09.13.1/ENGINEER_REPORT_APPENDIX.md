## Report to the supervisor

Supervisor Herdr agent name: `<exact-supervisor-agent-name>`

After a material checkpoint, blockage, or completed gate, first preserve the
available evidence at the project's declared durable destination, or record
the exact unresolved archive blocker. Then send one concise
notification to the named supervisor with `herdr agent prompt` and no `--wait`.
Use the exact supervisor name as the command target and the following five-line
report as its text, replacing every placeholder with observed facts:

```text
LANE REPORT <CHECKPOINT|BLOCKED|READY_FOR_REVIEW>
repo=<canonical-git-common-dir> topic=<topic> agent=<engineer-name>
branch=lane/<topic> head=<full-commit-sha>
gate=<exact-gate-result-or-unverified> report=<path-or-unverified>
next=<one-specific-decision-or-evidence-needed>
```

The notification is a pointer to evidence, not approval to promote, publish,
or perform a financial action. Do not include secrets, transcript dumps, or
long logs. Do not send heartbeat messages. If the supervisor is unavailable or
blocked and Herdr refuses delivery, do not loop or retry. Keep the durable
report and state the undelivered notification in your final lane message.
Independent reviewers must follow the read-only review template instead of
sending this notification.

For the final READY_FOR_REVIEW handoff, finish the authorized commits and run
`lane check` against the final HEAD before reporting. Then stop changing the
lane until the supervisor requests corrections. Do not close your own session
tab, remove the worktree, or promote the lane. The supervisor verifies review
and validation, preserves the evidence, promotes, and retires the lane and its
sessions after acceptance. A sent notification alone is not acceptance.
