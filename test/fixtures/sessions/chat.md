# chat

Offline desired configuration; reading this file grants no authority.

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "Session",
  "metadata": {
    "name": "workspace-chat",
    "uid": "example-main-chat",
    "namespace": "rewt/herdr-brain",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "home",
    "role": "chat",
    "standardSlot": "chat",
    "route": "executive",
    "launch": {
      "harness": "claude",
      "model": "opus",
      "effort": "high"
    },
    "personality": {
      "profile": "project-conversation",
      "instructions": "Discuss project choices clearly; turn authorized work into the existing intake path."
    },
    "intent": {
      "kind": "conversation",
      "purpose": "Operator conversation for this workspace"
    },
    "context": [
      {
        "source": "identity-instructions",
        "required": true
      },
      {
        "source": "project-cold-start",
        "required": true,
        "limit": 6
      },
      {
        "source": "latest-chat-handoff",
        "required": false
      }
    ],
    "memory": {
      "recordLessons": true,
      "claudeMem": {
        "mode": "off"
      },
      "handoff": "on-explicit-rotation"
    },
    "permissions": {
      "owner": "native",
      "profileRef": "identity-default"
    },
    "logs": {
      "serviceRef": "rewt/logs/herdr-brain",
      "subscribe": [
        "operator-requested-summary"
      ]
    },
    "lifecycle": {
      "scope": "operator-conversation",
      "automaticRetirement": "never",
      "reset": "close-and-respawn-at-safe-boundary",
      "restartPolicy": "on-confirmed-exit-with-context-evidence",
      "recovery": {
        "knownNativeSession": "resume",
        "freshContext": "declared-safe-boundary-with-handoff",
        "missingEvidence": "hold"
      },
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
