# Evaluation: operator alignment (2026-09-30)

Fresh read of herdr-brain (main and `lane/block-review`) and how bch-cloak actually runs, judged against
`HANDOFF-operator-alignment-2026-09-30.md`. Read only. Branch tests: 278 pass, 1 fails (delegate).

## 1. What already serves the conclusions

| Conclusion | Already built | State |
|---|---|---|
| Authority split | bch-cloak `.lane/supervisor/SETTLE.md` §3 (Yours / Operator's + question template); `archive/SETTLE-DESK-POOL-20260927.md` (desks list `org_commands`, never decide) | Exists, but **the live supervisor does not run under it** (gap 1) |
| Operator questions | **`org ask` / `org answer --overrule` on main** (`bin/org.mjs` ask(), answer()), category policy `ask`/`auto` (`lib/store.mjs` DEFAULT_CONFIG, README "Categories and approval policy"), `org today --json` `approvals.counts` | Forgotten. Used 10 times. SETTLE.md §3 still uses the older `org add --role human` + `org set meta.*` form |
| Proof that approval is friction | The counts above, live: 26 of 27 categorized answers matched the recommendation (design 8/8, funds 5/5, prover 4/4); the one overrule was **security** | Nobody read it |
| Routine decided + shown | `org note --decision --summary`; `org today` *decided*; branch `org recap` "STEERING AND DECISIONS" | Works; useless while every writer is `human` |
| Parking | SETTLE.md §4 and §5 "New items start parked" (`meta.stage=parked`); `lib/today.mjs` hides parked questions | Lapsed: no `meta.stage` written since Sep 23 |
| Stage rules | SETTLE.md §1/§5, `stage.sh`/`stage.py`, `lib/today.mjs` `open_stage` | **Dead.** G-2..G-5 dropped; G-1 `stage_now=1` (Sep 17) still makes `org today` report stage 1 open |
| Plan labels | items pane resolves `meta.alias` (`feed.mjs` aliases()) | Never used in the org |
| Time-boxed study | run `meta.time_box` (ARCH-141) | Used once |
| Attribution | `ORG_ACTOR` in core since M1; set by `contrib/settle-watch.mjs`, `brain start`, console `cli.mjs` | `supervisor-opus-20260925` set it (167 events), then it stopped |
| Brain | watcher, queue, Sonnet digest, `start`, `explain` | Running `watch --digest`; see gap 5 |
| Lanes | herdr-brain `lanes/` (2,360 lines) | bch-cloak runs its own `scripts/lane/lane.mjs` (637) plus desks (`WORK-PATTERN.md`) |

The same job is done in several places. There are three watchers (`settle-watch.mjs`, bch-cloak `notify-watch.sh`,
`brain watch`) and five decision channels (`org ask`, `org add --role human`, report "Decisions for the operator" sections,
chat-only OD-1..9/RD-A..D, the Brain queue).

## 2. Gaps, ranked by cost to the operator

1. **Drift: the protocol is not loaded.** SETTLE.md (last edited Sep 20) is the `--checklist` only for `continue.sh` and
   `arm-watch.sh`, and those fresh executives last ran Sep 20. The live `supervisor-opus` chat follows OPEN-STATE,
   WORK-PATTERN and memory, and neither file mentions SETTLE.md. Its rules have lapsed: 415 ready items under G-1, 20 active runs
   against the two-lane cap, no parking since Sep 23. **Amending SETTLE.md does nothing until the chat loads it.**
2. **Drift: no operator-owned priority list.** The stage gate is dead. Priority #1 lives only in OPEN-STATE prose and claude-mem.
   724 `priority` edits came from unnamed or supervisor writers. The ARCH-230 subtree took **99 runs** between Sep 25 and 29, more than the handoff's 33.
3. **Attribution.** 1,988 of the 2,970 events since Sep 26 are `human`, and 59 of 67 answers are `answered_by: human`. Neither the operator nor
   the "steered and decided" list can tell the operator's decisions from the supervisor's.
4. **Decide is a swamp.** 7 open HUM questions from Sep 25–29 have no category or recommendation and were all filed by workers.
   There are also 8 `needs_human` reports and chat-only OD/RD numbering.
5. **Tokens.** Brain made **395 Sonnet digests in two days** of bch-cloak sessions, and none were answered. notify-watch already
   delivers the same results.
6. **Pane observability.** There is no grouping by priority and no parked or unserved view. Report-section decisions are answered by chat
   message instead of in the org.

## 3. lane/block-review, judged

The branch is 10.4k lines: 3.4k docs, 1.5k proto, 4.5k modern console and tests, 0.5k core. It sits on unmerged console-autonomy.

- **Unattributed-write flag: keep.** It is small and correct, and the non-TTY test catches Claude's Bash tool.
- **`org recap`: keep.** Its STEERING AND DECISIONS section *is* the steered-and-decided list, and it could replace hand-written
  OPEN-STATE handoffs. It is the fourth summary view (status, today, snapshot, recap), so add no more views.
- **Block screen and modern console: freeze, don't merge.** Terminal session control, renaming, numbered sessions and the scope
  dropdown duplicate Herdr. The operator chose a chat with the items pane beside it. Leave modern, proto and the design docs on the branch.
- **Items pane: keep and simplify.** Drop `reportDecisions()`, which runs a regex over prose and makes a second decision channel. Answer org
  questions with `org answer` (ORG_ACTOR=human, honest because the operator pressed the key), then notify the supervisor.
  Group by priority.
- **Chat index: shrink** to a drift flag: "names the chat used that the org cannot resolve". Reading Claude transcripts was
  deleted once already (INVENTORY contradiction E).
- **Delegation queue: drop.** It tells the supervisor "decided on the operator's authority… record it as the operator's
  answer", which is dishonest by design. It also makes the console start model sessions. The checker is an ordinary routed org run
  (dispatch.sh, `check` route, notify-watch) and needs no herdr-brain code. Delete the failing test with it.

## 4. Smallest set of changes, by impact

1. **[bch-cloak config]** `session-start.sh` gets `[ -n "${CLAUDE_ENV_FILE:-}" ] && echo 'export ORG_ACTOR=supervisor-opus' >> "$CLAUDE_ENV_FILE"`
   and a systemMessage pointing to "Read SETTLE.md §3 and §5". This fixes gaps 1 and 3 together. When the supervisor relays the operator's words, the
   note quotes them ("Operator, chat 20:55: '…'").
2. **[bch-cloak config, operator writes]** Record the priority list: one decision note on G-1 headed `PRIORITIES` quoting the
   operator, plus `meta.priority_rank` on each item, written as `human` from the pane or the operator's terminal. Clear G-1 `meta.stage_now`.
3. **[supervisor kit]** The SETTLE.md amendments below.
4. **[bch-cloak config]** Add the `check` route.
5. **[brain]** Restart the service without `--digest`. This is a flag change, not code.
6. **[core]** `org today` and `status` list the ranked priorities, each with its runs, ready items and decisions. A run with no `serves` and no
   ranked ancestor shows as advisory attention. `org start` warns but never refuses. Port the unattributed flag and recap to a
   fresh lane off main, because bch-cloak runs main.
7. **[console]** The items-pane changes from §3, on the same fresh lane.

**Contract check:** none of the core changes calls a model or runs in the background. Priorities and unserved runs are derived from events, and nothing new is stored as status.
The warnings are advisory. The console writes only with `org answer` through the CLI, and once the delegate is gone the console starts no sessions. Event fields
`unattributed` and `meta.*` are ignored by older folds.

### SETTLE.md draft (bch-cloak)

*Under the principles:* "This protocol binds the live supervisor chat as well as fresh sessions."

*§1.1, replace the stage.sh sentence:* "Then `org show G-1`. The newest `PRIORITIES` decision note is the operator's ranked
list, and those items carry `meta.priority_rank`. That list, not READY, is what you may dispatch (§5). The 2026-09-17 stages are
retired."

*§3 Yours, add:*
- adopt a design or spec change inside a ranked priority after an independent review PASS, and after the check agrees when it is Contested
- record every routine decision when you make it: `org note <ID> --decision --summary "<one plain sentence>" "<why>"`.
  The operator overrules afterwards. Never wait for them.

*§3 new, Contested, one check, then proceed or ask:* A decision is contested when the author's recommendation is weak, a
reviewer disagreed, or adopting it changes a frozen contract, library cryptography or a relation. File
`org add "Check: <decision>" --parent <ID> --role reviewer --meta check_of=<ID>`. Dispatch it on a review desk
(`review-desk.sh <commit>`) with route `check`. The brief names the recommendation, the objection and the commit, and asks for
`verdict: AGREE|DISAGREE` with file:line for each load-bearing claim. AGREE: proceed as Yours and cite the check run.
DISAGREE: it becomes the operator's, filed with `org ask --memo <check report>`. Custody, adversarial or covert-channel claims go to
`review-critical`.

*§3 The operator's, replace the list:* funding, signing, broadcast or chain contact beyond read-only Chipnet RPC; a prover or
Setup beyond AGENTS.md's standing one-prove authorization; the deployed profile, pins, trust anchors, committed vector corpora;
publication at any gate, any push; the goal, the priority list or a rank; security disclosure; anything AGENTS.md reserves;
a Contested decision whose check disagreed. *Template:* `org ask "<yes/no>" --parent <ID> --category <c> --recommend yes|no
--why "<two sentences>" --on-yes "…" --on-no "…" [--memo P] [--blocks ID]`, then the notification as now. Never number questions in chat.

*§4, parking exception:* "…unless it blocks an item that serves a ranked priority. Then set `meta.serves=<priority ID>`."

*§5, replace "The open stage only" and "Prioritized work first":*
- **Ranked priorities only.** `org start … --meta serves=<priority ID>`. Work that serves no ranked priority is parked, listed
  under *Parked* in OPEN-STATE, and neither dispatched nor asked about. When nothing ranked can proceed, stop and say so.
- **One study at a time.** At most one research, study or proposal run is open, with `--meta time_box=<hours>`. Its proposals are parked.
- Within a priority, order and split work freely with `priority`. Never touch `meta.priority_rank`.

*§6, replace the item-code sentence:* "Name things by what they are, always followed by the org ID in parentheses: the items
pane resolves it. Record a plan label (3A, 4-DC2) with `org set <ID> meta.alias=3A` before using it."

### routing.json draft

```json
"check": {
  "kind": "claude",
  "model": "claude-sonnet-5",
  "effort": "medium",
  "use": "Contested-decision check: read-only verification of a recommendation's and its objection's load-bearing claims against the code; reports AGREE or DISAGREE with file:line. Never implements, reviews a whole change, or answers an operator question."
}
```

Add `"contested-check": { "claude": "check", "codex": "check" }` to `by_task_class`. Before relying on it, confirm that Claude
accepts `medium` here, since every Claude route today is high or above. Also note that `dispatch.sh` and `apply-settle.sh` still copy
model and effort, which breaks routing.json's own rule.

## 5. Questions for the operator

1. Move library crypto, relation and frozen-contract adoptions to Contested? **Recommend yes.** Design was 8 of 8 as recommended.
   Keep security yours, since it had the one overrule.
2. Checker: Sonnet 5 at medium? **Recommend yes**, with custody and adversarial claims going to Codex `review-critical`.
3. Is #1 ARCH-355 the whole list for now, and may G-1's `stage_now` and `stage.sh` be retired?
4. The north star says to eliminate the long-running chat, and you are keeping it. May `north-star.md` say the goal is now a cheap
   restart (recap as the handoff)?
5. Should only the attribution flag, recap and a slimmed items pane be ported to main, with the rest of the branch left unmerged?
