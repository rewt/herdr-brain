# engineer-worker

Offline desired configuration; reading this file grants no authority.

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "Session",
  "metadata": {
    "name": "worker-docs-install-guidance",
    "uid": "template-engineer-worker",
    "namespace": "default/project",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "lane/example",
    "role": "engineer",
    "route": "engineer",
    "personality": {
      "profile": "lane-engineer",
      "instructions": "Complete the authorized item, preserve evidence, and keep this session available for correction rounds."
    },
    "intent": {
      "kind": "work-item",
      "item": "ENG-232",
      "purpose": "Correct the stale dependency-install guidance"
    },
    "context": [
      {
        "source": "identity-instructions",
        "required": true
      },
      {
        "source": "run-brief",
        "required": true
      },
      {
        "source": "item-lessons",
        "required": true
      },
      {
        "source": "latest-review",
        "required": false
      },
      {
        "source": "item-handoff",
        "required": false
      }
    ],
    "memory": {
      "recordLessons": true,
      "claudeMem": {
        "mode": "off"
      },
      "handoff": "before-context-loss"
    },
    "permissions": {
      "owner": "native",
      "profileRef": "identity-default"
    },
    "logs": {
      "serviceRef": "project/logs",
      "subscribe": [
        "authorized-correction-ready"
      ],
      "delivery": "existing-dispatch-only"
    },
    "lifecycle": {
      "scope": "work-item",
      "afterReport": "park-awaiting-review",
      "corrections": "reuse-same-session",
      "retainUntil": "landed-or-explicit-disposition",
      "resetWhileParked": false,
      "automaticRetirement": "safe-planner-after-disposition",
      "restartPolicy": "on-confirmed-exit-resume-known-session",
      "recovery": {
        "freshContextWhileItemOpen": "explicit-recovery-disposition-only",
        "missingEvidence": "hold"
      },
      "reset": "never-while-work-item-open",
      "onRefusal": "hold"
    },
    "execution": {
      "host": "herdr",
      "billing": "subscription",
      "modelApi": "forbidden"
    }
  }
}
```
