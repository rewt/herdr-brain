# Multi-agent and cross-model collaboration (Codex/GPT and Claude): converging instead of drifting, duplicating or expanding scope

Method note: every link below was fetched on 2026-10-26 unless marked UNFETCHED. Dates are the source's own publication date (or first-commit date for repositories). arXiv metadata and abstracts came from the arXiv API; GitHub files came from raw.githubusercontent.com at `main` on 2026-10-26. "Evidence" means a measurement; "practice" or "opinion" means a vendor or practitioner describing what they do.

## Q1. Orchestrator-worker vs peer collaboration, and when multi-agent helps or hurts troubleshooting

### Takeaway
Every primary source that reports success uses a hierarchy with a single writer per surface. One lead or planner owns the decomposition, workers get narrow tasks with boundaries, and verification is centralized. Flat peers coordinating through a shared lock file failed at Cursor. Parallel writers still fail according to Cognition (April 2026). For troubleshooting, multi-agent helps when the hypothesis space or the failing set can be partitioned (separate hypotheses, an oracle that splits failures). It hurts when every agent sees the same top symptom or the task is sequential: one controlled study measured -70% on sequential planning.

### Cited Findings
**Anthropic, "How we built our multi-agent research system" (Jun 13, 2025; Hadfield, Zhang, Lien, Scholz, Fox, Ford)** — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Orchestrator-worker. Claude Opus 4 is the lead and Claude Sonnet 4 runs the parallel subagents. The lead saves its plan to Memory because context beyond 200,000 tokens is truncated. A separate CitationAgent attributes the sources afterwards.
- Evidence: the multi-agent system "outperformed single-agent Claude Opus 4 by 90.2%" on Anthropic's internal research eval. On BrowseComp, token usage alone explained 80% of performance variance, and three factors together explained 95%. Agents use about 4x the tokens of chat, and multi-agent systems about 15x. Parallelization cut research time by up to 90% on complex queries.
- Early failures: 50 subagents spawned for simple queries, endless searches for nonexistent sources, and distracting updates. Vague delegation led subagents to misinterpret the task: one researched the 2021 chip crisis while two others duplicated work on 2025 supply chains.
- Fix: each subagent gets an objective, an output format, guidance on tools and sources, and clear task boundaries. Effort-scaling rules: simple fact-finding uses 1 agent with 3-10 tool calls; direct comparisons use 2-4 subagents with 10-15 calls each; complex research uses more than 10 subagents with divided responsibilities.
- Poor fit, per the authors: tasks that need shared context or have many inter-agent dependencies. Most coding tasks have fewer truly parallelizable parts than research. LLM agents "are not yet great at coordinating and delegating to other agents in real time."
- Execution is synchronous. "the lead agent can't steer subagents, subagents can't coordinate," and one slow subagent blocks the whole system.
- To reduce the "game of telephone," subagents "call tools to store their work in external systems, then pass lightweight references back to the coordinator."

**Cognition, "Don't Build Multi-Agents" (Jun 12, 2025; Walden Yan)** — [Cognition](https://cognition.com/blog/dont-build-multi-agents) (the cognition.ai URL 301-redirects here)
- Principle 1: "Share context, and share full agent traces, not just individual messages." Principle 2: "Actions carry implicit decisions, and conflicting decisions carry bad results."
- Flappy Bird example: one subagent builds a Super-Mario-style background and another builds a bird that doesn't match it. The actions were "based on conflicting assumptions not prescribed upfront."
- Recommendation: "just use a single-threaded linear agent." For long tasks, add a model whose purpose is to "compress a history of actions & conversation."
- Opinion: Claude Code subagents (as of June 2025) are "usually only tasked with answering a question, not writing any code."

**Cognition, "Multi-Agents: What's Actually Working" (Apr 22, 2026; Walden Yan)** — [Cognition](https://cognition.com/blog/multi-agents-working)
- The original warnings "still hold today for parallel-writer swarms." What works is a narrower class of patterns where several agents add intelligence while writes stay single-threaded.
- Working patterns: (1) a generator-verifier review loop (Devin plus Devin Review); (2) "smart friend," where the primary consults a stronger model; (3) a manager that spawns child agents, described as "map-reduce-and-manage"; (4) read-only search subagents, which "mostly resemble tool calls rather than true multi-agent collaboration."
- Open problems are "all communication problems": when a weaker model should escalate, how children surface discoveries to siblings, and how to transfer context without overloading the receiver. Managers can be overly prescriptive, agents assume they share state, and children do not write back to the manager by default.

**Cursor, "Scaling long-running autonomous coding" (Jan 14, 2026; Wilson Lin)** — [Cursor](https://cursor.com/blog/scaling-agents)
- First design: equal-status agents claiming tasks from a shared file guarded by locks. Agents held locks too long or never released them, and "Twenty agents would slow down to the effective throughput of two or three." Optimistic concurrency was simpler, but agents became risk-averse: they avoided hard tasks, made small safe changes, nobody owned end-to-end work, and work churned.
- Working design: planners explore the codebase and create tasks (and can spawn sub-planners). Workers finish tasks without coordinating with each other or tracking the big picture. A judge decides at the end of each cycle whether to continue, and the next iteration starts fresh.
- An integrator role for quality control and conflict resolution "created more bottlenecks than it solved" and was removed.
- With too little structure, "agents conflict, duplicate work, and drift"; too much structure makes the system fragile. "Periodic fresh starts" are still needed against drift and tunnel vision. Prompts mattered more than the harness or the models.
- Scale: a browser took about a week and produced more than 1M lines across about 1,000 files. A Solid-to-React migration ran for three weeks (+266K/-193K) and "still needs careful review." Limitations: planners don't wake when their tasks complete, and agents sometimes run far too long.

**Kim et al., "Towards a Science of Scaling Agent Systems" (arXiv 2512.08296; Dec 9, 2025, revised Apr 8, 2026)** — [arXiv](https://arxiv.org/abs/2512.08296)
- Evidence: 260 configurations across six agentic benchmarks, five architectures (single-agent, plus independent, centralized, decentralized and hybrid multi-agent) and three LLM families, with tools, prompts and compute held equal.
- Relative change against a single agent ranges "from +80.8% on decomposable financial reasoning to -70.0% on sequential planning."
- Coordination yields diminishing returns once the single-agent baseline is strong. Tool-heavy tasks incur multi-agent overhead. "Architectures without centralized verification tend to propagate errors more."

**Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (arXiv 2503.13657; Mar 17, 2025, revised Oct 26, 2025)** — [arXiv](https://arxiv.org/abs/2503.13657)
- Evidence: more than 1,600 annotated traces across 7 multi-agent frameworks. 14 failure modes fall into 3 categories: system design issues, inter-agent misalignment and task verification (inter-annotator kappa = 0.88). The authors note that MAS gains on popular benchmarks are "often minimal."

**Troubleshooting-specific sources**
- Claude Code agent-teams docs (live docs; feature is experimental behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) list "Debugging with competing hypotheses" as a strongest use case. The rationale: "a single agent tends to find one plausible explanation and stop looking" and "Sequential investigation suffers from anchoring." The suggested prompt has 5 teammates try "to disprove each other's theories, like a scientific debate" and "Update the findings doc with whatever consensus emerges." For "sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective." The docs advise new users to start with tasks "that don't require writing code," such as reviewing, researching or investigating a bug — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Carlini, "Building a C compiler with a team of parallel Claudes" (Feb 5, 2026): when 16 agents compiled the Linux kernel, all of them hit the same bug, fixed it and overwrote each other: "Having 16 agents running didn't help because each was stuck solving the same task." The fix used GCC as a known-good oracle. Most kernel files were compiled with GCC and a random subset with Claude's compiler, so each agent hit a different bug. Delta debugging then found pairs of files that failed only together — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Anthropic, "Effective harnesses for long-running agents" (Nov 26, 2025; Justin Young): "still unclear whether a single, general-purpose coding agent performs best across contexts." Specialized "testing agent, a quality assurance agent, or a code cleanup agent" are an open question — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Inferences
- Anthropic, Cursor and Cognition converge on one pattern: one owner of the decomposition, one writer per file, branch or worktree, and an independent verifier or judge. Peers are used only for read-only exploration or separate hypotheses.
- For troubleshooting, parallel agents pay off only after something partitions the problem: a list of hypotheses, an oracle, bisection, or sampled failing tests. Without a partition, N agents on one symptom duplicate each other, as the C-compiler kernel episode shows.
- A competing-hypotheses debate still needs a single synthesizer and a written findings document. In the agent-teams design these are the lead and the findings doc.

### Gaps
- I found no controlled study of multi-agent debugging or incident troubleshooting on real systems. The agent-teams "competing hypotheses" pattern is vendor guidance without published numbers.
- Anthropic's 90.2% figure comes from an internal research eval, not a coding or debugging eval.

## Q2. Cross-model verification and pairing (a different family as reviewer, verifier or critic)

### Takeaway
Practice is moving toward a reviewer from a different model family:
- pstack makes a different-family verifier a rule for expensive or judgment-heavy units.
- Every's plugin routes its adversarial review lens to a different-provider peer by default.
- OpenAI ships a Codex reviewer inside Claude Code.

The mechanistic case is reasonably well evidenced: self-preference bias, a self-correction blind spot, and the value of a fresh context. Direct evidence that the swap improves outcomes is thin and mixed:
- The only controlled Claude-versus-Codex study found an asymmetric effect. Claude reviewing Codex drafts gained +18.1 points; Codex reviewing Claude drafts lost 8.6 points.
- Model heterogeneity improves debate.
- Mixing in weaker models lowers ensemble quality.
- Errors are increasingly correlated across providers as models get stronger.

### Cited Findings
**pstack (cursor/plugins, path `pstack/`; author handle "poteto", listed as Lauren Tan in the plugins table; commit author "lauren"; orchestrate playbook first committed 2026-08-02; latest pstack commits 2026-10-23)** — [GitHub](https://github.com/cursor/plugins/tree/main/pstack)
- Orchestrate playbook: "One writer per worktree or branch... Run a unit's verifier on a different model family from its worker." — [orchestrate.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/orchestrate.md)
- Scope of the rule: "A dedicated verifier agent (on a different model family than the worker) is for units whose verification is expensive, judgment-laden, or high-blast-radius. A verifier agent whose entire product would be rerunning one command is ceremony, not verification." — same file
- Interrogate: "The adversarial signal comes from model diversity, not assigned personas... Do NOT auto-apply changes." — [interrogate/SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/SKILL.md)
- Design guide: "Model diversity is the point. Different models have different blind spots, so a finding two models raise independently is high-confidence signal." Findings are sorted into Act on, Consider, Noted and Dismissed, with a reason for every dismissal — [04-design.md](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/04-design.md)
- Arena judge: "Prefer a different model family from the parent's." An overnight run ends with "a reviewer on a different model family" reading the trail — [arena/SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/arena/SKILL.md); [07-overnight.md](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/07-overnight.md)
- "A second opinion is the same prompt against a different model. Agreement is high-signal." — [poteto-mode/SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
- Defaults: code delegates go to Grok (`grok-4.7-xhigh-fast`); "hardest changes, prose, and judgment go to opus 5.5"; "the default panel is opus 5.5 / grok." The README also says "use any model with pstack." The rule is therefore configured with fallbacks rather than enforced, and the default panel is Claude plus Grok, not GPT — [README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
- pstack publishes no measurement of the cross-family benefit.

**Every, compound engineering**
- Article "Compound Engineering: How Every Codes With Agents" (Dec 11, 2025; Dan Shipper and Kieran Klaassen): the plugin reviews in parallel with 12 subagents, each with a different lens (security, performance, overbuilding). "Roughly 80 percent of compound engineering is in the plan and review parts." Codex is named among "automatic code review agents like Claude, Codex, Friday, and Charlie," and Claude Code is the team's primary tool — [Every](https://every.to/source-code/compound-engineering-how-every-codes-with-agents)
- Plugin review guide (live repo): the adversarial lens "runs through one model provider different from the host, in a separate read-only process." A started peer replaces the in-process adversarial persona. Peer order is "codex → claude → grok → antigravity." `cross_model_review_mode: off` disables the pass. "Agreement between the peer and another in-process reviewer is a strong promotion signal in synthesis." Failures fall back to the local persona "without an unbounded retry loop." With no peer CLI installed, the review reports "cross-model pass: not run." On the cheaper "focused" depth, the single independent adversarial read is "normally the cross-model peer from a different model family" — [ce-code-review.md](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/guides/ce-code-review.md)
- Plan dated 2026-07-13 gives the rationale: "improve same-model self-review independence for code." The earlier fixed map was `cursor`/`claude`→`codex` and `codex`→`claude` — [plan](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/plans/2026-07-13-002-feat-code-review-cross-model-provider-port-plan.md)
- Every's own eval (2026-07-17/18) compared reasoning tiers and models within one family; it is not a cross-family test. On 10 reversed real Express bugs (n=5, 150 runs, "3-vote blind judge"), the Codex peer at medium reasoning tied high reasoning: detection 92% vs 94%, assertiveness 82% vs 84%, at about 31% fewer median tokens. The judge was the host model, "not a gpt-5.6 arm, avoids family self-preference." Every's stated scope: "JS/web code, one target repo, Opus judge" — [eval plan](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/plans/2026-07-17-001-eval-cross-model-peer-model-config.md); [method](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/solutions/skill-design/benchmark-review-peer-model-and-reasoning-tier.md)

**OpenAI, Codex plugin for Claude Code (openai/codex-plugin-cc)** — [GitHub](https://github.com/openai/codex-plugin-cc)
- `/codex:review`: "This command is read-only and will not perform any changes." `/codex:adversarial-review` is steerable, "questions the chosen implementation and design," and is read-only. `/codex:rescue` hands a task to Codex and can modify code.
- An optional review gate uses a `Stop` hook to block Claude's stop until the issues Codex found are addressed. The warning: it "can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session."
- Release date: Mar 31, 2026, according to search-result snippets from Gigazine and Ben's Bites. UNFETCHED, so not confirmed from a primary page. The repository page shows no date.

**Same-family, clean-context review (counterpoint)**
- Cognition (Apr 22, 2026): Devin Review uses the same model in a clean context. "the coding and review agents do not share any context beforehand." On same-model bias: "They don't have egos, and any shared bias that might exist ultimately comes from their training process." Measured claim: "Devin Review catches an average of 2 bugs per PR, of which roughly 58% are severe." Separately, "We've run Claude and GPT together in this setup in production," and "smart-friend works today when both models are strong." A weaker primary model (SWE-1.5) was "not good enough" — [Cognition](https://cognition.com/blog/multi-agents-working)
- Claude Code best-practices docs (live, undated): `/code-review` "reviews the diff in a fresh subagent that never saw your conversation. It isn't swayed by the reasoning that produced the code." But "by default it's the same model (or a smaller one) on the same task. You get parallelism or a fresh pair of eyes out of it, but not a smarter answer." — [Claude Code docs](https://code.claude.com/docs/en/best-practices)

**Academic evidence**
- Xiang, Zhang, Zhang, Xu, "Cross-Model LLM Code Review: Should you use Claude to review Codex or vice versa?" (arXiv 2607.21656; Jul 22, 2026) — [arXiv](https://arxiv.org/abs/2607.21656); [HTML](https://arxiv.org/html/2607.21656v1)
  - Models: Claude Opus 4.7 (in Claude Code) and GPT-5.5 (in Codex CLI), both at high reasoning effort.
  - Task set: 116 hard and medium LiveCodeBench tasks. One static review pass, and the reviewer cannot run tests.
  - Pass rates:

    | Writer | Reviewer | Pass rate | Change |
    |---|---|---|---|
    | Claude | none | 91.4% | |
    | Codex | none | 71.6% | |
    | Codex | Claude | 89.7% | +18.1 pp (p_BH=.001) |
    | Codex | Codex (self) | 84.5% | p_BH=.022 |
    | Claude | Codex | 82.8% | −8.6 pp (p_BH=.046) |
    | Claude | Claude (self) | 91.4% | unchanged |

  - Fixed vs regressed tasks: Claude reviewing Codex fixed 26 and regressed 5. Codex reviewing Claude fixed 3 and regressed 13.
  - The two cross-model orderings are not significantly different from each other (p_BH=.144), and the authors say they "do not claim that the two cross-model orderings are statistically separable."
  - Stated limitations: one model pair, competitive-programming tasks rather than repository-scale review, and a confound with the baseline capability gap.
- Song, "Cross-Context Review" (arXiv 2603.12123; Mar 12, 2026), same model throughout: 30 artifacts with 150 injected errors. A fresh-session review (F1 28.6%) beats a second same-session review (21.7%; Holm p=0.004). It is not significantly ahead of a context-aware subagent (23.8%; p=0.057) or a single self-review (27.1%; p=0.26) — [arXiv](https://arxiv.org/abs/2603.12123)
- Tsui, "Self-Correction Bench" (arXiv 2507.02778; Jul 3, 2025): 14 open-source non-reasoning models show a "64.5% Self-Correction Blind Spot." They correct an error attributed to the user but miss the identical error attributed to themselves. Appending "Wait" cuts the blind spot by 89.3% — [arXiv](https://arxiv.org/abs/2507.02778)
- Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet" (arXiv 2310.01798; Oct 2023): without external feedback, LLMs struggle to self-correct reasoning and sometimes degrade — [arXiv](https://arxiv.org/abs/2310.01798)
- Panickssery, Bowman, Feng (arXiv 2404.13076; Apr 2024): LLM evaluators recognize their own generations, and self-recognition correlates linearly with self-preference bias — [arXiv](https://arxiv.org/abs/2404.13076)
- Wataoka, Takahashi, Ri, "Self-Preference Bias in LLM-as-a-Judge" (arXiv 2410.21819; Oct 2024): GPT-4 shows significant self-preference. Judges rate lower-perplexity (more familiar) text higher "regardless of whether the outputs were self-generated" — [arXiv](https://arxiv.org/abs/2410.21819)
- Goel et al., "Great Models Think Alike and this Undermines AI Oversight" (arXiv 2502.04313; Feb 2025): LLM judges favor models similar to themselves, and "model mistakes are becoming more similar with increasing capabilities" — [arXiv](https://arxiv.org/abs/2502.04313)
- Kim, Garg, Peng, Garg, "Correlated Errors in Large Language Models" (arXiv 2506.07962; Jun 2025): across more than 350 LLMs, "models agree 60% of the time when both models err" on one leaderboard dataset. "larger and more accurate models have highly correlated errors, even with distinct architectures and providers." — [arXiv](https://arxiv.org/abs/2506.07962)
- Zhang et al., "Stop Overvaluing Multi-Agent Debate" (arXiv 2502.08788; Feb 2025): 5 debate methods on 9 benchmarks often fail to beat Chain-of-Thought or Self-Consistency. Model heterogeneity is "a universal antidote" that consistently improves them — [arXiv](https://arxiv.org/abs/2502.08788)
- Chen, Saha, Bansal, "ReConcile" (arXiv 2309.13007; Sep 2023): a round-table of diverse LLMs improves on prior baselines by up to 11.4%, and "the diversity originating from different models is critical" — [arXiv](https://arxiv.org/abs/2309.13007)
- Li et al., "Rethinking Mixture-of-Agents" (arXiv 2502.00674; Feb 2025): aggregating outputs from only the single top model (Self-MoA) beats mixing models by 6.6% on AlpacaEval 2.0 and 3.8% on average. "mixing different LLMs often lowers the average quality" — [arXiv](https://arxiv.org/abs/2502.00674). Contrast Wang et al., Mixture-of-Agents (arXiv 2406.04692; Jun 2024): 65.1% vs GPT-4o's 57.5% on AlpacaEval 2.0 — [arXiv](https://arxiv.org/abs/2406.04692)
- Liang et al., multi-agent debate (arXiv 2305.19118): "LLMs might not be a fair judge if different LLMs are used for agents" — [arXiv](https://arxiv.org/abs/2305.19118)
- Zietsman (arXiv 2603.25773; Mar 2026), a position paper with small contrived experiments: AI review is "structurally circular when executable specifications are absent," because writer and reviewer share a training distribution and fail in correlated ways — [arXiv](https://arxiv.org/abs/2603.25773)

### Inferences
- The evidence supports two mechanisms behind a cross-family reviewer: it breaks shared context, and it avoids self-preference. Clean context alone recovers part of the benefit (Cognition, Cross-Context Review). The reviewer's capability relative to the author decides the direction of the effect: a stronger reviewer lifts a weaker author's drafts, while a weaker or over-eager reviewer can regress correct work (11.2% regressions when Codex reviewed Claude).
- Practical rule supported by the sources:
  - Use one cross-family review pass for judgment-heavy or high-blast-radius units.
  - Treat cross-family agreement as the high-confidence signal (pstack, Every).
  - Never auto-apply findings.
  - Use a judge from a third family, or a blinded judge, when comparing the two families' outputs (Every's eval; Liang).
- Because errors correlate more as models improve, even across providers, a different family does not replace executable checks. Tests and specs remain the non-circular reference (Zietsman; Kim et al.).

### Gaps
- I found no controlled study of cross-family versus same-family review on repository-scale changes with tool or test access. Xiang et al. is static review on competitive programming, with a single model pair.
- pstack and Every publish no measurement of the cross-family benefit. Every's decision-grade eval compared tiers within one family.
- Current models (Opus 5.5, GPT-6.1 "Sol," which Every's docs name) have not been tested in any published cross-review study I found.

## Q3. Debate, critique and red-team: when they converge, when they loop, and what ends them

### Takeaway
Unstructured debate mostly reduces to voting. Under social pressure it can drift toward a wrong consensus. It converges when a judge or owner decides, rounds are few and fixed, and claims must be backed by executable evidence. Production tools cap explicitly:
- one review pass
- triage buckets
- no auto-apply
- bounded retries, then fall back or abandon
- discard preference-only findings against decisions already settled
- a judge that decides whether to continue

### Cited Findings
- Choi, Zhu, Li, "Debate or Vote" (arXiv 2508.17536; Aug 2025): "Majority Voting alone accounts for most of the performance gains typically attributed to MAD." Debate "induces a martingale over agents' belief trajectories, implying that debate alone does not improve expected correctness." Interventions that bias belief updates toward correction help — [arXiv](https://arxiv.org/abs/2508.17536)
- Wynn, Satija, Hadfield, "Talk Isn't Always Cheap" (arXiv 2509.05396; Sep 2025): debate can lower accuracy over time "even in settings where stronger... models outnumber their weaker counterparts." Models "shift from correct to incorrect answers in response to peer reasoning, favoring agreement over challenging flawed reasoning" (sycophancy, conformity) — [arXiv](https://arxiv.org/abs/2509.05396)
- Liang et al., "Encouraging Divergent Thinking... through Multi-Agent Debate" (arXiv 2305.19118; May 2023): self-reflection suffers "Degeneration-of-Thought." Debate needs a judge that manages the process, and "the adaptive break of debate and the modest level of 'tit for tat' state are required" — [arXiv](https://arxiv.org/abs/2305.19118)
- Smit et al., "Should we be going MAD?" (arXiv 2311.17371; Nov 2023): MAD does "not reliably outperform" self-consistency or ensembling and is sensitive to hyperparameters. Tuning agent agreement levels can make it win — [arXiv](https://arxiv.org/abs/2311.17371)
- Du et al. (arXiv 2305.14325; May 2023): multi-round debate among instances of one model improves math and strategic reasoning and reduces hallucinations — [arXiv](https://arxiv.org/abs/2305.14325)
- Khan et al., "Debating with More Persuasive LLMs Leads to More Truthful Answers" (arXiv 2402.06782; Feb 2024): with two expert debaters and a separate non-expert judge, judge accuracy reaches 76% for models and 88% for humans, against naive baselines of 48% and 60% — [arXiv](https://arxiv.org/abs/2402.06782)
- Claude Code best-practices docs: "A reviewer that's asked to find problems will always find *something*. If you fix every finding, you end up with extra abstraction layers and tests for cases that can't happen." Keep "skip style" in review prompts. "after two failed corrections run `/clear` and write a better prompt instead of a third" — [Claude Code docs](https://code.claude.com/docs/en/best-practices)
- Cognition (Apr 2026): "Often the system will loop through multiple code-review cycles, finding new bugs each time." The coding agent filters findings using its "broader context of user instructions, decisions, etc." No cap is stated — [Cognition](https://cognition.com/blog/multi-agents-working)
- OpenAI codex-plugin-cc: the review-gate loop "can create a long-running Claude/Codex loop and may drain usage limits quickly" — [GitHub](https://github.com/openai/codex-plugin-cc)
- pstack caps:
  - Interrogate triage, with a reason for every dismissal; it "applies nothing automatically."
  - Retries: "Two retries, then abandon the unit and replan around it."
  - `/maintain-verification-skill` allows "at most one PR of proven corrections."
  - `blast-radius` requires safety claims "proven by running code, not asserted."
  - Sources: [orchestrate.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/orchestrate.md); [README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
- Every plugin: when a plan carries `session-settled:` decisions, "a finding that merely prefers a different approach is discarded." A real defect keeps its severity. Fallback runs "without an unbounded retry loop" — [ce-code-review.md](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/guides/ce-code-review.md)
- Cursor: a judge decides at each cycle end whether to continue, and fresh starts counter drift — [Cursor](https://cursor.com/blog/scaling-agents)
- Claude Code agent teams: the debate ends when the lead writes the consensus to a findings doc. "The lead can stop early too." Hooks (`TaskCompleted`, `TeammateIdle`) exit with code 2 to block completion until a gate passes. "Letting a team run unattended for too long increases the risk of wasted effort." — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)

### Inferences
- The protocol the evidence supports:
  1. Get independent first answers before agents see each other, which counters conformity (Wynn) and makes the vote useful (Choi).
  2. Run one critique round.
  3. Let a single owner or judge decide, using executable evidence.
  4. If disagreement survives the cap, escalate it rather than running another round.
- An evidence requirement (a reproducing test, a failing command, a cited line) turns critique into verification. It is also the only stop condition that doesn't depend on the debaters agreeing.
- A standing record of settled decisions lets later reviewers drop "I'd have done it differently" findings without reopening the decision (Every's `session-settled`).

### Gaps
- I found no study measuring round caps or stopping rules for coding-agent review loops specifically. Caps in practice (one pass, two retries) are design choices, not measured optima.

## Q4. Role splits reported by practitioners who use both Codex/GPT and Claude

### Takeaway
Attributed reports exist but are anecdotal, and they disagree on which family should do what. The most common split is that one family builds and the other reviews, or each cross-reviews the other's diffs. The one controlled study favors Claude as the reviewer of Codex drafts, and recommends no review at all for Claude drafts on its benchmark. Cursor found GPT-5.2 the better long-horizon planner and worker, while Opus 4.5 stopped earlier. The consistent advice is to assign by measured strength per role and keep the reviewer at least as capable as the author.

### Cited Findings
- Cursor (Jan 14, 2026): GPT-5.2 "performed much better on extended autonomous work," following instructions, staying focused and avoiding drift. Opus 4.5 "tends to stop earlier and take shortcuts when convenient." GPT-5.2 was a better planner than GPT-5.1-Codex, and models are now assigned by role — [Cursor](https://cursor.com/blog/scaling-agents)
- Cognition (Apr 22, 2026): "We've run Claude and GPT together in this setup in production for a meaningful stretch," with a primary model consulting a "smart friend." The pattern needs "both models are strong" — [Cognition](https://cognition.com/blog/multi-agents-working)
- pstack (Lauren Tan, 2026): code delegates go to Grok. Hardest changes, prose and judgment go to Opus 5.5. A unit's verifier runs on a different family from its worker — [README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
- Every (Dec 11, 2025): Claude Code is primary, some team members use Codex CLI, and Codex is listed among automatic code reviewers — [Every](https://every.to/source-code/compound-engineering-how-every-codes-with-agents). With a Claude host, the plugin's peer order tries Codex first — [ce-code-review.md](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/guides/ce-code-review.md)
- Peter Steinberger, "Just Talk To It" (page undated; it cites an Oct 7, 2025 Willison post, and search snippets show Willison linking it on Oct 14, 2025) — [steipete.me](https://steipete.me/posts/just-talk-to-it)
  - He has "completely moved to `codex` cli as daily driver" and runs "between 3-8 in parallel in a 3x3 terminal grid, most of them in the same folder."
  - Conflict control: "each agent commits exactly the files it edited."
  - For complex features, Codex writes a spec and he sends it to GPT-5-Pro for review, a different model in the same family, which "surprisingly often... greatly improves my plan."
  - He dismisses subagents as "mostly just charade."
- Mahnoor Faisal, XDA (May 17, 2026): Claude Code does UI and design; Codex does "the patient, unglamorous work of figuring out what's actually broken." Each reviews the other's diffs, because self-review fails: "The model agrees with its earlier choices." When both solve the same task, she picks the result she prefers. Evidence is personal experience only — [XDA](https://www.xda-developers.com/use-claude-code-and-codex-together-combination-does-something-neither-can-do-alone/)
- Youssef Hosni (Apr 12, 2026): "one agent builds, another reviews," with Claude Code implementing and Codex reviewing through the official plugin. The workflow details are paywalled — [Substack](https://todatabeyond.substack.com/p/use-codex-inside-claude-code-instead)
- Xiang et al. (Jul 22, 2026): "use Claude Opus 4.7 to review Codex GPT-5.5, not the other way around." Claude solo was Pareto-optimal on their benchmark — [arXiv](https://arxiv.org/abs/2607.21656)

### Inferences
- Across the reports, three things recur. Planner and judge roles reward persistence and instruction-following (Cursor). The reviewer should be at least as strong as the author in that domain (Xiang; Cognition's weak-primary failure). The reviewer should differ from the author in family, or at minimum in context.
- Because practitioners disagree on which family should plan and which should implement, an operator running both should measure on their own task mix: one bounded cross-review per unit, logging which findings were real. Brand-level folklore is not a sound basis for the split.

### Gaps
- I found no attributed practitioner report with measured outcomes for a repo-scale, two-family workflow.
- Many search hits were vendor or SEO comparisons (MindStudio, vibeconsole, coursiv, Towards Data Science and others). They were excluded as unattributed or promotional.
- The OpenAI "Harness engineering" post (https://openai.com/index/harness-engineering/) returned HTTP 403 and is UNFETCHED. I could not verify its account of Codex agent-to-agent review.

## Q5. Shared state for collaboration: task lists, single-writer surfaces and decision logs

### Takeaway
Systems that work move state out of conversations and into a few machine-readable surfaces: a task list with atomic claims and dependencies, a progress log, git history, and plan or spec files that hold settled decisions. Each writer gets exclusive files or branches. Locks alone do not stop agents from pursuing conflicting hypotheses. Hierarchy, partitioning and a single synthesizer do.

### Cited Findings
- Anthropic long-running harness (Nov 26, 2025) — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  - An initializer agent writes a JSON feature list, with every feature initially failing. Coding agents may change only the `passes` field, and "It is unacceptable to remove or edit tests." JSON was chosen because the model is less likely to overwrite it than Markdown.
  - `claude-progress.txt` logs what agents have done. Agents commit with descriptive messages, and each session starts by reading the progress file and the git log.
  - Failure modes it addresses: one-shotting the app, declaring victory too early, and marking features done without end-to-end tests.
- Anthropic research system: the plan is saved to Memory, and subagents store their outputs externally and pass back references — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Carlini (Feb 5, 2026) — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
  - Agents claim tasks with lock files in `current_tasks/` synced through git: "If two agents try to claim the same task, git's synchronization forces the second agent to pick a different one."
  - There is no orchestrator. "Merge conflicts are frequent, but Claude is smart enough to figure that out."
  - Standing specialist roles: deduplication, compiler performance, generated-code efficiency, Rust design critique, documentation.
  - The test harness prints little and logs details to files, to avoid "context pollution." A `--fast` option runs a deterministic per-agent sample. A stricter CI was added once new features kept breaking old ones.
  - Cost: about 2B input and 140M output tokens, "just under $20,000."
- Cursor: claiming from a shared file with locks failed (above); planners own task creation instead — [Cursor](https://cursor.com/blog/scaling-agents)
- Claude Code agent teams (experimental) — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
  - Tasks are pending, in progress or completed, with dependencies, and blocked tasks can't be self-claimed. "Task claiming uses file locking to prevent race conditions."
  - Messages go through per-agent JSON mailboxes.
  - "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files."
  - Limitations: "Task status can lag," and the lead sometimes implements tasks itself instead of waiting for teammates.
- Steve Yegge's beads — [GitHub](https://github.com/steveyegge/beads)
  - `bd update <id> --claim` "Atomically claim[s] a task (sets assignee + in_progress)." `bd ready` lists tasks with "no open blockers."
  - "Hash-based IDs (`bd-a1b2`) prevent merge collisions in multi-agent/multi-branch workflows."
  - It "replaces messy markdown plans with a dependency-aware graph" and tells agents "Do not use markdown TODO lists for task tracking."
  - No creation date is visible on the page.
- pstack orchestrate: "One writer per worktree or branch." Before closing, every landed PR must have a verdict for its current head SHA. The agent store is left intact as "the postmortem" — [orchestrate.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/orchestrate.md)
- Steinberger: several agents share one folder, kept apart by the rule that each agent commits only the files it edited — [steipete.me](https://steipete.me/posts/just-talk-to-it)
- Claude Code best practices: write a `SPEC.md`, then "start a fresh session to build from it, so the build begins with a clean context and a written definition of done." Review the diff against that spec — [Claude Code docs](https://code.claude.com/docs/en/best-practices)
- Every: `session-settled:` decisions in the plan let review discard preference-only findings. The compound step writes learnings to `docs/solutions/` for later plans — [ce-code-review.md](https://github.com/EveryInc/compound-engineering-plugin/blob/main/docs/guides/ce-code-review.md); [Every](https://every.to/source-code/compound-engineering-how-every-codes-with-agents)
- Cognition: child agents don't share state by default, and agents wrongly "assume" they do. Cognition puts the remaining problems down to communication — [Cognition](https://cognition.com/blog/multi-agents-working)
- MAST: "inter-agent misalignment" is one of three top-level failure categories — [arXiv](https://arxiv.org/abs/2503.13657)

### Inferences
- To keep two agents from pursuing conflicting hypotheses, put a hypothesis register on the shared task surface. Each entry records the hypothesis, one owner, the disconfirming check, and a status. Only the synthesizer writes conclusions, and settled conclusions are marked so reviewers stop relitigating them. This combines the agent-teams findings doc, Every's `session-settled:` decisions, and atomic claims from beads and the agent-teams task list.
- The operator's own AGENTS.md already encodes several of these patterns: lane ownership by Git common-directory identity, one independent post-code review capped at one formal fix, and status derived from an event log rather than stored. These match what the sources report working: single writer, a single bounded review, and durable state outside chat. This is an inference from the local file `/Users/rewt/development/rewt/herdr-brain/AGENTS.md`, not an external source.

### Gaps
- I found no controlled comparison of shared-state designs (lock files, task graphs, decision logs) for agent coordination. All the evidence is case reports.
- The OpenAI harness-engineering post, which reportedly covers in-repo execution plans and decision logs, was UNFETCHED (HTTP 403).
- Beads' release date and any measured effect on duplicated work were not available.
