# Closed-profile reach checker: validation pending

Run: R-539. Implementation commits: `25872cd2` and `ba518a78`.
The governing approach is the supervisor's ENG-396 decision at sequence 8110.

The explicit HOLD tests instruction remains active. No resume notice arrived
during this run. No test, syntax-execution probe or artificial load was started.
Only static inspection, Git whitespace checks and code/fixture work were done.
The required cohort run is pending:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 supervisor/test/green-pass.test.mjs
```

Run that command once after the supervisor sends `resume tests`, with Node
20.19.4 first in PATH. This document is not passing test evidence. The supervisor
owns native execution of the unchanged autopilot tests; their earlier sandbox
failures were not investigated or rerun here.

The implementation replaces permissive source scanning with a closed grammar.
Every token must be consumed by a recognized production; unsupported syntax,
values, options, imports and any lexical error retain unknown reach. Code slashes
are unsupported, so no speculative regex/division branch can be dropped.
Known literal inventory references can still be retained beside a refusal.

Authority entries now include `supervisor/supervisor.mjs`. Their execution
closures are derived from the trusted running checkout and both Brain Git trees,
including module imports, literal repository references and supported spawns.
Any touched authority or cross-project closure file remains frozen, including
mode changes. Unresolved authority or inventory reach refuses admission.

The fixture file contains witnesses for all seven review findings:

- Hidden-import regex source followed by non-ASCII or escaped identifiers.
- Regex source after `default`, spread and `extends`.
- Stored `dlopen`, `binding`, constructor and computed member reads.
- Child-process default-as and class imports.
- Environment and cwd overrides on both spawn and fork.
- Cwd-relative fork and Node-spawn targets, alongside anchored positive forms.
- The supervisor handle entry, transitive helpers and authority-only spawns.

Other fixtures preserve existing refusal cases, exercise unfamiliar constructs
without mentioning a loader API, check literal-data and anchored-launch positive
forms, and inspect the actual authority inventory. These fixtures have not run.

The accepted profile is deliberately small: functions, general calls, control
flow and other unsupported forms refuse. Current production reach is therefore
not established as understood or deployment-ready. Existing ENG-422 remains the
follow-up before enablement; this change activates no cohort or release.
