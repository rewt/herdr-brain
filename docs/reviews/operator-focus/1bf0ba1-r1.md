**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 1bf0ba14e176b3edb59389e6bafa9771be75c678
Topic: operator-focus
Round: 1
Review ID: lr-e38746042f1f41d957b09dc3fd05e55f
Base branch: main
Base commit: d758f93c7ff67a1ba04a488a311a26a2dbd460c3

## Findings
- [Moderate] acceptance/focus.mjs:148 - Native focus events are silently discarded: the retained protocol-20 schema uses \`pane.focused\` for subscription requests but \`pane\_focused\` for event envelopes, and HerdrClient forwards the envelope unchanged. The fake server emits the request spelling instead, concealing this mismatch. A native focus change restored between samples can therefore receive a green verdict; Fix: handle the native \`pane\_focused\` envelope and update the regression fixture to emit the actual protocol shape, requiring a transient change between unchanged samples to fail with call attribution.
- [Moderate] acceptance/focus.mjs:121 - Re-baselining every unowned, uncorrelated change removes the required failure on any focus change. The retained corrected-candidate run records one such change and different initial and final panes while returning PASS. The claimed supervisor revision appears only in the worker report; the supplied acceptance still requires an unchanged pane throughout and a case that fails on any change; Fix: retain a strict zero-change acceptance mode, use it for the supplied criteria, and provide a corrected-candidate full-run trace with unchanged initial focus, keeping external attribution diagnostic unless authoritative revised acceptance is supplied.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- A full run of the corrected candidate satisfying the supplied zero-change criterion is not established: its retained trace records one change, and the zero-command review budget permits no replacement run.
- Native transient-change detection, including workspace and tab navigation, is not established by the retained fake-server controls; the event envelope is incorrect and no native runtime witness is authorized.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
