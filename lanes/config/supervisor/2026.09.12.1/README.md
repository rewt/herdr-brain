# Daily supervisor protocol 2026.09.12.1

This supplements the pinned core/config release `config/2026.09.12.1`. That
release supplies a one-shot `monitor` route, but route `use` text is descriptive
and is not sent to agents or enforced by the CLI. This protocol supplies the
missing session boundary and startup instructions. It adds no watcher, daemon,
lease, or automatic action to herdr-lanes.

## Deploy one daily supervisor

1. Use the canonical checkout in its Herdr workspace. Choose the supervisor
   model explicitly under that project's policy. Do not reuse an engineering
   route simply because it is the default. A one-shot `monitor` route is not a
   substitute for a facilitator that must discuss plans and make decisions.
2. Put the current facts in a private, gitignored checkpoint using
   `CHECKPOINT_TEMPLATE.md`. Keep it roughly one page. Verify `git check-ignore`
   before placing it inside a repository. Link to committed artifacts and exact
   gate/review records rather than copying transcripts or secrets.
3. Start a fresh agent session and give it `STARTER.md` plus the checkpoint path.
   In a Codex project, a Herdr shell pane can start a named Codex session with
   `herdr agent start <name> --kind codex --pane <pane-id> -- -m <approved-model>
   -c model_reasoning_effort=<approved-effort>`. Then send `STARTER.md` and the
   private checkpoint's absolute path in one `herdr agent prompt` call. Select
   native arguments according to the actual agent kind; the project policy wins.
4. Add `ENGINEER_REPORT_APPENDIX.md` to each engineering brief with the exact
   supervisor agent name. The engineer preserves the evidence available at a
   material milestone, blockage, or completed gate, then sends one short
   `herdr agent prompt` to the supervisor. It does not wait for the supervisor's
   answer. A delivery failure leaves the durable evidence intact.
5. After dispatching, record the expected artifact, tell the operator, and end
   the supervisor turn. An incoming engineer report is the normal wake-up.
   Verify its branch, HEAD, gate, and report against Git and lane evidence
   before acting. The message is a claim, not authorization or a verdict.
   Independent reviewers follow their record-only protocol; the review command
   returns their verdict to its caller after validating the saved record.
6. If the operator asks for status before a report arrives, take one compact
   snapshot of exact named agents. Read bounded output only for changed state;
   use Git HEAD, lane status, gates, and review records for durable facts.
   Do not run a periodic supervisor polling loop.
7. At the end of the day or a major phase, update the checkpoint and start a
   fresh session next time. Use Codex `/compact` during a coherent long task if
   needed, but do not keep one chat for the whole project. Keep a soft ceiling
   near 20 model responses or 40,000 input tokens in one supervisor context;
   rotate earlier if a session starts with a larger required instruction set.

The checkpoint and incoming reports are continuity for conversation, not
authority for promotion, publication, financial actions, or approval. Recheck
those boundaries against their primary evidence on every relevant action.

## Measure the result

Record per session: elapsed time, model response count, total input, cached
input, uncached input, and output tokens. Compare cost per completed milestone
and status transition with the prior supervisor. A high cache ratio is normal
for a reused prompt prefix; the aim is fewer unnecessary model calls and a
smaller context per call. Do not claim a percentage saving before measuring it.

OpenAI's Codex [best practices](https://learn.chatgpt.com/guides/best-practices)
recommend one chat per coherent unit of work and `/compact` for long chats.
