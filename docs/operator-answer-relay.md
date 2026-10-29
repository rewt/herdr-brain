# Relaying an operator priority answer

The one operator chat can record the operator's answer to a priority question
without changing its writer identity. The target record's owner must explicitly
configure `approvals.operator_relay` in that record's `config.json` with the
operator-approved native binding:

```json
{
  "actor": "operator-chat",
  "common": "/source/project/.git",
  "server": "/native/herdr.sock",
  "workspace": "workspace-id",
  "pane": "workspace-id:pane-id",
  "terminal_id": "terminal-id",
  "agent_session_id": "native-session-id"
}
```

These are actual captured native identities, never values inferred from a label,
role or a pasted claim. The source common-directory must be canonical. A chat in
one project can be explicitly bound by another owning record; existing project
access checks still apply. No binding is enabled by default. Installing or replacing
one changes who may relay operator decisions and needs the operator's authority;
ordinary workers must not install one. This feature does not change saved chat
bindings, jobs, pins or sessions, or automatically follow a replacement session.

From that exact native chat, keep `ORG_ACTOR` set to the configured actor:

```sh
record answer HUM-179 'Yes to both' --relay-operator \
  --source 'Operator conversation, the two coordinated proving asks' \
  --said-at '2026-10-29T07:34:00-05:00'
```

The positional reply is the verbatim operator text; `--source` identifies where
and what they answered, and `--said-at` requires a timestamp with timezone. These
are the bound chat's attestation, not transcript verification. Ambiguous answers
must be resolved by the operator before relaying. Re-answering requires the
existing explicit `--overrule` and must change the answer.

Only `category=priorities` questions without `operator_reserved` or `reserved` are eligible.
Security, funds-and-chain, publish, delete-data and licensing questions retain
their existing answer path, even if their policy is configured as automatic.
Native lookup refusals or record/configuration races append no answer and are
not automatically retried. No input is sent to another session.

The usual answer events remain authored by the relayer, with
`meta.answered_by=human` and `meta.answer_relay` retaining the exact text, source,
time, relayer, owning record and native binding. Direct answers and old events
keep their existing format. Old folds can read the normal answer/update/close
events; privileged consumers requiring an actual human-authored transaction
still reject a relay. No closeout code changes are involved.
