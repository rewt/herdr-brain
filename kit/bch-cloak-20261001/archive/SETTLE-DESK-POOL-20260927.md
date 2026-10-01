# Settle desk (pool era): routine settlement of one lane report, on Codex

Operator, 2026-09-27: routine settlement moves to the Codex `settle` route to save the supervisor's Claude budget.
The supervisor keeps verdicts that need judgment, promotions, revision-cap decisions and operator questions.

You settle **exactly one** run, named in your prompt as `RUN`, `REPORT`, `KIND` (engineer | review) and `LANE`. You
**never** dispatch, promote, call herdr, push, or edit `tasks.md`, `openspec/`, or anything outside `archive/` and
`.org/`. Your run happens in the main checkout, read-only except for `org` and your own output files.

```sh
export ORG_DIR=/Users/rewt/development/bastian/.org
```

## Steps

1. **Read the report.** Read `REPORT` in full, not the watcher line: watcher lines say `verdict=n/a` even on a FAIL.
   Read the brief it answers (`org brief RUN`).
2. **Assert git truth yourself.**
   - The lane worktree's HEAD and a clean tree.
   - The commit range against the brief's base.
   - That the files changed match the brief's scope. List any file outside scope.
3. **Check the evidence.** Run `shasum -a 256 -c SHA256SUMS` in the evidence directory. Any mismatch is a finding.
4. **Re-run one load-bearing check yourself, in your own settle-desk worktree.** Never write into another lane's
   worktree.
   - Run `git checkout --detach <lane HEAD>` in your worktree (`git fetch` is not needed; all worktrees share one
     repository).
   - Rebuild `dist` there, for example `pnpm install --ignore-scripts --prefer-offline --filter "<pkg>..."` and then
     the package build.
   - Run the report's named suite with vitest `--maxWorkers=2 --minWorkers=1`, one suite at a time.
   - When you are done, run `git checkout lane/settle-desk` so that your worktree is back on its lane branch. Never
     leave it detached: lane dispatch finds the worktree by its branch.
   - For a review report, re-run one of the reviewer's executed witnesses instead, if it can run locally.
   - Record the command and its raw exit.
5. **Check two claims.** Pick two load-bearing claims from the report and check each against the code or the evidence
   by opening the cited line. Record *verified*, *contradicted* or *could not check*.
6. **Do not write to org yourself.** Codex auto-approval refuses it. Instead, list the exact `org` commands (the
   ingest, reopen and block commands) in your yaml block under `org_commands`. The supervisor runs them. The commands
   are: `org ingest REPORT --run RUN`.
   - If an engineer item auto-closed, `org reopen <item> --note "Awaiting review"`.
   - Gate any new proposals behind the review with `org block <new> --by <review item>` when they depend on it.
7. **Engineer report: draft the review brief inside your own report.** Codex auto-approval refuses other file
   writes. Put the brief under a `## Draft brief` heading as one fenced ```markdown block; the supervisor writes it
   out. Model it on
   `archive/BRIEF-REV-240-WALLET-SIGNING-POST-ESCALATION-REVIEW-20260927.md`.
   - Give the exact range and HEAD.
   - List adversarial checks drawn from the report's own limits and the engineer's stated residuals.
   - Require firing controls to be re-run, and require a PASS, NEEDS-WORK or FAIL verdict.
   - Put the review item's `org add … --role reviewer --parent <item> --priority 1` in `org_commands`, and use the
     placeholder `ITEM-NEW` in your dispatch command. The supervisor substitutes the id it gets back.
   - Use `R-RUN` as the run placeholder. The supervisor's dispatch helper
     (`/Users/rewt/development/bastian/bch-cloak/.lane/supervisor/dispatch.sh ITEM LANE ROUTE HARNESS MODEL EFFORT
     BRIEF REPORT [BASE]`) fills it. A review lane's BASE is the engineer lane branch (`lane/<topic>`). Pick a review
     topic whose `archive/lane/<topic>` tag does not exist.
   - Route: `review-critical` (Codex Sol at xhigh) by default. Use `review-critical-astra` only for the **first**
     review of a custody or cryptography slice built on `engineer-astra`.
8. **Review report: classify the verdict.** State PASS, NEEDS-WORK or FAIL, quoting the report's own words.
   - Count the fix rounds so far on this item chain from org history: 2 fix rounds, then 1 escalation, then park.
   - For NEEDS-WORK or FAIL, draft the fix brief the same way, and do not dispatch it.
   - For PASS, list what promotion needs: the lane, the tasks.md note text as prose, and a narrow `LANE_VALIDATE` if
     the change is docs-only.

## Output: REQUIRED

Your report is an ordinary org report at the path your prompt names, with the standard front matter (`run:`,
`outcome: done`, `summary`, `headline`, `blockers`, `proposals: []`, `learnings`, `artifacts`). It must pass
`org check`, which is how the supervisor is notified.
- **Headline.** One plain sentence: what you settled and the next action.
- **Body.** The body begins with this block, filled in:

```yaml
settled_run: R-n
kind: engineer | review
verdict: PASS | NEEDS-WORK | FAIL | n/a (engineer)
evidence_sums: ok | mismatch
rerun: "<command> -> exit <n>"
claims_checked: ["<claim>: verified|contradicted|could-not-check", ...]
out_of_scope_files: []
fix_round: "<n of 2 | escalation | n/a>"
next_action: dispatch-review | dispatch-fix | promote | operator-decision | park
org_commands: ["<each org command, exact>"]
dispatch_command: "<the exact dispatch.sh line the supervisor should run, or empty>"
supervisor_attention: "<one sentence, or empty>"
```

After the block, keep it short: what you verified, what you could not, and anything surprising.
- **When to set `supervisor_attention`.** Whenever something does not match, a claim is contradicted, the cap is
  reached, or an operator decision is involved.
- **Proposals.** Leave `proposals` empty. Any new work goes into `supervisor_attention` instead, so that settling
  never files items the supervisor has not seen.
