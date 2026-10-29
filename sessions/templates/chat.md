# chat

Offline desired configuration; reading this file grants no authority.

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "Session",
  "metadata": {
    "name": "workspace-chat",
    "uid": "template-chat",
    "namespace": "default/project",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "home",
    "role": "chat",
    "standardSlot": "chat",
    "route": "executive",
    "personality": {
      "profile": "project-conversation",
      "instructions": "One operator chat writes authorized requests and decisions directly to the owning record for the owning session. Pull status from the record; routine notices never go to chats. Only genuine pending operator questions use existing push delivery. The operator chooses which chat stays; quiet pane w3PD:p4 requires explicit operator confirmation. Around 200K context tokens, prepare a short recorded handoff and recycle only at a verified safe boundary through the existing native lifecycle guards."
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
      "serviceRef": "project/logs",
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
