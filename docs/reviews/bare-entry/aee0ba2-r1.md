**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: aee0ba2955bec66e34e1ed3a7ed0039e2292e92b
Topic: bare-entry
Round: 1
Review ID: lr-4614a7c286ee9ad31ca007138f84dd9f
Base branch: main
Base commit: b7af494b162c027c3b557e381412937cfa8019dd

## Findings
- [Moderate] supervisor/chats.mjs:193 - The new direct launch runs \`herdr agent start\` through herdrCommand, whose spawnSync timeout is 10000 ms (line 77), but \`herdr agent start\` blocks until the harness is detected and ready, with a 30000 ms default; any Codex or Claude startup slower than 10 s now throws a bare \`Herdr agent start: ... ETIMEDOUT\` error without the retained-tab guidance, the startupMs detection loop never runs, and the agent may keep starting in a pane the caller reported as failed (the old pane run returned at once and polled for startupMs); Fix: pass \`--timeout\` derived from startupMs to agent start and give that one call a spawnSync timeout above it, wrap agent start failures in the existing \`chat startup not detected; retained tab ...\` message, and add a chats test whose fake agent start outlasts the 10 s client limit
- [Moderate] supervisor/chats.mjs:193 - Route and chat environment (ORG\_DIR, ORG\_ACTOR, HERDR\_AGENT\_NAME, MONITOR\_SUPERVISOR\_AGENT, cleared LANE\_CONFIG, and route account selectors such as CLAUDE\_CONFIG\_DIR) is now set only on the tab via \`--env\`, while agent start runs with the launcher process env; contrib/settle-watch.mjs:349 records that Herdr takes the agent config dir from the caller of agent start, not from the tab, so a Claude chat route that selects an account can start under the launcher's account or an inherited config, and the old adapter path (exec inside the pane shell) did not have this gap; the chats fake records the tab env as the launch env, so no test can detect it; Fix: call agent start with the launcher env overlaid by the resolved chat pairs (as settle-watch does) and make the fake herdr record and assert the caller env for both kinds
- [Moderate] release/README.md:71 - Living release docs still say the gate passes \`--bch-cloak\` to acceptance/run.mjs and document RELEASE\_BCH\_CLOAK, five existing-project compatibility cases and a preflight that checks that path, but this lane removed those cases, releaseInputs now ignores the variable, and run.mjs strict option parsing now rejects \`--bch-cloak\`; an operator reading this believes bch-cloak compatibility is still gated; Fix: replace the paragraph and the export example with a statement that the gate uses only scratch fixtures, RELEASE\_BCH\_CLOAK is ignored, and the offline bch-cloak contract check arrives with lane C
- [Minor] supervisor/PROTOCOL.md:8 - Removing the SessionStart paragraph also deleted non-hook supervisor guidance: retrieve \`record show ID\` only as needed, use \`brief --json\` when the preview truncates, and run \`checkpoint --through N --role supervisor\` as a reading bookmark that is never work status or authority; the cold-start footer keeps only a shorter checkpoint hint; Fix: restore those sentences without the SessionStart wording
- [Minor] discovery/policy.mjs:9 - After removing the role adapters, only supervisor/chats.mjs calls entryPolicy (role chat); the supervisor and worker branches have no production consumer, so a native supervisor session no longer receives PROTOCOL.md automatically and the acceptance supervisor case exercises a policy path nothing launches; Fix: either drop the unused branches and test the brief directly, or state in supervisor/README.md how a native supervisor session obtains PROTOCOL.md (for example print a pointer from \`supervisor.mjs entry\`)
- [Minor] discovery/README.md:30 - The doc says the chat policy includes project instructions, but discovery/policy.mjs no longer embeds AGENTS.md or CLAUDE.md content and only tells the agent to read them; Fix: reword to say the policy points the agent at the project instruction files and includes the record command and active lessons
- [Minor] promote/train.mjs:246 - The train still passes \`hostSuites\` to validateTree, which no longer accepts that option after host suites were removed; Fix: delete the dead \`hostSuites\` argument
- [Minor] acceptance/results.mjs:11 - resultLine keeps a special case for the removed \`lessons-entry\` case key; Fix: remove the \`lessons-entry\` clause
- [Minor] herdr/release.sh:134 - Activation and restore no longer remove wrappers, PATH snippets or SessionStart hooks installed by an earlier entry-installing release, and herdr/README.md does not say how to clean them up, so a machine that activated such a release keeps routing codex and claude through the stale entry snapshot; Fix: add a short one-time cleanup note to herdr/README.md naming the entry bin directory, the shell snippet and hook locations to remove, or keep a removal-only activation step

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Herdr agent start runtime behaviour (which environment the launched harness receives, the exact JSON reply shape herdrCommand requires, and readiness timing) was not observed because the zero-command budget permits no live Herdr launch; the two chats.mjs findings rest on code reading, Herdr help text and the settle-watch comment.
- The worker report states the complete lanes test file ran with 142 passes and 8 failures during development and that only selected cases were rerun; no single complete run of that file at the reviewed commit was inspected.
- Commits 1c5738a3 and babe21a1 inside the base-to-head delta belong to earlier lanes and were only spot-checked for interaction with this lane.
- Worker evidence files listed as report artifacts under the run evidence directory were not inspected.
- Test evidence not re-executed: supervisor/test/chats.test.mjs
- Test evidence not re-executed: lanes/test/lane.test.mjs
- Test evidence not re-executed: lanes/test/routes.test.mjs
- Test evidence not re-executed: lanes/test/validation.test.mjs
- Test evidence not re-executed: test/fleet.test.mjs
- Test evidence not re-executed: supervisor/test/entry.test.mjs
- Test evidence not re-executed: discovery/test/lessons.test.mjs
- Test evidence not re-executed: acceptance/test/cases.test.mjs
- Test evidence not re-executed: acceptance/test/environment.test.mjs
- Test evidence not re-executed: release/test/candidate.test.mjs

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
