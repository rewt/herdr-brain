# Exit identity correction

R-1263 found a native command representation change in the retained R-1260
shell: its original exit intent records PID 35293, birth 1793238924:646016 and
`[zsh]`; a diagnostic read sees the same pane, terminal, PID and birth with
`-zsh`. That diagnostic uses full argv; the canonical adapter uses identity-only
kernel names and still sees `[zsh]`. The spelling difference therefore is an
adapter compatibility case, not an established explanation of the original
live mismatch. A fresh adapter observation confirms the retained shell matches
the original PID/birth, pane and terminal, with no agent row; it appends no
completion and does not resolve the original UNKNOWN intent.

Retirement admits only the kernel-bracket/name/login-name spellings of the
same supported shell, with exact PID and birth equality. Other commands,
arguments, shell kinds, births, terminals, panes and agent sessions still fail
closed. Within the original bounded exit invocation, an agent row whose fields
are clearing waits for a complete original row or for its disappearance; missing
fields never authorize completion. Any positive replacement field stops at once.
Failed observations now retain the exact pane, shell and occupant facts in the
existing native result so later diagnosis need not guess which comparison failed.
The exit receipt saves the actual observed shell command. The ordinary
release policy, second observation, process vacancy, source/claim/Git checks
and STOP/HOLD still govern the subsequent close. Pane disappearance without an
original completion receipt remains unknown; absence alone grants no success.

R-1255 and R-1259 cannot advance from their original evidence alone: the saved
intent and generic mismatch contain no original post-exit observation proving
which field differed. Their original UNKNOWN outcomes remain. This change does
not select a new readback, resend, replacement allocation or hand-close for them.

Focused selection: the new exit-identity controls; affected exit receipt and
stale-release identity controls; and the existing UNKNOWN/refusal controls in
closeout-facts. Actual commands and receipts belong to the R-1263 report.
The deadline-edge fixture originally supplied only 60 seconds, less than the
existing exit reserve (60 seconds plus 10 seconds). Its unchanged on-main control
failed before any prompt. It now supplies the line's three-minute finite turn;
all post-exit expiry and receipt assertions remain intact.
The fixture cleanup-audit failure for PID 79365 concerns runner lifetime,
not shell command representation, and stays with ENG-938.
