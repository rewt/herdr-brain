# Bounded autonomous troubleshooting: loop structures, stop conditions and escalation rules for AI coding agents

Research date: 2026-10-26. Every URL below was fetched on that date unless marked otherwise. Source dates are given inline. Quotes are copied from the fetched text; numbers are as the source reports them.

## 1. Fixed pipelines vs open-ended agents for repair (Agentless, SWE-agent, AutoCodeRover, OpenHands): step structure, attempt budgets, validation, and what makes them converge

### Takeaway
The systems that converge do so through hard structure. They use a fixed localize-then-repair-then-validate order, a small fixed number of retrieval rounds and patch attempts, a capped interface (limited search results, a 100-line viewer, edits rejected when they fail lint), a dollar budget that forces a submit, and an external test oracle to pick the winner. The trajectory data agrees: resolved runs are short (median 12 steps), and the odds of success fall sharply after the first failed attempt.

### Cited Findings
**Agentless (fixed pipeline, no agent).** Source: arXiv:2407.01489v2, dated 29 Oct 2024.
- It runs three fixed phases: localization, repair and patch validation. The LLM never chooses its next action or uses tools. — [Agentless](https://arxiv.org/html/2407.01489v2)
- Localization is hierarchical, from files to classes/functions to edit locations:
  - Files: the LLM ranks suspicious files from the repo tree, and embedding retrieval runs on the files it does not mark irrelevant. The two lists are intersected, and the default keeps the top 3 files.
  - Classes/functions: the LLM sees a skeleton of declarations and signatures only.
  - Edit locations: the LLM names lines, functions or classes. The default draws 4 separate location sets per issue. — [Agentless](https://arxiv.org/html/2407.01489v2)
- Repair: each location set gets ±10 lines of context and produces 10 patches (1 greedy plus 9 sampled at temperature 0.8). That gives 40 candidate patches per issue, written in Search/Replace diff format. — [Agentless](https://arxiv.org/html/2407.01489v2)
- Validation works in four steps:
  1. The LLM writes 40 candidate reproduction tests. A test is kept only if it prints "Issue reproduced" on the unpatched repo, and the most frequent normalized test is chosen.
  2. The existing test suite is run as a regression set, minus tests the fix may legitimately change.
  3. Patches with the fewest regression failures advance. Of those, only patches that print "Issue resolved" are kept. If none pass, selection falls back to the regression results.
  4. Patches are normalized via the AST and the most frequent one is submitted (majority vote). — [Agentless](https://arxiv.org/html/2407.01489v2)
- Result: 96/300 (32.00%) on SWE-bench Lite with GPT-4o, at an average of $0.70 and about 78,166 tokens per issue. — [Agentless](https://arxiv.org/html/2407.01489v2)
- The paper's critique of agents names three problems:
  - Tool complexity leads to "incorrect or imprecise tool design/usage".
  - Lack of control: an issue can take "upwards of 30 or 40 turns".
  - Weak self-reflection: "an incorrect step can be easily amplified" into all later steps. — [Agentless](https://arxiv.org/html/2407.01489v2)

**SWE-agent (agent-computer interface, ACI).** Source: arXiv:2405.15793v3, dated 11 Nov 2024.
- It has four ACI principles: "Actions should be simple and easy to understand for agents"; "Actions should be compact and efficient"; "Environment feedback should be informative but concise"; "Guardrails mitigate error propagation and hasten recovery." — [SWE-agent](https://arxiv.org/html/2405.15793)
- The file viewer shows "a window of at most 100 lines". In the ablation (SWE-bench Lite, GPT-4 Turbo), 100 lines scored 18.0%, 30 lines scored 14.3% and the full file scored 12.7%. — [SWE-agent](https://arxiv.org/html/2405.15793)
- Search returns "at most 50 results". If a query exceeds that, no results are shown and the agent is told to write a more specific query. Summarized search scored 18.0%, iterative search 12.0% and no search 15.7%. — [SWE-agent](https://arxiv.org/html/2405.15793)
- The edit guardrail runs flake8 and reverts edits that introduce syntax errors. Without linting the score was 15.0%, against 18.0% with it. With no edit command it was 10.3%. — [SWE-agent](https://arxiv.org/html/2405.15793)
- Context management: "observations preceding the last 5 are each collapsed into a single line". Keeping only the last 5 observations scored 18.0%, against 15.0% for the full history. Past error messages are omitted except the first. — [SWE-agent](https://arxiv.org/html/2405.15793)
- Budget: $4 per instance. "If a run exceeded this budget, existing edits were submitted automatically." — [SWE-agent](https://arxiv.org/html/2405.15793)
- Length of resolved vs unresolved runs (verbatim): "successful instances solved by SWE-agent w/ GPT 4 finish with a median cost of $1.21 and 12 steps compared to a mean of $2.52 and 21 steps for unsuccessful ones". "93.0% of resolved instances are submitted before exhausting their cost budget" (versus 69.0% of all instances). — [SWE-agent](https://arxiv.org/html/2405.15793)
- Decay after a failure: 51.7% of GPT-4 Turbo trajectories "have 1+ failed edits". "Any attempt at editing has a 90.5% chance of eventually being successful. This probability drops off to 57.2% after a single failed edit." — [SWE-agent](https://arxiv.org/html/2405.15793)
- Loops: "A prominent failure mode occurs when models repeatedly edit the same code snippet. The usual suspect for this behavior is an agent introducing a syntax error … via an errant edit." "Cascading failed edits make up another 23.4% of failures." About 52.0% of the 248 unresolved Lite trajectories were incorrect or overly specific implementations. — [SWE-agent](https://arxiv.org/html/2405.15793)

**AutoCodeRover (two-stage agent with bounded retrieval).** Source: arXiv:2404.05427v3, dated 25 Jul 2024, ISSTA '24.
- Stage 1, context retrieval: AST-based search APIs (search_class, search_method_in_class, search_code and others) are run in "strata". At each stratum the LLM picks the API calls it needs, then judges whether the context is sufficient. If it is, the LLM names the buggy locations. — [AutoCodeRover](https://arxiv.org/html/2404.05427v3)
- Hard stop: the run terminates when "a patch is generated or the context retrieval stage repeats ten times." — [AutoCodeRover](https://arxiv.org/html/2404.05427v3)
- Stage 2, patch generation: a separate agent writes the patch. It retries when the patch is malformed, fails to apply or fails lint. The limit is "currently set to three"; after that, the best patch so far is returned. — [AutoCodeRover](https://arxiv.org/html/2404.05427v3)
- When tests exist, spectrum-based fault localization supplies the top 5 suspicious methods as hints at the start of retrieval, and the test suite validates patches inside the 3-try loop. ACR-sbfl scored 22.00% (66/300), at 250 s and $0.47 on average. — [AutoCodeRover](https://arxiv.org/html/2404.05427v3)
- Results on SWE-bench Lite: @1 19.00% at 195 s, 37k tokens and $0.43; @3 26.00% at 520 s and $1.30. The SWE-agent baseline reported in the paper is 18.00%. — [AutoCodeRover](https://arxiv.org/html/2404.05427v3)

**OpenHands / CodeAct (open-ended generalist).** Source: arXiv:2407.16741v3, dated 18 Apr 2025.
- The loop: state is an event stream of actions and observations. Each step emits one action (IPython, bash or browser), which runs in a Docker sandbox and returns an observation. "The user may interrupt the agent at any moment." — [OpenHands](https://arxiv.org/html/2407.16741)
- The state tracks "the accumulative cost of LLM calls". An AgentDelegateAction hands a subtask to another agent, for example to BrowsingAgent. — [OpenHands](https://arxiv.org/html/2407.16741)
- The only iteration cap stated in the paper is for MINT: "up to five iterations with two chances to propose solutions." The visible paper text gives no default iteration cap or stuck detection. — [OpenHands](https://arxiv.org/html/2407.16741)
- SWE-bench Lite (CodeActAgent v1.8, Table 4): claude-3-5-sonnet 26.0% at $1.10; gpt-4o 22.0% at $1.72. The authors write: "Current agent suffers a lot when editing long files." — [OpenHands](https://arxiv.org/html/2407.16741)
- Stuck detection in the current OpenHands SDK (undated docs page) is on by default and "can automatically halt execution." It detects five patterns:
  - the same action producing the same observation 4 or more times;
  - the same action producing errors 3 or more times;
  - an agent monologue of 3 or more consecutive messages;
  - an alternating ping-pong between two action-observation pairs for 6 or more cycles;
  - repeated context-window errors. — [OpenHands stuck detector docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)
- These thresholds were hardcoded and caused false positives on intended polling: 4 identical polls (every 5 min for 15 min) ended a run with "Agent stuck in loop". Issue #762 (opened 16 Oct 2025 by neubig) asked for configurable thresholds and was closed as completed on 18 Dec 2025 via PR #763. — [OpenHands issue #762](https://github.com/OpenHands/software-agent-sdk/issues/762)

### Inferences
- Every converging system puts a number on every loop: 10 retrieval rounds and 3 patch tries (AutoCodeRover); $4 then forced submit (SWE-agent); 40 candidates then a vote (Agentless); 3 repeated errors or 4 repeated observations then halt (OpenHands). None has an open-ended "keep verifying until certain" step. Verification is a single external oracle (reproduction plus regression tests) applied once to the candidates.
- The trajectory data supports a step-count tripwire. Resolved SWE-agent runs had a median of 12 steps and unresolved runs a mean of 21. After one failed edit, eventual success dropped from 90.5% to 57.2%. A run that has gone well past the typical resolved length, or has failed the same action twice, is statistically in the losing population. That makes it a cue to stop and re-plan, not to try harder.
- Agentless localizes to files, then functions, then lines before any repair. That is the structural answer to "proving" around the edges: the pipeline only examines what the localization step names, and the repair step can't widen it.
- The OpenHands polling false positive is a caution for any stuck detector: legitimate waits (polling a lock or a long job) need to be exempted or given their own threshold, or the detector itself ends runs early.

### Gaps
- OpenHands' default per-task iteration cap (the `max_iterations` setting) is not stated in the fetched paper text. The raw `stuck.py` source at the guessed GitHub path returned 404, so the thresholds come from the SDK docs and issue #762, not from code.
- Agentless's latest version (and any FSE 2025 camera-ready changes) was not checked beyond v2.
- No source isolates how much each cap individually contributes to convergence. The ablations cover interface features (viewer size, search, lint, history), not the retry counts.

## 2. Anthropic guidance: "Building effective agents", the multi-agent research system, and Claude Code best practices on explore/plan/code and course correction

### Takeaway
Anthropic's guidance has three parts. Use the simplest structure that works. Ground each agent step in feedback from the environment, with explicit stopping conditions and human checkpoints. Scale effort to query complexity with hard tiers written into the prompt. The current Claude Code docs add specific, numbered rules: after two failed corrections, `/clear` and re-prompt; give the agent a pass/fail check; cap unattended runs with `--max-turns`/`--max-budget-usd`. The current model guides also warn that legacy "verify again" instructions now cause over-verification.

### Cited Findings
**"Building effective agents"** (Dec 19, 2024; the page now carries a note that tooling has changed since then).
- "Workflows are systems where LLMs and tools are orchestrated through predefined code paths". Agents, by contrast, direct their own processes and tool use. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- It advises "finding the simplest solution possible, and only increasing complexity when needed." — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Patterns: prompt chaining (programmatic "gate" checks on intermediate steps), routing, parallelization (sectioning and voting), orchestrator-workers, and evaluator-optimizer ("one LLM call generates a response while another provides evaluation and feedback in a loop"). — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Agents should "gain 'ground truth' from the environment at each step". "Agents can then pause for human feedback at checkpoints or when encountering blockers". Builders commonly "include stopping conditions (such as a maximum number of iterations)". — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- On coding: "Code solutions are verifiable through automated tests" and "Agents can iterate on solutions using test results as feedback." On tools: "Poka-yoke your tools. Change the arguments so that it is harder to make mistakes." — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

**"How we built our multi-agent research system"** (Jun 13, 2025).
- Effort-scaling rules are written into the prompts: "Simple fact-finding requires just 1 agent with 3-10 tool calls". Direct comparisons get 2-4 subagents, and complex research more than 10 subagents. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Early failure modes:
  - spawning 50 subagents for simple queries;
  - "scouring the web endlessly for nonexistent sources";
  - agents distracting each other with excessive updates;
  - duplicated work, where one subagent covered the 2021 chip crisis while two others both covered 2025 supply chains. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- A delegation brief needs "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." Agents should "start with short, broad queries" and then narrow. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Other findings:
  - "token usage by itself explains 80% of the variance" (BrowseComp).
  - "Agents are stateful and errors compound", so the team resumes from the point of failure with checkpoints rather than restarting.
  - Evaluation started with about 20 queries and an LLM judge, and favors end-state evaluation over step-by-step checks.
  - The post states no explicit numeric stop criterion for the lead agent; it exits when it judges it has enough. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

**"Effective harnesses for long-running agents"** (Nov 26, 2025, Justin Young).
- Failure modes:
  - the agent "tended to try to do too much at once—essentially to attempt to one-shot the app";
  - later sessions would "declare the job done";
  - "Claude's tendency to mark a feature as complete without proper testing";
  - sessions left "a feature half-implemented and undocumented". — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Fixes:
  - a feature-list JSON where every entry starts at `"passes": false`, and agents may change only that status ("It is unacceptable to remove or edit tests…");
  - one feature per session;
  - a progress file plus git commits;
  - an init.sh script;
  - end-to-end tests "as a human user would".
  - Each session starts by running `pwd`, reading the git log and progress file, picking the top failing feature, and running a basic end-to-end test before new work. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Claude Code best practices** (live page code.claude.com/docs/en/best-practices, undated, written for Opus 5.5; fetched 2026-10-26).
- Course-correction rule: "Watch the first minute, press `Esc` the moment Claude drifts, and after two failed corrections run `/clear` and write a better prompt instead of a third." Rationale: "a third correction mostly adds to a conversation that already contains two failed attempts for Claude to keep re-reading. `/clear` plus one new prompt that folds in what you learned works better almost every time." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- `Esc` stops mid-action and keeps the work. `/rewind` (or Esc twice) rolls code and/or conversation back to a checkpoint. Checkpoints do not cover files changed only by Bash. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Checks: "Claude stops when the work looks done. If it has nothing to run that tells it whether the work actually *is* done, 'looks done' is all it has to go on." Give it "something it can run that comes back pass or fail". Ask for *evidence*: "the command it ran and its output". — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Enforcement ladder for done-checks: from a prompt line, to `/goal` (a separate model checks the condition after every turn), to a `Stop` hook (exit code 2 blocks the stop), to `/code-review` in a fresh subagent. A Stop hook that blocks "eight stops in a row" with no tool call in between is overridden; the cap is set by `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Five questions before an unattended run:
  1. Does it know what done looks like?
  2. Can it check its own work?
  3. What is it allowed to touch?
  4. "What stops it? `--max-turns`, `--max-budget-usd`, a spend limit."
  5. Where does the result go, and who signs off? — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Retired advice: "Tell Claude to keep going, loop until done, don't be lazy … lines like that are more likely to cause over-work than fix a stall." Also: "Handing the same task to a subagent doesn't make the answer any better. A fresh reviewer does help". — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Plan mode: "Claude reads files and proposes a plan but makes no edits until you approve" (`--permission-mode plan` or Shift+Tab). Research can be delegated: "use a subagent to investigate … so only the findings come back." The bug-fix recipe tip: "Tell Claude the command to reproduce the issue and get a stack trace." — [Claude Code common workflows](https://code.claude.com/docs/en/common-workflows)

**Claude prompting guides** (platform.claude.com, live and undated).
- On over-verification, from the Opus 5 guide: "Claude Opus 5 verifies its own work without being told to. If your prompt contains explicit verification instructions ('include a final verification step for any non-trivial task,' 'use a subagent to verify'), remove them: instructions like these cause over-verification on Claude Opus 5, and removing them reduces wasted tokens with no loss in quality. The same applies to legacy harness scaffolding that adds separate verification steps." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- On scope, also from the Opus 5 guide: "Claude Opus 5 can also expand the scope of a task". The sample prompt reads: "Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check in only when different readings of the request would lead to materially different work… stop short of actions that are clearly beyond what was asked." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- On subagents and self-correction, also from the Opus 5 guide: "Do not delegate work you can finish yourself in a handful of tool calls, and do not use subagents to verify or double-check your own work." The guide also says to avoid instructing re-checks like "double-check your answer", which "add cost without improving results." Deterministic caps: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, SDK `max_budget_usd`. — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Commit-to-an-approach sample prompt from the general guide: "choose an approach and commit to it. Avoid revisiting decisions unless you encounter new information that directly contradicts your reasoning." — [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Safety boundary from the same guide: local, reversible actions are encouraged. Destructive, hard-to-reverse or shared-visibility actions need confirmation. "When encountering obstacles, do not use destructive actions as a shortcut." — [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Overeagerness sample prompt from the same guide: "Only make changes that are directly requested or clearly necessary… A bug fix doesn't need surrounding code cleaned up." — [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

### Inferences
- Anthropic's "two failed corrections, then reset with a better prompt" and Superpowers' "three failed fixes, then question the architecture" are the same mechanism at different levels. Neither says to try again. Both say to stop accumulating failed context and re-frame.
- The Opus 5 guide states that extra verification instructions and harness verification steps cause over-verification "with no loss in quality" when removed. That is direct vendor evidence against layering re-proof steps onto routine facts. Mandatory multi-step "proof" scaffolds around a simple action (such as proving a stale-lock owner is dead) are the kind of legacy scaffolding it says to remove.
- The deterministic/non-deterministic split in the Claude Code docs suggests where hard stops belong. Turn/spend caps and stuck thresholds should be harness-enforced (`--max-turns`, hooks, SDK caps). Effort and scope judgment stay with the model.

### Gaps
- The original April 2025 post "Claude Code: Best practices for agentic coding" (anthropic.com/engineering/claude-code-best-practices) now 308-redirects to the live docs, and the live page no longer contains its "Explore, plan, code, commit" sequence. web.archive.org could not be fetched. A search-index snippet describes an earlier docs version with Explore (read-only, plan mode), Plan, Implement and Commit phases and a context-filling rationale; that version could not be verified on the live page.
- The multi-agent post gives no numeric stop rule for the lead agent beyond the effort tiers.

## 3. OpenAI: practical guide to building agents, and Codex guidance on task scoping, guardrails and handing back to a human

### Takeaway
OpenAI's guide defines the run loop by its exit conditions (a final-output tool, no tool calls, errors, or max turns). It names "exceeding failure thresholds" (limits on retries or actions) and high-risk actions as the two triggers for handing back to a human. The GPT-5 prompting guide supplies the most concrete published anti-rabbit-hole prompt: an early-stop criterion for context gathering, one escalation batch, then proceed. Its maximal setting is "an absolute maximum of 2 tool calls". Codex guidance scopes each task with Goal/Context/Constraints/Done-when, and the ExecPlans recipe has a validation step for every milestone.

### Cited Findings
**"A practical guide to building agents"** (PDF; release date April 2025 per secondary coverage; the PDF text was extracted locally).
- "Every orchestration approach needs the concept of a 'run', typically implemented as a loop that lets agents operate until an exit condition is reached. Common exit conditions include tool calls, a certain structured output, errors, or reaching a maximum number of turns." In the Agents SDK, `Runner.run()` loops until "A final-output tool is invoked" or "The model returns a response without any tool calls". — [OpenAI practical guide (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- When to build an agent: prioritize complex decisions, rules that are hard to maintain, and unstructured data. "Otherwise, a deterministic solution may suffice." — [OpenAI practical guide (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- "Our general recommendation is to maximize a single agent's capabilities first." Some deployments manage "more than 15 well-defined, distinct tools while others struggle with fewer than 10 overlapping tools." — [OpenAI practical guide (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- Tool safeguards: each tool gets "a rating—low, medium, or high—based on factors like read-only vs. write access, reversibility, required account permissions, and financial impact", which can trigger "pausing for guardrail checks before executing high-risk functions or escalating to a human". — [OpenAI practical guide (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- Human intervention: "For a coding agent, this means handing control back to the user." There are two triggers. "Exceeding failure thresholds: Set limits on agent retries or actions. If the agent exceeds these limits (e.g., fails to understand customer intent after multiple attempts), escalate to human intervention." "High-risk actions: Actions that are sensitive, irreversible, or have high stakes should trigger human oversight until confidence in the agent's reliability grows." — [OpenAI practical guide (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- Release date: secondary coverage reports April 2025. — [Maginative](https://www.maginative.com/article/how-to-build-ai-agents-a-detailed-practical-guide-from-openai/) (secondary; not opened)

**GPT-5 prompting guide** (developers.openai.com cookbook; the page is marked archived and undated).
- Less-eagerness prompt: "Goal: Get enough context fast. Parallelize discovery and stop as soon as you can act." — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- Early-stop criteria: "You can name exact content to change", and "Top hits converge (~70%) on one area/path". — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- Escalate once: if signals conflict or scope is unclear, run one refined parallel batch, then proceed. — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- Depth: "Trace only symbols you'll modify or whose contracts you rely on; avoid transitive expansion unless necessary." — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- Budget: "Usually, this means an absolute maximum of 2 tool calls." The escape hatch is to proceed "even if it might not be fully correct". — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- Hand-back thresholds: "outline safe versus unsafe actions, and define when, if ever, it's acceptable for the model to hand back to the user". For example, "the delete file tool should have a much lower threshold than a grep search tool." — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- Cursor's experience: a "maximize_"-style thoroughness prompt "often caused the model to overuse tools by calling search repetitively" on small tasks. Softening it improved decisions. — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)

**Codex best practices** (learn.chatgpt.com, undated; references GPT-6 models).
- "A good default is to include four things in your prompt": Goal, Context, Constraints, and Done when ("What should be true before the task is complete", for example tests pass or the bug no longer reproduces). This "helps Codex stay scoped, make fewer assumptions". — [Codex best practices](https://learn.chatgpt.com/docs/learn/best-practices)
- "Plan mode lets Codex gather context, ask clarifying questions, and build a stronger plan before implementation". Use a PLANS.md/execution-plan template for multi-step work. — [Codex best practices](https://learn.chatgpt.com/docs/learn/best-practices)
- Common mistakes and fixes: not telling the agent how to run builds/tests; skipping planning on complex tasks; repeating the same mistake (fix: "ask for a retrospective and update `AGENTS.md`"). "Many quality issues are really setup issues." — [Codex best practices](https://learn.chatgpt.com/docs/learn/best-practices)
- The page does not define explicit stop or escalation thresholds. — [Codex best practices](https://learn.chatgpt.com/docs/learn/best-practices)

**Codex ExecPlans recipe** (undated, archived).
- Each milestone must be "independently verifiable", and "Validation is not optional." The agent should not "prompt the user for 'next steps'" but "simply proceed to the next milestone". — [Codex ExecPlans](https://developers.openai.com/cookbook/articles/codex_exec_plans)
- It encourages "explicit prototyping milestones when they de-risk a larger change" and says to "Be idempotent and safe". It requires living sections: Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective. A similar plan let Codex "work for more than seven hours from a single prompt". — [Codex ExecPlans](https://developers.openai.com/cookbook/articles/codex_exec_plans)

### Inferences
- OpenAI's "failure threshold" trigger is a count of retries or actions, not a confidence level. Combined with the tool risk ratings, this gives a two-axis escalation rule: stop and hand back after N failed attempts, and stop before any high-risk action. Read-only diagnosis of a low-risk fact (for example, whether a PID is alive) sits at the low-risk end and warrants a high threshold for asking. Removing a lock is a write, but it is local and recoverable, so it would rate medium at most.
- The GPT-5 early-stop criteria ("can name exact content to change"; "~70% convergence") are a usable definition of "enough evidence to act". They reject certainty as the bar.

### Gaps
- The OpenAI PDF has no visible date. April 2025 comes only from secondary coverage, and the official announcement page was not fetched.
- The GPT-5 prompting guide and ExecPlans pages are undated on the fetched copies; their original publication dates were not verified.
- No OpenAI source gives a specific numeric retry threshold for coding agents. The guide says only "multiple attempts".
- A fetch of `learn.chatgpt.com/guides/best-practices.md` returned 404; the HTML page at `/docs/learn/best-practices` was used instead.

## 4. Hypothesis-driven debugging and root-cause discipline; published "stop after N attempts" / "timebox then escalate" rules and their evidence

### Takeaway
Superpowers' systematic-debugging skill is the most explicit published discipline. It requires root-cause investigation before any fix, one written hypothesis at a time with a single-variable test, and a hard stop after 3 failed fixes to question the architecture with the human. Empirical work on LLM debugging supports a low N: debugging effectiveness decays exponentially, with "60-80%" lost "within just 2-3 attempts", and SWE-agent's edit-success odds drop from 90.5% to 57.2% after one failure. Independent feedback beats self-repair. The evidence supports a small numeric cap followed by a fresh start or escalation, not open-ended persistence.

### Cited Findings
**Superpowers `systematic-debugging` skill** (github.com/obra/superpowers; the file was last touched by the v7.0.0 release commit on 2026-10-10).
- Frontmatter: "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes". The Iron Law: "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST." — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md); [commit history](https://api.github.com/repos/obra/superpowers/commits?path=skills/systematic-debugging/SKILL.md&per_page=5)
- Phase 1, root cause: read errors and stack traces completely; reproduce consistently, and if it can't be reproduced, gather data rather than guess; check recent changes; in multi-component systems, add diagnostic logging at each component boundary; trace bad values backward to their source. — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Phase 2, pattern: find a working example in the codebase and list every difference between working and broken. — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Phase 3, hypothesis: state one hypothesis ("I think X is the root cause because Y") and write it down. Make the smallest change, one variable at a time. If it fails, form a new hypothesis rather than stacking fixes. — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Phase 4, implementation: write a failing test first, then one fix at the root cause with no unrelated cleanup, then verify. — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Stop rule: count the failed fixes. Under 3, return to Phase 1 with the new information. At 3 or more, stop and question the architecture, and don't attempt a fourth fix without discussing it with the human partner. The skill treats this as a sign of wrong architecture, not of a bad hypothesis. — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Other stop triggers: each fix exposes new coupling or symptoms elsewhere; fixes require massive refactoring; the partner signals guessing ("Stop guessing", "We're stuck?"). — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- Red flags that mean "return to Phase 1": "quick fix for now", "just try changing X", bundled changes, skipped tests. The rationalization table answers "One more fix attempt" after 2 or more failures. — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)
- "No root cause" cases: for issues that really are environmental or timing-dependent, document the investigation, add retry/timeout/error handling, and add logging. The skill asserts that 95% of "no root cause" cases come from incomplete investigation. That figure is unsourced, and the skill reports no metrics. — [SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md)

**Evidence on attempt decay and fresh starts.**
- "The Debugging Decay Index" (Adnan and Kuhn; arXiv:2506.18403 v2, 13 Jul 2025; Sci Rep 15, 2025) finds that debugging effectiveness follows exponential decay and that "most models lose 60-80% of their debugging capability within just 2-3 attempts." It proposes a "strategic fresh start" that shifts from exploitation to exploration at predicted intervention points. The abstract gives no effect size for that intervention. — [Debugging Decay Index](https://arxiv.org/abs/2506.18403)
- SWE-agent: "Any attempt at editing has a 90.5% chance of eventually being successful. This probability drops off to 57.2% after a single failed edit." — [SWE-agent](https://arxiv.org/html/2405.15793)
- "Is Self-Repair a Silver Bullet for Code Generation?" (Olausson et al., ICLR 2024; v5 2 Feb 2024): once repair cost is counted, "performance gains are often modest", vary across subsets and are sometimes absent. Self-repair is limited by the model's ability to critique its own code. Feedback from a stronger model gave substantially larger gains, and human feedback showed models still lag far behind humans at debugging. — [Self-repair](https://arxiv.org/abs/2306.09896)
- AutoCodeRover's fixed caps (retrieval repeats at most 10 times; patch attempts at most 3, then return the best so far) are a published, working timebox. — [AutoCodeRover](https://arxiv.org/html/2404.05427v3)
- OpenHands halts on the same action erroring 3 or more times, or the same action-observation repeating 4 or more times. — [OpenHands stuck detector docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)
- Claude Code: after two failed corrections, `/clear` and write one better prompt. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Claude research-prompt sample: "develop several competing hypotheses. Track your confidence levels in your progress notes … Update a hypothesis tree or research notes file". — [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

### Inferences
- The published thresholds cluster tightly: 2 failed corrections (Claude Code), 3 failed fixes (Superpowers), 3 patch tries (AutoCodeRover), 3 repeated errors (OpenHands), and decay of 60-80% within 2-3 attempts (DDI). A cap of 2-3 failed attempts on the same hypothesis, followed by a forced re-frame (fresh context, a new hypothesis, or a question to a human or supervisor), sits on that consensus.
- Superpowers bounds investigation by structure, not by time. A written hypothesis plus a single-variable test is a cheap, decisive experiment. In the stale-lock example, the hypothesis "the lock is stale because PID N is dead" is tested by one liveness check of PID N plus one check of the lock holder's identity. Once it is confirmed, the skill moves to the fix. It contains nothing that licenses repeated re-proof of an already-confirmed hypothesis.
- The self-repair result (independent feedback beats self-critique) supports escalating to a different party after N failures rather than letting the same agent keep re-checking its own reasoning.

### Gaps
- None of the 2-vs-3 thresholds is backed by a controlled agent study. DDI measures single-function code generation, not repository-scale troubleshooting. Superpowers' rule is practitioner judgment without metrics.
- No published wall-clock timebox rule (for example "escalate after 30 minutes") with evidence was found. The published caps are counts of steps, attempts or dollars.
- Superpowers' supporting files (`root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`) were referenced but not fetched.

## 5. Evidence on failure modes (loops, thrash, over-verification, scope expansion, one-blocker-at-a-time discovery) and how each was fixed

### Takeaway
Loops and repetition are measured and common: step repetition in 15.7% of MAST failures, "unaware of termination conditions" in 12.4%, and cascading failed edits in 23.4% of SWE-agent failures. The fixes that worked are structural:
- guardrails that reject bad actions at the interface (lint-on-edit);
- context collapse (keep the last 5 observations);
- stuck detectors with count thresholds;
- a high-level verification step against the task objective (+15.6%);
- choosing the trajectory that interacts with the environment over the one that keeps thinking (overthinking selection cut cost 43%).

Over-verification and scope expansion are now documented vendor-side behaviors, and the stated fix is to remove extra verification instructions and constrain scope in the prompt.

### Cited Findings
**Loops and repetition.**
- MAST taxonomy (Cemri et al., "Why Do Multi-Agent LLM Systems Fail?"; arXiv:2503.13657 v3, 26 Oct 2025; 1,600+ annotated traces from 7 frameworks; kappa = 0.88) reports these prevalences:
  - FM-1.3 Step repetition: 15.7%
  - FM-1.5 Unaware of termination conditions: 12.4%
  - FM-2.6 Reasoning-action mismatch: 13.2%
  - FM-1.1 Disobey task specification: 11.8%
  - FM-3.3 Incorrect verification: 9.1%
  - FM-3.2 No or incomplete verification: 8.2%
  - FM-2.3 Task derailment: 7.4%
  - FM-2.2 Fail to ask for clarification: 6.8%
  - FM-3.1 Premature termination: 6.2% — [MAST (HTML)](https://arxiv.org/html/2503.13657v3); [MAST abstract](https://arxiv.org/abs/2503.13657)
- MAST interventions (ChatDev): better role specification gave +9.4% task success, and a high-level verification step against the task objective gave +15.6%. The authors say "not all failure modes are resolved" and call for structural changes. — [MAST (HTML)](https://arxiv.org/html/2503.13657v3)
- SWE-agent repeated-edit loops are caused mostly by errant edits that break syntax. Fixes: a flake8 guardrail that reverts bad edits (+3.0 points) and collapsing observations older than the last 5 (+3.0 points versus full history). — [SWE-agent](https://arxiv.org/html/2405.15793)
- OpenHands' fix is a default-on stuck detector with count thresholds (4/3/3/6). Its polling false positive was addressed by making the thresholds configurable (issue #762, closed 18 Dec 2025). — [OpenHands docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector); [issue #762](https://github.com/OpenHands/software-agent-sdk/issues/762)

**Thrash, overthinking and analysis paralysis.**
- "The Danger of Overthinking" (Cuadron et al., arXiv:2502.08235, 12 Feb 2025; 4,018 SWE-bench Verified trajectories) defines three patterns:
  - Analysis Paralysis: a shift "from immediate actions to elaborate future planning".
  - Rogue Actions: chaining interdependent actions without waiting for feedback.
  - Premature Disengagement: ending a task based on internal predictions rather than "environmental feedback".
  - Finding: "higher overthinking scores correlate with decreased performance." — [Overthinking abstract](https://arxiv.org/abs/2502.08235); [Overthinking (HTML)](https://arxiv.org/html/2502.08235)
- Overthinking fix: pick the least-overthinking trajectory. For o1:
  - high effort scored 29.1% at about $1,400; low effort scored 21.0% at about $400;
  - choosing the lowest-overthinking of 2 low-effort samples scored 27.3% at about $800, a 43% cost cut against high effort;
  - choosing from 3 samples scored 30.3%.
  - Native function calling raised o1 from 29.1% to 47.7% and cut the mean overthinking score from 2.43 to 1.05.
  - The paper is internally inconsistent on the headline gain: "almost 30%" in the abstract and 25% in the conclusion. — [Overthinking (HTML)](https://arxiv.org/html/2502.08235)
- Anthropic's research system: early agents scoured "the web endlessly for nonexistent sources". The fix was effort tiers in the prompt (1 agent, 3-10 calls for simple tasks) and delegation briefs with clear task boundaries. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Cursor with GPT-5: thoroughness prompts led to search "repetitively" on small tasks. The fix was to soften them. — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)

**Over-verification.**
- Instructions such as "include a final verification step" or "use a subagent to verify" "cause over-verification on Claude Opus 5". Removing them "reduces wasted tokens with no loss in quality", and the same applies to "legacy harness scaffolding that adds separate verification steps." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- "Loop until done, don't be lazy" lines "are more likely to cause over-work than fix a stall". — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- The opposite failure is also documented: marking work complete "without proper testing" and declaring done early (Anthropic harnesses), and premature termination at 6.2% and no or incomplete verification at 8.2% (MAST). The fix is one external pass/fail check plus a request for evidence, not more self-checking. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents); [MAST (HTML)](https://arxiv.org/html/2503.13657v3); [Claude Code best practices](https://code.claude.com/docs/en/best-practices)

**Scope expansion.**
- Claude Opus 5 "can also expand the scope of a task, adding steps that weren't requested". The fix is a "Deliver what was asked, at the scope intended" prompt. — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Opus 4.5 and 4.6 tend to "overengineer by creating extra files, adding unnecessary abstractions". The fix is "Only make changes that are directly requested or clearly necessary." — [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Agents "try to do too much at once". The fix is one feature per session plus a feature list where only the `passes` flag may change. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Subagent overuse.**
- Early research agents spawned 50 subagents for simple queries. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Opus 4.6 may "spawn subagents for code exploration when a direct grep call is faster and sufficient". Opus 5 delegates more readily. The fixes are a damping prompt plus deterministic spawn, depth and spend caps. — [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices); [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)

**Finding all blockers vs one per run.**
- Each published mechanism points toward a single broad discovery pass:
  - "Parallelize discovery and stop as soon as you can act" (GPT-5 guide);
  - "start with short, broad queries" then narrow (Anthropic);
  - running the full regression suite once to find every failure before selecting a patch (Agentless);
  - plan mode and interview patterns that ask the clarifying questions up front (Codex and Claude Code). — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide); [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system); [Agentless](https://arxiv.org/html/2407.01489v2); [Codex best practices](https://learn.chatgpt.com/docs/learn/best-practices); [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Persistent state across runs (Progress, Surprises & Discoveries, Decision Log; progress.txt and tests.json) lets each run start from accumulated findings rather than rediscovering them. — [Codex ExecPlans](https://developers.openai.com/cookbook/articles/codex_exec_plans); [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Inferences
- The operator's two symptoms map onto documented failure classes:
  - Three hours of guarded proof around a simple fact is analysis paralysis plus over-verification. The documented fixes are to remove legacy verification scaffolding, give one pass/fail check with evidence, set early-stop criteria ("can name the exact change"; "can act"), and add a step or attempt cap enforced by the harness.
  - One blocker per run across 11 runs looks like serial discovery in which each run stops at the first failure. Mechanisms built for the opposite exist: a single parallel discovery batch, a full-suite run that reports every failure, and a living "Surprises & Discoveries" list carried between runs.
- The MAST +15.6% result suggests the useful verification is one check against the high-level objective ("is the original problem solved?"), not repeated low-level re-proof of intermediate facts.
- A stuck detector should count repeated identical actions or observations (for example 3-4) but exempt intentional waits. Otherwise it reproduces the OpenHands polling false positive.

### Gaps
- No published controlled study measures "serial one-blocker-per-run" discovery in coding agents, or the benefit of an enumerate-all-blockers-first step. The mapping above is inference from adjacent mechanisms.
- The MAST HTML was read only up to character 100,000. The topology intervention's numeric effect was not captured.
- The overthinking paper's claim that low-effort runs had 35% higher overthinking scores than high-effort runs was not verified against its table; the fetch summary suggested the table means differ by less.
- Pages not fetched, or fetched only partly:
  - the original April 2025 Claude Code best-practices post (redirected; archive blocked);
  - OpenHands `stuck.py` source (404 at the guessed path);
  - the remainder of the long arXiv HTML pages beyond character 100,000 (the SWE-agent and Agentless appendices).
