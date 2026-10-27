# Practitioners on bounded autonomous troubleshooting: who publishes concrete mechanics for keeping agents converging on a goal-aligned fix

Research date: 2026-10-26. Scope: individual practitioners' own primary publications.

How quotes were checked, by source type:
- **Exact text:** pstack and superpowers files were downloaded raw from GitHub (`raw.githubusercontent.com` and the GitHub API) on 2026-10-26, so their quotes are exact. The Claude Code best-practices page was saved in full, and its quotes are also exact.
- **Via a summarizer:** every other page was fetched with a web fetcher that runs a summarizer. Its quoted strings came back as quotes, but a writer should spot-check exact punctuation before putting one in a headline.
- **Dates:** each source's date is the page's own date, unless the note says otherwise.
- **Unverified:** sources marked UNVERIFIED or NOT FETCHED did not load.

---

## Jesse Vincent (obra/superpowers): systematic-debugging, the 3-fix rule, verification-before-completion, subagent-driven development with a capped fix loop

### Takeaway
Superpowers gives the most explicit, numbered stop rules of anyone here. The rules:
- **Debugging:** after 3 failed fixes, stop and question the architecture with the human. Fix #4 is not attempted.
- **Review fixes:** a review-fix loop is capped at 5 rounds per task. Rounds 4-5 go to a fresh implementer on a model at least one tier stronger. At the cap, the controller rules on what is left, records the ruling, and keeps going.
- **Stopping:** autonomous plan execution stops for exactly four named reasons.
- **Completion claims:** these need fresh command output.

### Cited Findings
**Systematic debugging** (`skills/systematic-debugging/SKILL.md`, last changed 2026-10-10 per the GitHub API, read 2026-10-26):
- Iron Law: "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST" — [systematic-debugging SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Four mandatory phases, in order: Root Cause Investigation, Pattern Analysis, Hypothesis and Testing, Implementation. "You MUST complete each phase before proceeding to the next." — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- The numeric thrash rule:
  - "If < 3: Return to Phase 1, re-analyze with new information"
  - "If ≥ 3: STOP and question the architecture"
  - "DON'T attempt Fix #4 without architectural discussion"
  - "Discuss with your human partner before attempting more fixes"
  - "This is NOT a failed hypothesis - this is a wrong architecture."
  — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Red flags that mean "STOP. Return to Phase 1":
  - "Quick fix for now, investigate later"
  - "Just try changing X and see if it works"
  - "One more fix attempt" after 2 or more attempts
  — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- When a hypothesis fails, form a new one rather than stacking fixes. If the issue cannot be reproduced, gather data rather than guess. If you do not understand something, say so and ask or research. — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)

**Verification before completion:**
- "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"
- "If you haven't run the verification command in this message, you cannot claim it passes."
— [verification-before-completion SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/verification-before-completion/SKILL.md)
- Gate function: IDENTIFY the command, RUN it, READ the output, VERIFY, and only then make the claim. "Skip any step = lying, not verifying." — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/verification-before-completion/SKILL.md)
- Table rows from the skill:
  - "Agent completed | VCS diff shows changes | Agent reports 'success'"
  - "Bug fixed | Test original symptom: passes | Code changed, assumed fixed"
  - "Regression test works | Red-green cycle verified"
  — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/verification-before-completion/SKILL.md)
- Red flags include "Using 'should', 'probably', 'seems to'" and "Trusting agent success reports". — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/verification-before-completion/SKILL.md)

**Subagent-driven development: how it stays on goal and stops**
- Structure: "Fresh subagent per task + task review (spec + quality) + broad final review". — [subagent-driven-development SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- Binding authority: "The spec is the binding authority, the plan is its argument, and your judgment settles what neither answers." — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- "Rulings, not stalls": decisions go into a ledger as `Ruling: <what you decided> — <why> — <what it costs if wrong>`. "A wrong ruling costs rework your human partner can see and undo; a session parked on a question costs their whole day and buys nothing." — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- Exactly four stop reasons:
  - "an irreversible or destructive operation"
  - "a security-sensitive action"
  - "a side effect outside this worktree that norms say you ask about first (a merge, a push to a shared branch, a publish)"
  - "a plan so broken that every path forward is a guess"
  — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- Bounded waiting: "never poll a wait interface with short timeouts, and never sit in one silent, open-ended wait either". When idle, "wait in bounded stretches (five to ten minutes...)", then post one status line and reconcile live children. — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)

**The fix loop** (`references/fix-loop.md`):
- Size: "A fix round is one fix dispatch plus one scoped re-review. Five rounds maximum per task". — [fix-loop.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/references/fix-loop.md)
- Rounds 1-3 resume the original implementer. Rounds 4-5 go to "a fresh implementer on a more capable model", with the framing "A prior implementer attempted this task [N] times; you own it now". Rationale: "A loop that survives three resumes usually means the implementer cannot see its own problem — fresh eyes and a capability bump in one move." — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/references/fix-loop.md)
- Scope control inside the loop:
  - "Out-of-scope observations go to the ledger as deferred minors — they never extend the loop."
  - "Minor findings never enter the loop."
  - Each round is ledgered as `fix round <R>/5`.
  — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/references/fix-loop.md)
- "The breaker": if round 5 still leaves findings open, "stop dispatching" and adjudicate each one yourself, either parking it with a ruling or making the smallest unblocking ruling. "Adjudicate only at the cap. Adjudicating earlier to end a loop is pre-judging with a different name." The controller never fixes code itself: "controller fixes skip review." — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/references/fix-loop.md)

**Model tiering** (provider-neutral):
- "Use the least powerful model that can handle each role". — [subagent-driven-development SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- Fix-loop escalation: "use a model at least one tier above the implementer that got stuck". — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- "Turn count beats token price ... the cheapest models routinely take 2-3× the turns on multi-step work — costing more overall. Use a mid-tier model as the floor for reviewers". — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- The final whole-branch review is dispatched "on the most capable available model, not the session default." — [same](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)

**Repository and blog context:**
- Latest commit: 2026-10-21, "Release v7.0.1: brainstorming retune, skills that better survive compaction" (GitHub API, cited via the repo). — [obra/superpowers](https://github.com/obra/superpowers)
- 7.0 shipped 2026-10-09, the one-year anniversary, with a "completely rebuilt brainstorming experience". It is "much happier to get out of the way when you know exactly what you want". The post reports ~300,000 stars and 1.1M+ installs. — [What a year (blog.fsck.com, 2026-10-09)](https://blog.fsck.com/2026/10/09/what-a-year/)
- Superpowers 6.4 (2026-09-21) added support for Meta's Muse, OpenCode 2.0 and Qwen Code. The skills are harness-agnostic. — [blog.fsck.com index](https://blog.fsck.com/)
- "Some new agentic patterns" (2026-07-05):
  - The agent iterates on a spec with another agent before deploying.
  - "Claude watched the logs to see if the credential proxy did the right thing."
  - Overnight self-directed improvement ended with "Once Ada signed off, Claude merged the changes to main and wrote up an after-action report".
  — [Some new agentic patterns](https://blog.fsck.com/2026/07/05/new-patterns/)

### Inferences
- For an operator writing stop rules, these are the most directly transplantable thresholds:
  - 3 failed fixes leads to an architecture question.
  - 5 fix rounds is the cap, with a model escalation at round 4.
  - 4 enumerated stop reasons.
  - Waits are bounded at 5-10 minutes.
- Ledger-recorded rulings are the anti-stall mechanism. Deferred-minor routing is the anti-scope-creep mechanism.
- Superpowers' "3 strikes, then ask the human" (debugging) and "decide, don't ask" (plan execution) coexist. Debugging escalates to a human. Plan-execution conflicts get a recorded ruling.

### Gaps
- I did not find a Jesse Vincent post that uses a different-provider model specifically as a check. The model guidance is tier-based, not vendor-based. The 2026-07-05 post mentions Codex only as an alternative harness.
- I did not read the 7.0.1 release notes (`RELEASE-NOTES.md`) in full.

---

## Lauren Tan / pstack (cursor/plugins): attack-the-premise after 2 failed fixes, binary-search debugging, predicate-driven autonomous runs, one-retry CI rule, multi-model interrogate

### Takeaway
pstack encodes bounded troubleshooting as playbooks plus "principle" skills:
- **Attack the premise:** after two or more fixes that share a premise fail the same gate, write the premise down and test it before writing another fix.
- **Bug fixes:** binary-search the cause with runtime evidence, and revert anything a refuted hypothesis motivated.
- **Autonomous runs:** run against a checkable predicate that is never relaxed.
- **Babysit:** works only the merge frontier and allows at most one CI retry.
- **Second opinion:** defined as "the same prompt against a different model." By default that pairing is Opus 5.5 with Grok.

### Cited Findings
Files were read from `main` on 2026-10-26. The latest pstack commit is 2026-10-23 (GitHub API).

**Attack the premise:**
- "When two or more fixes that share one premise have failed the same gate, suspect the premise, not the fixes." — [principle-attack-the-premise](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-attack-the-premise/SKILL.md)
- "A third fix on the same premise spends effort where the evidence already says the cause is not." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-attack-the-premise/SKILL.md)
- Steps:
  - "Write the premise down."
  - "Test the premise before the next fix". Find an observation that would differ if the premise were false, and look at how failures are distributed, not only how large they are.
  - "Stop: Do not start the next fix before the premise is written down and tested."
  — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-attack-the-premise/SKILL.md)

**Fix root causes:**
- "Reproduce first."
- "When stuck, instrument. Read the actual error and the actual state. Do not guess."
- "Guards, retries, swallowed errors, clamped values, and discarded state are the usual ways to hide a bug."
- "If the deciding fact took a deep dig to find, propose the cheap, always-on signal that would have shown it at first look."
— [principle-fix-root-causes](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-fix-root-causes/SKILL.md)

**Bug-fix playbook:**
- "Every shipped line traces to runtime evidence. Belt-and-suspenders that 'might help' is a hypothesis, not a fix. It does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more." — [bug-fix.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/bug-fix.md)
- "Binary-search the cause. ... Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/bug-fix.md)
- Verify on the same surface: "'Inconclusive' or wrong-surface is not a pass." The failing repro is staged in git before the fix. — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/bug-fix.md)
- Implementation is delegated to a subagent "using your configured bug-fix model (default `grok-4.7-xhigh-fast`)". — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/bug-fix.md)

**Autonomous-run playbook:**
- "State the exit condition as a checkable predicate before the first iteration". — [autonomous-run.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/autonomous-run.md)
- Each iteration "makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/autonomous-run.md)
- On side discoveries: "Keep the predicate as the main drive, and return to it after each side fix", and "Put out-of-band fixes in their own PR." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/autonomous-run.md)
- On stopping: "A plateau is not a stop ... pivot your approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/autonomous-run.md)
- Every iteration is checkpointed via `show-me-your-work`, a row recording what changed and whether the predicate moved. — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/autonomous-run.md)

**Babysit playbook** (drives a PR or stack to merge-ready):
- "Work the merge frontier and nothing above it. ... If you catch yourself upstack while the frontier is red, stop and go back down." — [babysit.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/babysit.md)
- "One babysitter per stack." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/babysit.md)
- "Classify CI before any retrigger. Flake or infrastructure earns one fresh build, never a job retry. One retry only. An identical second failure means it was never flake". A failure in code the diff never touched means a stale base, checked with `git merge-base --is-ancestor`. — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/babysit.md)
- On review bots: "From the third pass on, lean toward dismissing documented patterns", while still escalating security, auth, billing, data and migrations. "Never churn code to quiet a bot." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/babysit.md)
- "Stop at the human's line. ... Babysitting never authorizes merging." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/babysit.md)

**Figure-it-out** (for unattended or ambitious work):
- Done is defined as "a falsifiable predicate", with scope quantified up front. "Rigor is gates and artifacts, not 'try harder'." — [figure-it-out](https://github.com/cursor/plugins/blob/main/pstack/skills/figure-it-out/SKILL.md)
- "A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/figure-it-out/SKILL.md)
- "When something passes too easily, suspect the observation method before the system." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/figure-it-out/SKILL.md)
- "Pair delegated work with a judge. If a worker games the gate, reset and harden the contract." — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/figure-it-out/SKILL.md)
- "a multi-hour run earns one checkpoint". — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/figure-it-out/SKILL.md)

**Second model as a check:**
- poteto-mode: "A second opinion is the same prompt against a different model. Agreement is high-signal." — [poteto-mode SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
- Interrogate spawns one read-only reviewer per configured model. Defaults are Reviewer A `claude-opus-5-5-xhigh` and Reviewer B `grok-4.7-xhigh-fast`. "The adversarial signal comes from model diversity, not assigned personas." — [interrogate](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/SKILL.md)
- "Findings two or more models raised independently are the highest signal." The lead sorts findings into Act on, Consider, Noted, or Dismissed, and does "NOT auto-apply changes". — [same](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/SKILL.md)
- "Fresh subagents by default" for fix rounds, retries and follow-ups, with consolidated scope. "Interrupt-chained resumes silently drop directives". — [poteto-mode SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)

**Retro-like skills** (there is no skill literally named "retro"):
- `/reflect` spawns 3 parallel reviewers over the transcript: Judgment and Divergent on Opus 5.5, Tooling on Grok. A synthesizer returns Accepted, Rejected, or Backlog, and each learning becomes "a concrete edit on an existing skill". — [reflect](https://github.com/cursor/plugins/blob/main/pstack/skills/reflect/SKILL.md)
- `/correct` finds repeated mistakes ("A class counts once it has happened twice"). It fixes each at the highest level, in the order architecture, then types, then a lint, then a test, with docs last. — [correct](https://github.com/cursor/plugins/blob/main/pstack/skills/correct/SKILL.md)

**Model role split:**
- "code delegates (feature, refactoring, bug fix, perf, hillclimb) go to grok, while the hardest changes, prose, and judgment go to opus 5.5. the default panel is opus 5.5 / grok." — [pstack README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
- "Verification is the exception and stays on the `swarm workers` model". It also says to keep the model family each role names "so a diverse panel stays diverse." — [poteto-mode SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
- The README documents a Claude Code install path (`/pstack:poteto-mode`). — [pstack README](https://github.com/cursor/plugins/blob/main/pstack/README.md)

### Inferences
- pstack's "2+ fixes sharing one premise fail the same gate" trigger is stricter and more diagnostic than a raw attempt count. It counts failures per premise, not per attempt. That makes it a good complement to Superpowers' ≥3 rule.
- "Never relax the predicate", "a plateau is not a stop", and "surface a genuine dead end" together form a clear convergence contract for unattended runs.
- pstack's default diversity pair is Anthropic plus xAI, not OpenAI. An operator running Codex plus Claude would substitute a Codex model into the Reviewer B slot. That is a configurable `/setup-pstack` role line; this is my inference from the role-line mechanism.

### Gaps
- NOT FETCHED: `cursor.com/lp-team/lauren` ("pstack: the skills behind 10,000 agent runs"). Both the English and French URLs returned Cursor's pricing page, so the "10,000 agent runs" claim is unverified.
- I found no personal blog post by Lauren Tan specifically about troubleshooting. Her practice is documented through the pstack repo.
- Grok model slugs (`grok-4.7-xhigh-fast`) are as written in the repo. I did not verify what model they map to.

---

## Boris Cherny and the Claude Code team: plan mode, "give Claude a way to verify its work" (2-3x), two failed corrections then /clear, Stop hooks and /goal

### Takeaway
Two layers here:
- **Cherny's own thread (2026-01-02):** start in plan mode, run 5 sessions in parallel, verify through a background agent or Stop hook, and use the ralph-wiggum plugin for very long tasks. His top tip is giving Claude a verification loop, which he says "will 2-3x the quality".
- **The official best-practices doc:** watch the first minute and press Esc on drift. After two failed corrections, `/clear` and rewrite the prompt instead of making a third. Before unattended runs, set a pass/fail check, a turn or spend cap, and a human sign-off.

### Cited Findings
**Cherny's thread, dated Jan 2** (read through a Threadreader mirror; thread ID 2007179832300581177 implies 2026):
- "Most sessions start in Plan mode (shift+tab twice)". For PRs he iterates on the plan, then switches to auto-accept. "A good plan is really important!" — [Threadreader: Boris Cherny thread](https://threadreaderapp.com/thread/2007179832300581177.html)
- "I run 5 Claudes in parallel in my terminal." He also says "I use Opus 4.5 with thinking for everything", because it needs less steering. — [same](https://threadreaderapp.com/thread/2007179832300581177.html)
- "Anytime we see Claude do something incorrectly we add it to the CLAUDE.md". — [same](https://threadreaderapp.com/thread/2007179832300581177.html)
- For long tasks, he asks Claude to verify with a background agent when done, sometimes uses an agent Stop hook to make that deterministic, and uses the "ralph-wiggum plugin" (credited to Geoffrey Huntley). He also runs a verify-app subagent and a code-simplifier subagent. — [same](https://threadreaderapp.com/thread/2007179832300581177.html)
- Most important tip: give Claude a way to verify its work. It "will 2-3x the quality of the final result". He tests web changes through the Chrome extension. — [same](https://threadreaderapp.com/thread/2007179832300581177.html)

**Claude Code best practices** (undated live doc, read 2026-10-26; it references Opus 5.5 and Fable 5.1, so it is current):
- "Give Claude something it can run that comes back pass or fail. Once it has that, it can keep going on its own and you don't have to watch." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Strictness ladder, from loosest to strictest:
  - A prompt such as "keep going until they pass".
  - `/goal`: "sets a condition that a separate model checks against the conversation after every turn".
  - A Stop hook, which exits with code 2 to block.
  - `/code-review`, run "in a fresh subagent that never saw your conversation".
  — [same](https://code.claude.com/docs/en/best-practices)
- "ask Claude for *evidence*: the command it ran and its output ... 'All tests pass' on its own tells you very little". — [same](https://code.claude.com/docs/en/best-practices)
- Steering rule: "Watch the first minute, press `Esc` the moment Claude drifts, and after two failed corrections run `/clear` and write a better prompt instead of a third." — [same](https://code.claude.com/docs/en/best-practices)
- Why `/clear` beats a third correction: "a third correction mostly adds to a conversation that already contains two failed attempts for Claude to keep re-reading. `/clear` plus one new prompt that folds in what you learned works better almost every time." — [same](https://code.claude.com/docs/en/best-practices)
- `/rewind` rolls code and conversation back, which makes it "low-risk to try the bolder approach first and rewind if it doesn't work out." — [same](https://code.claude.com/docs/en/best-practices)
- Stop-hook cap: "If the hook blocks eight stops in a row with no tool call between them, Claude Code overrides the next block and ends the turn." The cap is configurable via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. — [same](https://code.claude.com/docs/en/best-practices)
- Five questions before unattended runs:
  - Does it know what done looks like?
  - Can it check its own work?
  - What may it touch?
  - "What stops it? `--max-turns`, `--max-budget-usd`, a spend limit."
  - Who signs off?
  The doc warns that otherwise "it spent the whole night building on the wrong assumption." — [same](https://code.claude.com/docs/en/best-practices)
- Scope creep from reviewers: "Don't drop the `skip style` part ... A reviewer that's asked to find problems will always find *something*. If you fix every finding, you end up with extra abstraction layers and tests for cases that can't happen." — [same](https://code.claude.com/docs/en/best-practices)
- On "loop until done" prompts: lines like "don't be lazy" "are more likely to cause over-work than fix a stall. Giving Claude a check to pass is different". — [same](https://code.claude.com/docs/en/best-practices)
- "Handing the same task to a subagent doesn't make the answer any better. A fresh reviewer does help, because it hasn't seen your reasoning". — [same](https://code.claude.com/docs/en/best-practices)
- Spec-first: "Interview me until you could write the spec, then write it to SPEC.md", then build "in a fresh session" from it. — [same](https://code.claude.com/docs/en/best-practices)

### Inferences
- The "two failed corrections then /clear" rule is the human-steering counterpart to Superpowers' 3-fix rule and pstack's 2-fix premise rule. All three converge on stopping at about 2-3 failed attempts and changing the frame, not the patch.
- The Claude Code team puts goal enforcement in the harness (`/goal` checked by a separate model each turn, Stop hooks with an 8-block cap), not in the prompt.

### Gaps
- UNVERIFIED (secondary only): a widely reposted Claude Code team-tips thread from about 2026-01-31, including "Knowing everything you know now, scrap this and implement the elegant solution" and "Grill me on these changes and don't make a PR until I pass your test". I could not reach the original X post or a Threadreader copy. Secondary write-up: [bswen](https://docs.bswen.com/blog/2026-03-27-prompt-examples-from-claude-code-creator).
- The Threadreader page shows "Jan 2" without a year. 2026 is inferred from the thread ID and the Opus 4.5 reference.
- The Claude Code doc is unsigned team documentation, not a personal Cherny post.

---

## Geoffrey Huntley: Ralph loop, one item per loop, backpressure, specs and a disposable plan as the steering wheel

### Takeaway
Ralph bounds autonomy structurally:
- One task per fresh-context loop iteration.
- Fast "backpressure" (tests, types, lints, builds) that rejects bad output.
- Specs as the source of truth, plus an `IMPLEMENTATION_PLAN.md` that is thrown away and regenerated when the loop drifts.
- When things go wrong: narrow to one item, `git reset --hard`, regenerate the plan, add a "sign" to the prompt, and watch the loop to learn its failure domains.

### Cited Findings
**"Ralph Wiggum as a 'software engineer'"** (2025-07-14):
- "To get good outcomes with Ralph, you need to ask Ralph to do one thing per loop." — [Ralph Wiggum as a "software engineer"](https://ghuntley.com/ralph/)
- "if it starts going off the rails, then you need to narrow it down to just one item." — [same](https://ghuntley.com/ralph/)
- On backpressure: "Anything can be wired in as back pressure to reject invalid code generation", and "the wheel has got to turn fast." — [same](https://ghuntley.com/ralph/)
- Only "1 subagent for build/tests of rust", while reads and searches fan out to "up to 500 subagents". — [same](https://ghuntley.com/ralph/)
- Failure handling:
  - "Each time Ralph does something bad, Ralph gets tuned - like a guitar". Tuning adds "signs" to the prompt.
  - "Is it easier to do a `git reset --hard` and to kick Ralph back off again?"
  - If Ralph builds the wrong thing, "your specifications may be incorrect."
  — [same](https://ghuntley.com/ralph/)
- On bias: "Claude has the inherent bias to do minimal and placeholder implementations", and "the reward function is compiling code." — [same](https://ghuntley.com/ralph/)
- Quality "clips at the 147k-152k mark" of about 170k usable context. This figure comes from an excerpt of a linked post. — [same](https://ghuntley.com/ralph/)
- Models in the post:
  - Gemini, used to turn a compile-error file into a plan.
  - Amp, as the tool for the "$297 USD" MVP.
  - Prompts say "use the oracle to plan".
  — [same](https://ghuntley.com/ralph/)

**how-to-ralph-wiggum guide** (README undated, "© 2026" footer):
- Backpressure: "Create backpressure via tests, typechecks, lints, builds, etc. that will reject invalid/unacceptable work." — [ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)
- Two modes. Planning mode is "Plan only. Do NOT implement anything". Building mode picks one task, validates it, updates the plan, and commits. The loop is `./loop.sh [plan] [max_iterations]`, with `./loop.sh 20` as the example cap. — [same](https://github.com/ghuntley/how-to-ralph-wiggum)
- Specs: "One markdown file per topic of concern. These are the source of truth". — [same](https://github.com/ghuntley/how-to-ralph-wiggum)
- The plan "persists on disk between iterations and acts as shared state". It is disposable: regenerate it when Ralph goes off track, duplicates work, or the plan goes stale. "If it's wrong, throw it out, and start over." — [same](https://github.com/ghuntley/how-to-ralph-wiggum)
- Context numbers:
  - "When 200K+ tokens advertised = ~176K truly usable".
  - Target a 40-60% "smart zone".
  - Put specs in roughly the first 5,000 tokens.
  - Keep `AGENTS.md` around 60 lines.
  — [same](https://github.com/ghuntley/how-to-ralph-wiggum)
- Models:
  - `claude -p --model opus`, with Sonnet optional in build mode.
  - Sonnet subagents for search and read, Opus subagents for analysis.
  - An "Opus 4.5 subagent with 'ultrathink'" for spec inconsistencies.
  - GPT 5.1 and Gemini 3.0 Flash appear as example LLM reviewers ("examples, not requirements").
  — [same](https://github.com/ghuntley/how-to-ralph-wiggum)

**"everything is a ralph loop"** (2026-01-17):
- Ralph "performs one task per loop". — [everything is a ralph loop](https://ghuntley.com/loop/)
- It is "important to watch the loop", because that is where you learn. When you see a failure domain, resolve it "so it never happens again." — [same](https://ghuntley.com/loop/)

### Inferences
- Huntley's anti-rabbit-hole levers are structural rather than numeric attempt caps:
  - single-item scope per iteration;
  - fresh context each loop;
  - a cheap-to-regenerate plan;
  - fast deterministic rejection;
  - `max_iterations`.
- He mixes model families: Claude runs the loop, while Gemini and Amp's oracle (OpenAI-backed, per Amp) serve planning and review.

### Gaps
- Huntley links a post titled "don't waste your back pressure" from "everything is a ralph loop". I did not locate or fetch it, and searches for the phrase failed.
- No explicit numeric "N failed iterations, then stop" rule appears in the sources fetched.

---

## Armin Ronacher: tool design for agents, clear goals from tests, failure modes ("local defense", 35-hour runaway), and Claude-to-Codex handoff

### Takeaway
Ronacher's answer is environmental:
- Fast tools with clear errors, logs written to files, guards against misuse.
- A goal made mechanical by existing tests. His MiniJinja port used snapshot tests to drive 10 hours of agent work on 45 minutes of human time.
- His warning: unattended loops "add a local defense" per failure, which makes systems less understandable, and a too-big task lets a strong model "continue until it succeeds". In one case that meant a 35-hour run that produced nothing of value.
- He moves between Anthropic and OpenAI models deliberately.

### Cited Findings
**Agentic Coding Recommendations** (2025-06-12):
- "Tools need to be fast. ... Crashes are tolerable; hangs are problematic." — [Agentic Coding Recommendations](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)
- "Tools must clearly inform agents of misuse or errors to ensure forward progress." — [same](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)
- "Tools need to be protected against an LLM chaos monkey using them completely wrong". — [same](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)
- He always logs to a file the agent can read. He changed `make dev` to fail with "services are already running" because the agent "happily spawns it a second time". — [same](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)
- He asks agents for "the dumbest possible thing that will work". — [same](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)
- On cheap let-it-run upgrades: "I do not find this to be a successful path at all." — [same](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)
- Model at the time: "I exclusively use the cheaper Sonnet model." — [same](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)

**Agentic Coding Things That Didn't Work** (2025-07-30):
- Sub-agents: "Tasks that don't parallelize well, especially those mixing reads and writes, create chaos." — [Things that didn't work](https://lucumr.pocoo.org/2025/7/30/things-that-didnt-work/)
- "Long sessions lead to forgotten context from the beginning." — [same](https://lucumr.pocoo.org/2025/7/30/things-that-didnt-work/)
- "I tend to overestimate the agent's capabilities with time". He warns automation "encourages mental disengagement". — [same](https://lucumr.pocoo.org/2025/7/30/things-that-didnt-work/)
- He validates an automation by running it "three times" and judging the variance. — [same](https://lucumr.pocoo.org/2025/7/30/things-that-didnt-work/)

**Porting MiniJinja to Go With an Agent** (2026-01-14):
- The agent first worked out how to validate the port: reuse Rust snapshot tests and port lexer, then parser, then runtime. "The agent had a clear goal (make everything pass) and a progression." "Every missing behavior had one or more failing snapshots." — [MiniJinja Go port](https://lucumr.pocoo.org/2026/1/14/minijinja-go-port/)
- Drift he corrected:
  - The agent "completely gave up on all the 'must fail' tests". He steered it to fuzzy error matching.
  - It tried to regress HTML escaping and `range` semantics. He pushed back, or he would have "lost confidence in the result."
  — [same](https://lucumr.pocoo.org/2026/1/14/minijinja-go-port/)
- Models: Claude Opus 4.5 did the initial work, then GPT-5.2 Codex took "the long tail of test fixing". Late in the run he queued "continue making all tests pass if they are not passing yet" and left it overnight. — [same](https://lucumr.pocoo.org/2026/1/14/minijinja-go-port/)
- Numbers: about 45 minutes of active human time, 10 hours of agent time (about 3 supervised), 34 human prompts, 2,698 messages, 1,386 tool calls, 2.2M tokens, about $60. — [same](https://lucumr.pocoo.org/2026/1/14/minijinja-go-port/)

**The Coming Loop** (2026-06-23):
- "There is already an agent loop inside every coding agent", plus "the harness level loop". — [The Coming Loop](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/)
- Failure mode: "models tend to observe some local failure and add a local defense". Unattended iteration makes the system "less understandable while appearing more robust." — [same](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/)
- Remedy: make malformed states "unrepresentable or impossible to write in the first place". — [same](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/)
- Many successful loops "use another LLM as a judge or as an orchestrator". Loops suit throwaway work; lasting code is harder to verify that way. — [same](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/)
- "Looping is powerful but it removes responsibility more and more." — [same](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/)

**Better Models: Worse Tools** (2026-07-04):
- Newer Anthropic models (Opus 4.8, Sonnet 5) added invented keys to edit-tool calls. Opus 4.8 failed "around 20% of the time" in one session. Removing thinking blocks from history "reduced the failure rate by half". — [Better Models: Worse Tools](https://lucumr.pocoo.org/2026/7/4/better-models-worse-tools/)
- "Turning on strict tool invocation eliminated it in my runs." "The Codex models I tested did not show this type of regression." — [same](https://lucumr.pocoo.org/2026/7/4/better-models-worse-tools/)

**Astra for Coding: Why Are We Doing This Again?** (2026-09-07):
- The setup was a "software factory" that let "the model decide the how of the workflow entirely". The model is "relentless in its pursuit of completion". Given a slightly too big task, it "will continue until it succeeds." — [Astra for Coding](https://lucumr.pocoo.org/2026/9/7/astra-why/)
- Result: about 35 hours, about $1,200, about 75k net lines, 79 commits, and about 1,400 inter-agent messages, with nothing of value produced. "I don't need an agent to run for 35 hours on a single prompt." The task-file naming had drifted to "8b2c2b2b checkpoint1". — [same](https://lucumr.pocoo.org/2026/9/7/astra-why/)
- Token figures conflict within the post ("around 4 billion" vs "around 1B tokens"). — [same](https://lucumr.pocoo.org/2026/9/7/astra-why/)

### Inferences
- Ronacher is the best source for why an unbounded agent fails to converge: completion-chasing plus local defenses. He is also the best source for the environment fix: fast tools, clear errors, unrepresentable states, a test-defined goal.
- His MiniJinja run is a concrete, numbered success case of a bounded loop: the goal was "make all snapshots pass", with phased targets and human pushback on goal-relaxing moves. It sits alongside a numbered failure case, the 35-hour factory.
- His goal-relaxation catch ("gave up on all the must-fail tests") is the same failure pstack forbids ("never relax the predicate").

### Gaps
- The Astra post names Astra, Sol and Fable without stating vendors. Astra is described as running on "ChatGPT tokens". The Claude Code docs elsewhere name "Claude Fable 5.1".
- I did not fetch "What Actually Is Claude Code's Plan Mode?" (2025-12-17) or "Agent Psychosis" (2026-01-18). They may hold more relevant material.

---

## Mitchell Hashimoto: plan-first sessions, back out what you don't understand, harness engineering per mistake, oracle for planning

### Takeaway
Hashimoto keeps agents on goal with:
- A planning session that writes a spec file.
- Small, separate sessions.
- A fill-in-the-blank skeleton.
- A rule of not shipping code he doesn't understand.

When an agent is stuck, he tries a few prompts, then backs out, pivots, or redoes the work by hand. He treats each agent mistake as a prompt to "engineer a solution": an `AGENTS.md` line or a verification script. He uses Amp's oracle (a different, slower model) for planning and a final "what's missing" check.

### Cited Findings
**Vibing a Non-Trivial Ghostty Feature** (2025-10-11):
- Planning is "a really important first-step for anything non-trivial". The plan was saved to a spec file for later sessions. — [Vibing a Non-Trivial Ghostty Feature](https://mitchellh.com/writing/non-trivial-vibing)
- "smaller chunks of work are easier to review, understand, and iterate on." — [same](https://mitchellh.com/writing/non-trivial-vibing)
- When stuck, at that point "AI is no longer the solution; it is a liability." — [same](https://mitchellh.com/writing/non-trivial-vibing)
- "If the agent figures it out and I don't understand it, I back it out", and "I'm not shipping code I don't understand." — [same](https://mitchellh.com/writing/non-trivial-vibing)
- He will "throw away everything it did, and redo it myself (manually!)". In another case he "decide[d] to pivot". — [same](https://mitchellh.com/writing/non-trivial-vibing)
- Cleanup "anti-slop" sessions, because "better organized and documented code helps future agentic sessions perform better." — [same](https://mitchellh.com/writing/non-trivial-vibing)
- He uses the oracle ("an Amp-specific read-only subagent" on a "slower, higher-cost model") for all planning. His final prompt was "Consult the oracle", and it "highlighted some real issues". — [same](https://mitchellh.com/writing/non-trivial-vibing)
- Numbers: 16 sessions, $15.98 in tokens, about 8 hours of wall-clock time. — [same](https://mitchellh.com/writing/non-trivial-vibing)

**My AI Adoption Journey** (2026-02-05):
- Harness engineering: "anytime you find an agent makes a mistake, you take the time to engineer a solution". — [My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
- "Each line in that file [AGENTS.md] is based on a bad agent behavior, and it almost completely resolved them all." — [same](https://mitchellh.com/writing/my-ai-adoption-journey)
- "If you give an agent a way to verify its work, it more often than not fixes its own mistakes and prevents regressions." He builds scripts "to take screenshots, run filtered tests". — [same](https://mitchellh.com/writing/my-ai-adoption-journey)
- "Using an agent for something it'll likely fail at is obviously a big waste of time." — [same](https://mitchellh.com/writing/my-ai-adoption-journey)
- Session shape: "Break down sessions into separate, clear, actionable tasks", with planning separated from execution. — [same](https://mitchellh.com/writing/my-ai-adoption-journey)
- Cadence: "block out the last 30 minutes of every day to kick off one or more agents". "In most cases, agents completed their tasks in less than half an hour." He has a background agent running about 10-20% of a working day, and runs one agent at a time by choice. — [same](https://mitchellh.com/writing/my-ai-adoption-journey)
- Models: Claude Code, plus Amp's deep mode, "basically just GPT-5.2-Codex", which can take "upwards of 30+ minutes to make small changes". — [same](https://mitchellh.com/writing/my-ai-adoption-journey)

### Inferences
- Hashimoto's "back it out if I don't understand it" is a human-side convergence gate. It stops rabbit holes from landing even when they "work".
- His use of the oracle as a final "what's missing" pass is a lightweight second-model check at the end, not a per-step one.

### Gaps
- I found no explicit numeric "N attempts, then stop" rule. He says only that he "tried a few more prompts".
- No 2026 post after February on agent troubleshooting (writing index checked through 2026-10-06).

---

## Thorsten Ball / Amp: new threads to escape "doom loops", feedback loops with proof, oracle as a different-vendor second opinion

### Takeaway
- **Threads:** Ball attributes many agent problems to not starting new threads often enough. He names the "doom loop": fixing the same test "over and over". He keeps threads small (things feel "blurry" past about 100k tokens).
- **Proof and git:** he demands "irrefutable proof that it works", and uses git staging so bad attempts can be wiped.
- **Oracle:** Amp's product pattern is a read-only "oracle" subagent on a different, stronger model. It was OpenAI o3, then GPT-5, now GPT-5.4. It sits beside the Anthropic main model and is reached by explicit prompting, for review, debugging and "figuring out what to do next".

### Cited Findings
**How to Build an Agent** (Ball, 2025-04-15):
- An agent is "an LLM, a loop, and enough tokens", in about 300-400 lines. — [How to Build an Agent](https://ampcode.com/how-to-build-an-agent)

**"Amp is now available. Here's how I use it."** (Ball, 2025-05-15; flagged on the page as describing an older Amp):
- Many problems "can be traced back to them not starting new threads often enough". — [How I use Amp (2025)](https://ampcode.com/notes/how-i-use-amp)
- On the doom loop: the model "tries to fix and fix and fix the same test over and over again". — [same](https://ampcode.com/notes/how-i-use-amp)
- After 100k tokens, "things start to feel blurry, imprecise". "I'll try to keep the threads ... small." — [same](https://ampcode.com/notes/how-i-use-amp)
- Git hygiene: stage what's good, "wipe the unstaged changes" otherwise. Cleanup happens in "a new thread". — [same](https://ampcode.com/notes/how-i-use-amp)
- Feedback through screenshots and console: the agent "sees errors and tries again until it works". — [same](https://ampcode.com/notes/how-i-use-amp)

**Think Harder: How I Prompt** (Laracon US talk, 2026-07-29; auto-generated transcript):
- Core question: "How is the model supposed to know what I mean?" — [Think Harder: How I Prompt](https://thorstenball.com/talks/how-i-prompt/)
- The "one-two punch": a broad investigation prompt, then a specific ask. — [same](https://thorstenball.com/talks/how-i-prompt/)
- "90% of my prompts have screenshots in them". Storybook verification "worked for 15 minutes". — [same](https://thorstenball.com/talks/how-i-prompt/)

**How I use Amp, current profile** ("Last updated September 23, 2026"; its embedded capsule is dated 2026-10-13):
- He asks agents to "test everything" and give "irrefutable proof that it works". — [Thorsten's profile](https://ampcode.com/docs/using-amp/thorsten)
- "Orbs as evals": one orb changes tooling and `AGENTS.md`, then spawns 3 orbs on a task that doesn't mention the change and compares their results. — [same](https://ampcode.com/docs/using-amp/thorsten)
- Models: High mode (GPT-6 Astra) is his most-used. Ultra with Fable is for UI and design work. — [same](https://ampcode.com/docs/using-amp/thorsten)

**The Amp Way** (team page, undated):
- "If the agent can't check its own work and test that something it built works, end to end, it's flying blind." — [How we work](https://ampcode.com/docs/using-amp/how-we-work)
- "A thread ends when the change has landed and we know it works, not when the code is written." — [same](https://ampcode.com/docs/using-amp/how-we-work)

**Oracle history** (Amp news posts, no author named):
- 2025-07-04: "a read-only subagent powered by ... OpenAI's o3", beside Sonnet 4 as the main agent. It is "impressively good at reviewing, at debugging, at analyzing, at figuring out what to do next". "we rely on explicit prompting to get the main agent to consult the oracle." — [Oracle (Amp news)](https://ampcode.com/news/oracle)
- 2026-03-05: the oracle is now GPT-5.4. Response quality rose "from 60.8% (GPT-5.2) to 68.2% (GPT-5.4)", and mean latency fell from about 6.7 to about 4.9 minutes. It runs alongside Opus 4.6 (smart mode main model) and GPT-5.3-Codex (deep mode main model). It brings "sage advice on architecture, code reviews, and tricky bugs". — [GPT-5.4, The New Oracle](https://ampcode.com/news/gpt-5.4-the-new-oracle)

**Related Amp guide** (by Lewis Metcalf, not Ball; 2026-02-05):
- "Agents are most powerful when they can validate their work against reality". Build playgrounds and "repeatable, deterministic experiments". — [Feedback Loopable](https://ampcode.com/notes/feedback-loopable)

### Inferences
- Amp's oracle is the clearest productized "different model as a second opinion" pattern. It is read-only, explicitly invoked, sits in a separate context, comes from a different vendor than the main agent (OpenAI oracle beside an Anthropic main model, in smart mode), and is aimed at debugging and next-step decisions.
- Ball's "doom loop" is the same failure that Claude Code's "two failed corrections then /clear" and Superpowers' 3-fix rule target. His remedy is a fresh thread.

### Gaps
- NOT FETCHED: Ball's "Putting an Agent in an Orb" (25 Aug 2026 per a search snippet, Amp blog). Its URL was not found.
- The 2025 "doom loop" note describes the problem but gives no numeric cap.
- The Amp manual intro says "GPT-5.6, Claude Fable 5.1, fast models. Amp uses them all", but the Modes & Models page was not fetched. — [Amp manual](https://ampcode.com/manual)

---

## Simon Willison: designing agentic loops with clear success criteria, budget caps, parallel agents limited by review, "first run the tests"

### Takeaway
Willison frames the job as designing the loop:
- Reduce the problem to "a clear goal and a set of tools that can iterate towards that goal".
- Pick problems with clear success criteria, sandbox the run, and cap spend (for example a $5 budget on a dedicated org).
- He runs Claude Code and Codex in parallel, but treats review as the bottleneck ("one significant change at a time").

His guide gives practices (tests first, red/green TDD, no unreviewed PRs) rather than stuck-agent procedures.

### Cited Findings
**Designing agentic loops** (2025-09-30):
- Agents are "brute force tools for finding solutions to coding problems". — [Designing agentic loops](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/)
- Reduce the problem "to a clear goal and a set of tools that can iterate towards that goal". — [same](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/)
- Choose problems with "clear success criteria" and "trial and error". — [same](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/)
- "If a credential can spend money, set a tight budget limit". He "set a $5 budget" on a dedicated Fly.io organization. — [same](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/)
- "Run your agent in a secure sandbox that restricts the files and secrets it can access". — [same](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/)

**Embracing the parallel coding agent lifestyle** (2025-10-05):
- "the natural bottleneck on all of this is how fast I can review the results". — [Parallel coding agents](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- "I can only focus on reviewing and landing one significant change at a time." — [same](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- "Code that started from your own specification is a lot less effort to review." — [same](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- "Send out a scout" (quoting Josh Bleecher Snyder): agents map hard code even when the output isn't landed. — [same](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- Tools: Claude Code (Sonnet 4.5), Codex CLI (GPT-5-Codex), and Codex Cloud for async work "frequently launched from my phone". — [same](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)

**Agentic Engineering Patterns guide** (launched 2026-02-23; chapters are undated and updated over time):
- Launch post. — [Writing about Agentic Engineering Patterns](https://simonwillison.net/2026/Feb/23/agentic-engineering-patterns/)
- Chapters include Red/green TDD, First run the tests, Agentic manual testing, Subagents, and Anti-patterns. — [Agentic Engineering Patterns index](https://simonwillison.net/guides/agentic-engineering-patterns/)
- Start sessions with "First run the tests". "Automated tests are no longer optional when working with coding agents." — [First run the tests](https://simonwillison.net/guides/agentic-engineering-patterns/first-run-the-tests/)
- "Don't file pull requests with code you haven't reviewed yourself". "Several small PRs beats one big one". "Agents write convincing looking pull request descriptions." — [Anti-patterns](https://simonwillison.net/guides/agentic-engineering-patterns/anti-patterns/)

### Inferences
- Willison's contribution to bounding is upfront: choose loop-shaped problems, give tools, cap money, sandbox. He does not publish a mid-run "stuck" protocol.
- He uses both vendors side by side as parallel agents, not as checker and maker.

### Gaps
- None of the fetched Willison pages gives a numeric stuck or stop rule (attempts or minutes).
- I did not fetch the Subagents or Red/green TDD chapters in full.

---

## Cross-cutting: who uses OpenAI and Anthropic models together, and how they split roles

### Takeaway
Four splits recur:
- **Anthropic builds, OpenAI or Codex finishes or advises.** Ronacher and Amp do this.
- **OpenAI or Codex is the primary, Anthropic does UI and design.** Ball's current setup does this.
- **Parallel independent agents from both vendors.** Willison and Hashimoto do this.
- **A different-family model as the adversarial reviewer.** pstack does this with Opus plus Grok, and Huntley's guide does it with GPT or Gemini as example reviewers.

Boris Cherny's published setup is Anthropic-only.

### Cited Findings
- **Ronacher:**
  - Claude Opus 4.5 did the initial port, then GPT-5.2 Codex took "the long tail of test fixing". — [MiniJinja Go port](https://lucumr.pocoo.org/2026/1/14/minijinja-go-port/)
  - Codex models did not show the edit-schema regression he saw on Opus 4.8 and Sonnet 5. — [Better Models: Worse Tools](https://lucumr.pocoo.org/2026/7/4/better-models-worse-tools/)
- **Amp product (Ball's team):**
  - The oracle is an OpenAI model: o3 in 2025-07, GPT-5 next, GPT-5.4 as of 2026-03-05. — [Oracle](https://ampcode.com/news/oracle)
  - It advises an Anthropic main agent (Sonnet 4, later Opus 4.6 in smart mode). It also sits in deep mode beside GPT-5.3-Codex. — [GPT-5.4, The New Oracle](https://ampcode.com/news/gpt-5.4-the-new-oracle)
- **Ball personally:** High mode (GPT-6 Astra) is his most-used. Ultra with Fable is for UI and design. — [Thorsten's profile](https://ampcode.com/docs/using-amp/thorsten)
- **Hashimoto:**
  - Claude Code plus Amp deep mode ("basically just GPT-5.2-Codex"). — [My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
  - Amp's oracle for planning and the final check. — [Non-trivial vibing](https://mitchellh.com/writing/non-trivial-vibing)
- **Willison:** Claude Code (Sonnet 4.5) as his main local agent, plus Codex CLI (GPT-5-Codex) and Codex Cloud for async work. — [Parallel coding agents](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- **Huntley:** Opus and Sonnet in the loop, with GPT 5.1 and Gemini 3.0 Flash as example LLM reviewers. — [how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)
- **pstack:**
  - Opus 5.5 for judgment and the hardest changes, Grok for code delegates, with an Opus plus Grok review panel. — [pstack README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
  - The swap-in mechanism is per-role lines written by `/setup-pstack`. — [poteto-mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
- **Superpowers:** model selection is by capability tier, not vendor. 6.4 adds non-Claude harnesses. — [subagent-driven-development](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md); [blog.fsck.com](https://blog.fsck.com/)
- **Cherny:** "I use Opus 4.5 with thinking for everything." — [Threadreader](https://threadreaderapp.com/thread/2007179832300581177.html)

### Inferences
- For an operator running Codex and Claude, three combinations carry published evidence:
  - **Amp oracle:** the main agent plus a read-only, other-vendor advisor, called explicitly on review, debugging, or "what next".
  - **pstack interrogate:** the same prompt sent to each family, with findings both families raise treated as the highest signal.
  - **Ronacher handoff:** one model builds the structure, and the other grinds the long tail against a fixed test oracle.

### Gaps
- None of these practitioners publishes a controlled comparison showing that cross-vendor review beats same-vendor fresh-context review. Amp's 60.8% to 68.2% figure compares oracle versions, not vendors.

---

## Cross-cutting: numeric rules of thumb for "stuck", with sources

### Takeaway
The published thresholds converge on 2-3 failed attempts before changing the frame: a new premise, a new context, an architecture question, or a stronger model. Hard caps sit in the harness.

### Cited Findings
**Failed-attempt thresholds:**
- Claude Code docs: after 2 failed corrections, `/clear` and rewrite the prompt instead of a 3rd. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- pstack: 2 or more fixes sharing one premise that fail the same gate means writing the premise down and testing it before any further fix. — [attack-the-premise](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-attack-the-premise/SKILL.md)
- Superpowers debugging: 3 or more failed fixes means stop, question the architecture, and discuss with the human. No Fix #4. — [systematic-debugging](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Superpowers review-fix loop: at most 5 rounds. Rounds 4-5 use a fresh implementer one tier up. At the cap, the controller adjudicates and records a ruling. — [fix-loop.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/references/fix-loop.md)
- pstack babysit: 1 CI retry for flake; an identical second failure means it was never flake. Lean toward dismissing review-bot findings from the 3rd pass on. — [babysit.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/babysit.md)

**Harness and budget caps:**
- Claude Code Stop hook: blocks are overridden after 8 consecutive blocks with no tool call. Unattended runs use `--max-turns` and `--max-budget-usd`. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Huntley: one task per loop, `./loop.sh 20` as the example iteration cap, a 40-60% context "smart zone", and 1 subagent for build and test. — [how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum); [Ralph](https://ghuntley.com/ralph/)
- Willison: a $5 budget on a dedicated cloud org for a loop with spend access. — [Designing agentic loops](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/)

**Time and context limits:**
- Ball: threads feel "blurry" past about 100k tokens, so keep threads small and start new ones. — [How I use Amp (2025)](https://ampcode.com/notes/how-i-use-amp)
- Superpowers: idle waits are bounded at 5-10 minutes, followed by a status line and reconciliation. — [subagent-driven-development](https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md)
- Hashimoto: a 30-minute end-of-day agent block, with tasks usually done in under 30 minutes. — [My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
- pstack figure-it-out: "a multi-hour run earns one checkpoint". — [figure-it-out](https://github.com/cursor/plugins/blob/main/pstack/skills/figure-it-out/SKILL.md)

**Counter-examples (what happens without bounds):**
- Ronacher's 35-hour, roughly $1,200 factory run produced nothing of value. — [Astra for Coding](https://lucumr.pocoo.org/2026/9/7/astra-why/)
- Ronacher's MiniJinja run (10 hours, 45 minutes of human time, $60) succeeded with a test-defined goal. — [MiniJinja Go port](https://lucumr.pocoo.org/2026/1/14/minijinja-go-port/)

### Inferences
- "Who has the answer", by question:
  - **Thresholds and caps:** Jesse Vincent (Superpowers) and Lauren Tan (pstack).
  - **Steering controls and harness enforcement:** the Claude Code team.
  - **Why runs diverge, and the environment fix:** Ronacher.
  - **Loop structure:** Huntley.
  - **Different-vendor second opinion:** Amp (Ball, and Hashimoto as a user).
  - **Choosing loop-shaped problems and budgeting:** Willison.

### Gaps
- No practitioner publishes a wall-clock cap in minutes for a single stuck troubleshooting attempt. Time figures are cadence or observed durations, not stop rules.
- Pstack's "never relax the predicate / plateau is not a stop" and Superpowers' "stop when every path forward is a guess" are the closest published convergence criteria. Neither is quantified.
