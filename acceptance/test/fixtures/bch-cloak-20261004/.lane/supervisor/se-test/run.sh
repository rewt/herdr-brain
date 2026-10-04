#!/bin/zsh
# Isolated tests of supervisor-events.mjs and notify-watch.sh: temp dirs, stub herdr/org, fake org log, a private lock port per test.
# Never touches real panes, the real slot, outbox or queues. The two lock checks at the end only hold the real flock files for a moment
# and stop each script before it does anything else. Exits 1 if any check fails.
set -u
D=${0:A:h}; SUPD=${D:h}; SE=${SE_UNDER_TEST:-$SUPD/supervisor-events.mjs}; NW=${NW_UNDER_TEST:-$SUPD/notify-watch.sh}
NODE=$HOME/.nvm/versions/node/v22.22.3/bin/node
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
calls(){ local c; c=$(grep -c -- "$1" $T/herdr.calls 2>/dev/null); echo ${c:-0}; }
setup(){
  T=$(mktemp -d /private/tmp/se-test-XXXX); mkdir -p $T/sup $T/tmp $T/w $T/req
  cat > $T/herdr <<EOF
#!/bin/bash
echo "\$*" >> $T/herdr.calls
case "\$1 \$2" in
  "agent list") if [ -e $T/list-grandchild ]; then sleep 20 & echo \$! > $T/gc.pid; exit 0; fi
    if [ -e $T/list-hang ]; then echo \$\$ > $T/list.pid; [ -e $T/list-ignore-term ] && trap '' TERM; exec sleep 30; fi
    if [ -e $T/no-sup ]; then echo '{"result":{"agents":[]}}'; else echo '{"result":{"agents":[{"name":"supervisor-opus","pane_id":"wFN:p9","workspace_id":"wFN","cwd":"/x"}]}}'; fi ;;
  "pane read") cat $T/screen ;;
  "agent wait") [ -e $T/wait-delay ] && sleep \$(cat $T/wait-delay); [ -e $T/wait-fail-\$3 ] && exit 1 ;;
esac
exit 0
EOF
  chmod +x $T/herdr
  printf '%s\n' '{"type":"run.started","id":"R-1","item":"X-1","meta":{"agent":"a1"}}' '{"type":"run.updated","id":"R-1","meta":{"pane":"w1:p1"}}' \
    '{"type":"run.started","id":"R-2","item":"X-2","meta":{"agent":"a2"}}' '{"type":"run.updated","id":"R-2","meta":{"pane":"w2:p2"}}' \
    '{"type":"run.started","id":"R-3","item":"X-3","meta":{"agent":"a3"}}' > $T/events.jsonl
  # an empty Claude Code input box: two rules with only the prompt glyph between them
  printf '\e[0m────────────\n\e[38;2;136;136;136m❯ \e[0m\n────────────\n' > $T/screen
  PORT=$($NODE -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')  # a free port
}
start(){ SE_ROOT=$T SE_SUP=$T/sup SE_WAITERS=$T/w SE_GATE_REQ=$T/req SE_SLOT_LOCK=$T/tmp/slot.lock SE_ORG_EVENTS=${ORGEV:-$T/events.jsonl} \
  SE_HERDR=$T/herdr SE_LOCK_PORT=$PORT SE_SWEEP_MS=${SWEEP:-60000} SE_RESERVE_MS=${RES:-60000} SE_BACKOFF_MS=${BACKOFF:-30000} \
  SE_RETRIES=${RETRIES:-6} SE_HERDR_MS=${HMS:-30000} SE_TRACE=${TRACE:-} $NODE $SE 2>>$T/daemon.err &
  PIDSE=$!; sleep 0.8; }
stop(){ ok "daemon still running at the end of the test" 'kill -0 $PIDSE 2>/dev/null'; kill $PIDSE 2>/dev/null; wait $PIDSE 2>/dev/null; }
ms(){ $NODE -e 'console.log(Date.now() + Number(process.argv[1]))' $1; }

echo "== T1 idle, with a 300 ms sweep: no herdr call"
setup; SWEEP=300 start; sleep 2
ok "idle daemon and its sweep launched nothing" '[ ! -s $T/herdr.calls ]'
stop

echo "== T2 slot held by a live process: no wake; released: wake by event"
setup; sleep 300 & HOLD=$!; echo "{\"pid\":$HOLD,\"pgid\":null}" > $T/tmp/slot.lock; start
touch $T/w/R-1.slot; sleep 1.5
ok "no wake while held (negative control)" '[ "$(calls "send-text w1:p1")" = 0 ]'
rm $T/tmp/slot.lock; sleep 1.5
ok "woken once after release, within 1.5 s (sweep is 60 s)" '[ "$(calls "send-text w1:p1")" = 1 ] && [ "$(calls "send-keys w1:p1 Enter")" = 1 ]'
ok "waited (bounded) for the agent to stop before typing" '[ "$(calls "agent wait a1 --until idle --until done --until blocked --timeout 25000")" = 1 ]'
ok "waiter file consumed, nothing left claimed or failed" '[ -z "$(ls $T/w)" ]'
echo "== T3 reservation: next waiter only after the slot is taken"
touch $T/w/R-2.slot; sleep 1.5
ok "second waiter held back by the reservation" '[ "$(calls "send-text w2:p2")" = 0 ]'
echo "{\"pid\":$HOLD,\"pgid\":null}" > $T/tmp/slot.lock; sleep 1; rm $T/tmp/slot.lock; sleep 1.5
ok "second waiter woken once the slot was taken and released" '[ "$(calls "send-text w2:p2")" = 1 ]'
kill $HOLD; stop

echo "== T4 file waiters woken by directory events"
setup; start; mkdir -p $T/out; echo $T/out/raw.exit > $T/w/R-1.file; echo $T/new/sub/raw.exit > $T/w/R-2.file; sleep 1.5
ok "no wake before the files exist (negative control)" '[ "$(calls "send-text")" = 0 ]'
echo 0 > $T/out/raw.exit; sleep 1.5
ok "woken after the file appeared" '[ "$(calls "send-text w1:p1 FILE-READY")" = 1 ]'
mkdir -p $T/new; sleep 0.5; mkdir -p $T/new/sub; sleep 0.5; echo 0 > $T/new/sub/raw.exit; sleep 1.5
ok "woken when its not-yet-existing directory and file appeared (ancestor watch)" '[ "$(calls "send-text w2:p2 FILE-READY")" = 1 ]'
stop

echo "== T5 PAUSED blocks wakes; removing it resumes"
setup; echo paused > $T/sup/PAUSED; start; touch $T/w/R-1.slot; sleep 1.5
ok "no wake while PAUSED (negative control)" '[ "$(calls "send-text")" = 0 ]'
rm $T/sup/PAUSED; sleep 1.5
ok "woken after PAUSED removed" '[ "$(calls "send-text w1:p1")" = 1 ]'
stop
echo "== T5b PAUSED created while the wake waits for the agent: nothing typed, waiter restored"
setup; echo 1.5 > $T/wait-delay; start; touch $T/w/R-1.slot; sleep 0.5; echo paused > $T/sup/PAUSED; sleep 2
ok "nothing typed after a pause during the wait" '[ "$(calls "send-text")" = 0 ] && [ "$(calls "agent wait a1")" = 1 ]'
ok "waiter restored for later" '[ -e $T/w/R-1.slot ] && [ ! -e $T/w/R-1.slot.waking ] && [ ! -e $T/sup/watch-logs/supervisor-events.reservation ]'
rm $T/wait-delay $T/sup/PAUSED; sleep 1.5
ok "woken once PAUSED is removed" '[ "$(calls "send-text w1:p1")" = 1 ]'
stop

echo "== T6 stale lock (holder dead) counts as free at the sweep; a malformed lock does not"
setup; sh -c 'exit 0' & DEAD=$!; wait $DEAD; echo "{\"pid\":$DEAD,\"pgid\":null}" > $T/tmp/slot.lock
SWEEP=1500 start; touch $T/w/R-1.slot; sleep 3
ok "woken with a dead holder's lock in place" '[ "$(calls "send-text w1:p1")" = 1 ]'
stop
setup; echo '{"pid":' > $T/tmp/slot.lock; SWEEP=300 start; touch $T/w/R-1.slot; sleep 2
ok "half-written lock: no wake, waiter kept" '[ "$(calls "send-text")" = 0 ] && [ -e $T/w/R-1.slot ]'
stop

echo "== T7 gate requests are answered with a file, never run"
setup; touch $T/sup/engineer-gates-off; start; printf 'lane=x\nsha=abc\nout=%s/gout\n' $T > $T/req/x.req; sleep 1.5
ok "gates off: raw exit says skipped and request consumed" 'grep -q "^skipped" $T/gout/gate.raw.exit && [ ! -e $T/req/x.req ]'
rm $T/sup/engineer-gates-off; printf 'lane=y\nsha=abc\nout=%s/gout2\n' $T > $T/req/y.req; sleep 1.5
ok "gates on: raw exit says refused (no gate runner) and request consumed" 'grep -q "^refused" $T/gout2/gate.raw.exit && [ ! -e $T/req/y.req ]'
ok "no herdr call for gate requests" '[ ! -s $T/herdr.calls ]'
stop

echo "== T8 failed wakes: moved to .failed, reported once, never retried"
setup; start; touch $T/w/R-3.slot; sleep 1.5
ok "no pane in org: R-3 moved to .failed, nothing typed" '[ -e $T/w/R-3.slot.failed ] && [ "$(calls "send-text")" = 0 ]'
ok "supervisor told once" '[ "$(calls "agent prompt wFN:p9 \[supervisor-events\] could not wake R-3")" = 1 ]'
touch $T/wait-fail-a1; touch $T/w/R-1.slot; sleep 0.2; touch $T/w/R-2.slot; sleep 2
ok "agent wait failed: nothing typed into R-1, moved to .failed" '[ "$(calls "send-text w1:p1")" = 0 ] && [ -e $T/w/R-1.slot.failed ]'
ok "reservation released: the next waiter R-2 woken" '[ "$(calls "send-text w2:p2")" = 1 ]'
ok "each failed waiter attempted exactly once" '[ "$(calls "agent wait a1")" = 1 ] && [ "$(calls "agent wait a3")" = 0 ]'
stop
setup; mkdir $T/w/R-3.slot.failed; start; touch $T/w/R-3.slot; sleep 1.5
ok ".failed name taken: waiter stays .waking, message names it" '[ -f $T/w/R-3.slot.waking ] && [ "$(calls "Its waiter is now $T/w/R-3.slot.waking (never retried)")" = 1 ]'
stop
setup; ORGEV=$T/missing.jsonl start; touch $T/w/R-1.slot; sleep 1.5
ok "org log missing: waiter moved to .failed" '[ -e $T/w/R-1.slot.failed ]'
stop

echo "== T9 outbox: held while the operator is typing, delivered when the box empties"
setup; printf '\e[0m────────────\n\e[38;2;136;136;136m❯ \e[0mhalf typed text\n────────────\n' > $T/screen; BACKOFF=500 start
printf 'hello supervisor' > $T/sup/outbox/1.msg; sleep 1
ok "not delivered over typed text (negative control)" '[ "$(calls "agent prompt")" = 0 ] && [ -e $T/sup/outbox/1.msg ]'
printf '\e[0m────────────\n\e[38;2;136;136;136m❯ \e[0m\n────────────\n' > $T/screen; printf 'second' > $T/sup/outbox/2.msg; sleep 2
ok "both delivered once the box is empty, in order" '[ "$(grep "agent prompt" $T/herdr.calls | sed "s/.*wFN:p9 //" | tr "\n" ,)" = "hello supervisor,second," ] && [ -z "$(ls $T/sup/outbox)" ]'
stop
echo "== T9b no supervisor: bounded retries, then parked"
setup; touch $T/no-sup; SWEEP=300 BACKOFF=100 RETRIES=3 start; printf 'm1' > $T/sup/outbox/1.msg; sleep 2
ok "exactly 3 attempts, then parked" '[ "$(calls "agent list")" = 3 ] && grep -q "delivery parked after 3" $T/sup/watch-logs/supervisor-events.log'
touch $T/sup/engineer-gates-off; sleep 1.5
ok "parked: no further attempts, though the 300 ms sweep and other events keep running passes" '[ "$(calls "agent list")" = 3 ]'
printf 'm2' > $T/sup/outbox/2.msg; sleep 2
ok "a new message gives one more bounded series" '[ "$(calls "agent list")" = 6 ]'
rm $T/no-sup; touch $T/sup/outbox/RETRY; sleep 2
ok "RETRY unparks; both delivered" '[ "$(calls "agent prompt wFN:p9")" = 2 ] && [ -z "$(ls $T/sup/outbox)" ]'
stop

echo "== T10 single instance"
setup; start; SE_ROOT=$T SE_SUP=$T/sup SE_WAITERS=$T/w SE_GATE_REQ=$T/req SE_SLOT_LOCK=$T/tmp/slot.lock SE_ORG_EVENTS=$T/events.jsonl SE_HERDR=$T/herdr SE_LOCK_PORT=$PORT $NODE $SE 2>$T/second.err; rc=$?
ok "second instance exits 0 (no launchd restart) and says why" '[ $rc = 0 ] && grep -q "already running" $T/second.err'
stop

echo "== T11 restart: an interrupted wake is reported, the reservation is restored"
setup; touch $T/w/R-1.slot.waking; echo "{\"run\":\"R-1\",\"since\":0,\"until\":$(ms 60000)}" > $T/tmp/res; mkdir -p $T/sup/watch-logs; mv $T/tmp/res $T/sup/watch-logs/supervisor-events.reservation
touch $T/w/R-2.slot; start; sleep 1
ok "interrupted wake moved to .failed and reported" '[ -e $T/w/R-1.slot.failed ] && [ "$(calls "could not wake R-1")" = 1 ]'
ok "restored reservation holds the next waiter" '[ "$(calls "send-text w2:p2")" = 0 ] && [ -e $T/w/R-2.slot ]'
stop

echo "== T12 the waiters directory replaced: the sweep re-arms its watch, then events work again"
# the first sweep (about 1.5 s after start) re-arms; the waiter written after it must be claimed by a waiters event, not a sweep
setup; SWEEP=1500 TRACE=1 start; rm -rf $T/w; mkdir $T/w; sleep 1.2; touch $T/w/R-1.slot; sleep 1
ok "woken, and claimed by an event on the new directory (not a sweep)" '[ "$(calls "send-text w1:p1")" = 1 ] && grep -q "re-armed" $T/sup/watch-logs/supervisor-events.log && grep -q "claim R-1.slot (pass: waiters)" $T/sup/watch-logs/supervisor-events.log'
stop

echo "== T13 one run waiting on both a slot and a file: one wake at a time, no busy loop"
setup; echo 1.5 > $T/wait-delay; mkdir -p $T/out; echo 0 > $T/out/raw.exit; TRACE=1 start
touch $T/w/R-1.slot; echo $T/out/raw.exit > $T/w/R-1.file; sleep 4.5
ok "both woken, one after the other" '[ "$(calls "send-text w1:p1")" = 2 ] && [ "$(calls "agent wait a1")" = 2 ] && [ -z "$(ls $T/w)" ]'
ok "trace on, and few passes while the first wake waited (no claim/restore loop)" 'n=$(grep -c "pass (" $T/sup/watch-logs/supervisor-events.log); [ $n -gt 0 ] && [ $n -lt 40 ]'
stop

echo "== T14 malformed waiters: a directory is ignored; a relative .file path fails once, reported"
setup; mkdir $T/w/R-1.slot; start; touch $T/w/R-2.slot; sleep 1.5
ok "directory named R-1.slot ignored; R-2 woken; no stuck reservation" '[ -d $T/w/R-1.slot ] && [ "$(calls "send-text w1:p1")" = 0 ] && [ "$(calls "send-text w2:p2")" = 1 ] && [ -e $T/sup/watch-logs/supervisor-events.reservation ] && grep -q "\"until\":[0-9]" $T/sup/watch-logs/supervisor-events.reservation'
stop
setup; start; echo relative/raw.exit > $T/w/R-1.file; sleep 1.5
ok "relative path: .failed and one supervisor message" '[ -e $T/w/R-1.file.failed ] && [ "$(calls "could not wake R-1 (file): its first line is not an absolute path")" = 1 ]'
stop

echo "== T6c valid JSON lock, dead pid, malformed pgid: unknown, no wake"
setup; sh -c 'exit 0' & DEAD=$!; wait $DEAD; echo "{\"pid\":$DEAD,\"pgid\":\"x\"}" > $T/tmp/slot.lock; SWEEP=300 start; touch $T/w/R-1.slot; sleep 1.5
ok "no wake, waiter kept" '[ "$(calls "send-text")" = 0 ] && [ -e $T/w/R-1.slot ]'
stop

echo "== T7d answer fails and the .failed name is taken by a directory: request kept in place, reported once"
setup; mkdir $T/req/q.req.failed; SWEEP=300 start; printf 'lane=q\nsha=abc\nout=/dev/null/out\n' > $T/req/q.req; sleep 2
ok "request still in place, one message naming it" '[ -f $T/req/q.req ] && [ "$(calls "gate request q.req could not be answered (.*); kept as $T/req/q.req\. ")" = 1 ]'
stop

echo "== T6d valid JSON lock, dead pid, no pgid field: unknown, no wake"
setup; sh -c 'exit 0' & DEAD=$!; wait $DEAD; echo "{\"pid\":$DEAD}" > $T/tmp/slot.lock; SWEEP=300 start; touch $T/w/R-1.slot; sleep 1.5
ok "no wake, waiter kept" '[ "$(calls "send-text")" = 0 ] && [ -e $T/w/R-1.slot ]'
stop

echo "== T7c gate request whose answer cannot be written: kept as .failed, reported"
setup; start; printf 'lane=z\nsha=abc\nout=/dev/null/out\n' > $T/req/z.req; sleep 1.5
ok "request kept as z.req.failed and supervisor told" '[ -e $T/req/z.req.failed ] && [ "$(calls "gate request z.req could not be answered")" = 1 ]'
stop

echo "== T15 daemon stopped during a hung herdr call: the call is killed with it"
setup; touch $T/list-hang; start; printf 'm' > $T/sup/outbox/1.msg; sleep 1; HP=$(cat $T/list.pid)
ok "hung call running (precondition)" 'kill -0 $HP 2>/dev/null'
kill $PIDSE; wait $PIDSE 2>/dev/null; sleep 0.3
ok "hung call gone after the daemon stopped" '! kill -0 $HP 2>/dev/null'
echo "== T15b a call that ignores SIGTERM is SIGKILLed and reaped"
setup; touch $T/list-hang $T/list-ignore-term; HMS=500 start; printf 'm' > $T/sup/outbox/1.msg; sleep 1; HP=$(cat $T/list.pid)
ok "SIGTERM ignored: still running after its deadline (precondition)" 'kill -0 $HP 2>/dev/null && grep -q "deadline; SIGTERM" $T/sup/watch-logs/supervisor-events.log'
sleep 6
ok "SIGKILLed and reaped; queue not held" '! kill -0 $HP 2>/dev/null && grep -q "SIGKILL" $T/sup/watch-logs/supervisor-events.log && ! grep -q "survived SIGKILL" $T/sup/watch-logs/supervisor-events.log'
stop

# libuv gives children their stdio as unix socketpairs, so the leak shows as " unix " lines in lsof, not PIPE
echo "== T15c a grandchild holds the output pipe after herdr exits: pipes destroyed after 5 s, none leak"
setup; start; pipes(){ lsof -p $PIDSE 2>/dev/null | grep -c " unix "; }; P0=$(pipes); touch $T/list-grandchild; printf 'm' > $T/sup/outbox/1.msg; sleep 1
ok "pipes held while the grandchild lives (precondition)" '[ $(pipes) -gt $P0 ]'
sleep 5.5
ok "after the drain: logged, and pipe count back to the baseline" 'grep -q "pipes destroyed" $T/sup/watch-logs/supervisor-events.log && [ $(pipes) = $P0 ]'
kill $(cat $T/gc.pid) 2>/dev/null; stop

echo "== P1 runHerdr holds a call whose child reported an error until the child exits (exact-function probe)"
$NODE $D/probe-early-error.mjs $SE > /dev/null 2>&1; prc=$?
ok "call not ended before the exit" '[ $prc = 0 ]'
PT=$(mktemp -d /private/tmp/se-test-XXXX); sed 's/const settle = (v) => { result = v; if (exited) finish(v); };/const settle = (v) => { result = v; finish(v); };/' $SE > $PT/broken.mjs
$NODE $D/probe-early-error.mjs $PT/broken.mjs > /dev/null 2>&1; prc=$?
ok "probe fires on a copy that ends the call early (negative control)" '[ $prc = 1 ] && ! cmp -s $SE $PT/broken.mjs'

# ---- notify-watch.sh ------------------------------------------------------------------------------------------------------------
nwsetup(){
  T=$(mktemp -d /private/tmp/se-test-XXXX); mkdir -p $T/bin $T/w; echo idle > $T/status
  cat > $T/bin/org <<EOF
#!/bin/bash
case "\$1" in
  show) echo '{"run":{"item":"X-1","meta":{"agent":"a1"},"report_path":"$T/report.md"}}' ;;
  check) grep -q VALID "\$2" && echo "ok: checked" ;;
esac
exit 0
EOF
  cat > $T/bin/herdr <<EOF
#!/bin/bash
echo "\$*" >> $T/herdr.calls
case "\$1 \$2" in
  "agent wait") if [[ "\$*" == *"--until working"* ]]; then [ -x $T/on-working-wait ] && exec $T/on-working-wait "\$@"; exit 1; fi; exit 0 ;;
  "agent get") echo "{\"result\":{\"agent\":{\"agent_status\":\"\$(cat $T/status)\",\"tab_id\":\"\$(cat $T/tab 2>/dev/null)\"}}}" ;;
esac
exit 0
EOF
  chmod +x $T/bin/org $T/bin/herdr
}
nwrun(){ env -u HERDR_PANE_ID PATH=$T/bin:$PATH NW_OUTBOX=${OUTB:-$T/outbox} NW_WAITERS=$T/w GRACE=1 bash $NW R-1 --to supervisor-opus > $T/nw.out 2>&1; NWRC=$?; }
msgs(){ cat $T/outbox/*.msg 2>/dev/null | tr '\n' ' '; }
nmsg(){ local c; c=$(cat $T/outbox/*.msg 2>/dev/null | grep -c -- "$1"); echo ${c:-0}; }
VALID=$'---\noutcome: done\nverdict: PASS\n---\nVALID report'

echo "== NW1 valid report at the first stop"
nwsetup; print -r -- "$VALID" > $T/report.md; nwrun
ok "org-report queued, exit 0" '[ $NWRC = 0 ] && [ "$(nmsg "\[org-report\] run=R-1 item=X-1 outcome=done verdict=PASS")" = 1 ] && [ "$(ls $T/outbox | wc -l | tr -d " ")" = 1 ]'
echo "== NW2 idle without a report: one grace wait, then one alert"
nwsetup; nwrun
ok "grace wait also ends on blocked" '[ "$(grep -c -- "--until working --until blocked --timeout 1000" $T/herdr.calls)" = 1 ]'
ok "exactly one 'no report yet' alert" '[ "$(nmsg "stopped (idle): no report yet")" = 1 ] && [ "$(nmsg "is gone")" = 1 ] && [ $NWRC = 1 ]'
echo "== NW3 report written during the grace wait: checked, not called failing"
nwsetup; printf '#!/bin/bash\nprintf "%%s" "%s" > %s/report.md\nexit 1\n' "$VALID" $T > $T/on-working-wait; chmod +x $T/on-working-wait; nwrun
ok "org-report sent, no 'fails org check' alert" '[ "$(nmsg "\[org-report\]")" = 1 ] && [ "$(nmsg "fails org check")" = 0 ] && [ $NWRC = 0 ]'
echo "== NW4 idle, then blocked during the grace wait: alert at once"
nwsetup; printf '#!/bin/bash\n# only the grace wait (it has a timeout) sees the worker turn blocked; the later untimed wait ends as gone\n[[ "$*" == *--timeout* ]] || exit 1\necho blocked > %s/status\nexit 0\n' $T > $T/on-working-wait; chmod +x $T/on-working-wait; nwrun
ok "alert says blocked" '[ "$(nmsg "stopped (blocked): no report yet")" = 1 ]'
echo "== NW7 report written and worker blocked during the grace wait: the report is checked first"
nwsetup; printf '#!/bin/bash\n[[ "$*" == *--timeout* ]] || exit 1\nprintf "%%s" "%s" > %s/report.md\necho blocked > %s/status\nexit 0\n' "$VALID" $T $T > $T/on-working-wait; chmod +x $T/on-working-wait; nwrun
ok "org-report sent, no 'fails org check' alert" '[ "$(nmsg "\[org-report\]")" = 1 ] && [ "$(nmsg "fails org check")" = 0 ] && [ $NWRC = 0 ]'
echo "== NW5 waiter file present: no alert"
nwsetup; touch $T/w/R-1.slot; nwrun
ok "no stopped alert while the worker waits on supervisor-events" '[ "$(nmsg "stopped")" = 0 ] && grep -q "waiting on supervisor-events" $T/nw.out'
echo "== NW6 outbox cannot be written: exit 1, no tab closed"
nwsetup; echo t9 > $T/tab; print -r -- "$VALID" > $T/report.md; OUTB=/dev/null/outbox nwrun
ok "exit 1, says not queued, no tab close (the stub offers tab t9)" '[ $NWRC = 1 ] && grep -q "not queued" $T/nw.out && [ "$(grep -c "tab close" $T/herdr.calls)" = 0 ]'

# ---- the two kernel locks (real lock files, held for a moment) ------------------------------------------------------------------
# dispatch.sh runs with org and herdr stubs that fail, and promote.sh is a copy whose lane.mjs promote is `false`, so even a broken lock
# cannot start an org run or a promotion.
LT=$(mktemp -d /private/tmp/se-test-XXXX); mkdir $LT/bin; echo brief > $LT/brief.md
printf '#!/bin/bash\nexit 1\n' > $LT/bin/org; cp $LT/bin/org $LT/bin/herdr; chmod +x $LT/bin/*
dispatch(){ out=$(PATH=$LT/bin:$PATH zsh $SUPD/dispatch.sh SE-TEST lane-none route harn model eff $LT/brief.md $LT/report.md 2>&1); rc=$?; }
echo "== L1 dispatch.sh refuses while its lock is held; nothing stale after the holder exits"
: >> /private/tmp/bch-cloak-dispatch.flock
zsh -c 'zmodload zsh/system; zsystem flock -f fd /private/tmp/bch-cloak-dispatch.flock; sleep 3' & LH=$!; sleep 0.5
dispatch
ok "held: exit 3 before anything else" '[ $rc = 3 ] && print -r -- "$out" | grep -q "another dispatch is starting"'
wait $LH; dispatch
ok "holder gone: passes the lock (negative control; stops at the stub herdr)" '[ $rc = 1 ] && print -r -- "$out" | grep -q "notify target supervisor-opus not found"'
echo "== L2 promote.sh refuses with 75 while its lock is held"
sed 's#node scripts/lane/lane.mjs promote $T#false#' $SUPD/promote.sh > $LT/promote.sh
ok "test copy cannot promote" '! grep -q "node scripts/lane/lane.mjs promote" $LT/promote.sh'
: >> /private/tmp/bch-cloak-promote.flock
zsh -c 'zmodload zsh/system; zsystem flock -f fd /private/tmp/bch-cloak-promote.flock; sleep 3' & LH=$!; sleep 0.5
out=$(zsh $LT/promote.sh se-test-fake 2>&1); rc=$?
ok "held: exit 75" '[ $rc = 75 ] && print -r -- "$out" | grep -q "another promote.sh is running"'
wait $LH; out=$(zsh $LT/promote.sh se-test-fake 2>&1); rc=$?; rm -rf /private/tmp/se-test-fake-promote
ok "holder gone: passes the lock (negative control; the stubbed promote fails)" '[ $rc = 1 ] && print -r -- "$out" | grep -q "promote se-test-fake failed"'

echo "passed=$pass failed=$fail"
[ $fail = 0 ]
