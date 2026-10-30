# Intent-first work dispatch

New work uses the revision-4.1 slice shape: Why, Question, Measure, slice-specific
Hard limits, Out of scope, a challenge sentence, and How we will know it works
(Baseline, Witness, Handoff). This applies to ordinary work, questions and
decisions, report proposals, review work and linked corrections, including
automatically filed admission repairs and completion decisions.

Start with `record template > prompt.md`, replace its guidance with the actual
intent and evidence, then file it:

```sh
record add "Give fresh owners the original intent" --role engineer --parent ARCH-1 \
  --file prompt.md --why "The operator needs work to reflect the original request."
```

`--file` reads the whole acceptance body, including its original newlines. It is
an alternative to repeated `--accept` arguments. Report proposals use the same
body as one `accept` entry. Existing `record amend-accept` remains the owning
author's way to replace acceptance while retaining every historical revision.
Keep the operator's verbatim words and exact source references in the record;
distinguish them from the working formulation.

Complete authored prompts pass through unchanged. Short or older-style inputs
receive the standard envelope with their acceptance text preserved verbatim.
Missing rationale/measures/boundaries are labelled, and an unavailable baseline
stays unmeasured. These defaults are authoring guidance, not measured evidence,
approval, selection, a new readiness validator or a requirement to invent a
numeric target. Record the useful baseline/target in the normal work note and
revise it with reasons. Roughly 150–220 words is editing advice, never a ceiling.

New briefs render the same shape for legacy items without rewriting them.
Already saved briefs and launch contracts keep their original bytes and routes.
Current acceptance remains the scope; native identity, claims, STOP/HOLD,
reserved effects and existing review/correction obligations retain their owners.
The template grants no permission to change those boundaries.

ENG-1039 supplies original intent, authority limits and bounded pointers to
related decisions/lessons; the template does not duplicate that retrieval.
ENG-1035 supplies report/handoff guidance and cold-reader evidence; filling this
template does not prove completion or introduce another evaluator. ENG-995 and
ENG-1042 retain the live status-view work.

## Native harness comparison, checked 30 October 2026

Codex reads repository instructions through
[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
Its [skills](https://learn.chatgpt.com/docs/build-skills) provide reusable
procedures and load full instructions when selected. Claude Code likewise has
[project instruction files](https://code.claude.com/docs/en/memory) and
[skills](https://code.claude.com/docs/en/skills). Claude's AGENTS.md handling
depends on its instruction-file settings and version; this change does not
configure either harness.

Brain's additional responsibility here is the individual assignment: the
operator's intended benefit, the question and observable result, slice-specific
limits and the evidence handoff. Shared policy stays in AGENTS.md and reusable
procedures stay in the existing shared skills. No new skill loader, instruction
file discovery, memory store, compactor or execution loop is introduced.
