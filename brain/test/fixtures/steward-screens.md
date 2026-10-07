The two blocked JSON fixtures are footer excerpts from Brain's actual
`queue.jsonl` captures on 2026-10-07:

- `2026100703203-aggregator-gm`: outside-working-directory read permission
  dialog, 03:20:35 UTC. Original project display label was `other` despite this
  being a fleet project; routing tests deliberately disregard that label.
- `2026100703234-supervisor-opus`: supervisor's third-wallet permission-rule
  question, 03:23:46 UTC. The existing parser captured this as `unsent` rather
  than a structured dialog. The question and options remain verbatim evidence.

Unrelated preceding conversation was removed from `screen`; question/footer
text and parsed fields were retained. Paths, session names and panes are replaced
with isolated temporary Git projects in tests. These fixtures never grant a
permission, use a wallet, invoke a model, or contact a live pane or project.
