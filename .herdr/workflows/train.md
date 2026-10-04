---
name: "Promotion train"
trigger: "promote-batch"
inputs: {"batch": {"required": true}}
permissions: ["train"]
---

# Promotion train

Drain the FIFO groups of batch {batch}. These argument arrays name commands
registered by the train host; they do not invoke a shell. The host owns the
promotion lock, bisection and durable Git recovery checkpoints.

## Steps

### prepare — Capture and replay reviewed lanes

Check canonical and lane cleanliness, STOP and record readiness. Capture the
authorized heads and replay in scratch, proving every tree with native Git.
Reuse a prepared checkpoint only while its base and captured inputs still match.

```json
{"command": ["train", "prepare"], "permission": "train"}
```

### validate — Prove the combined tree

Run configured preparation, then the promotion tier once on the exact scratch
tree. Reuse only the existing tree, command, environment and log proof. A red
gate stops this group; the host bisects in FIFO order and isolates red singletons.

```json
{"command": ["train", "validate"], "permission": "train"}
```

### integrate — Fast-forward the validated commit

Recheck canonical cleanliness, base, captured heads, scratch, STOP and record
readiness under the existing locks. Fast-forward to the exact validated commit.

```json
{"command": ["train", "integrate"], "permission": "train"}
```

### close — Finish integration bookkeeping

Adopt the proved lane replays and save promoted results. Queue cleanup and
supervisor delivery remain owned by the existing queue after the train returns.

```json
{"command": ["train", "close"], "permission": "train"}
```

## Gates

["validate"]

## On failure

Preserve original lane worktrees. Preparation or input refusals remain local to
their affected lanes. Bisect red combined gates with the existing FIFO algorithm.
An interrupted command leaves its step receipt running; inspect train.json and
train.log and resume with promote --drain. Only train checkpoints authorize
recovery; workflow receipts are display evidence. A lost fast-forward resumes
bookkeeping without another gate. Never push or create a merge commit.
