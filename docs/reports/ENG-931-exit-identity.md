# Exit identity correction

R-1263 found a native command representation change in the retained R-1260
shell: its original exit intent records PID 35293, birth 1793238924:646016 and
`[zsh]`; a diagnostic read sees the same pane, terminal, PID and birth with
`-zsh`. Darwin's process source can fall back to the kernel name while a shell
waits and later expose its login argv. Literal command equality incorrectly
rejects that normal foreground transition.

Retirement admits only the kernel-bracket/name/login-name spellings of the
same supported shell, with exact PID and birth equality. Other commands,
arguments, shell kinds, births, terminals, panes and agent sessions still fail
closed. The exit receipt saves the actual observed shell command. The ordinary
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
The fixture cleanup-audit failure for PID 79365 concerns runner lifetime,
not shell command representation, and stays with ENG-938.
