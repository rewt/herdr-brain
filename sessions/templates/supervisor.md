# supervisor

Offline desired configuration; reading this file grants no authority.

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "Session",
  "metadata": {
    "name": "workspace-supervisor",
    "uid": "template-supervisor",
    "namespace": "default/project",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "home",
    "role": "supervisor",
    "standardSlot": "supervisor",
    "route": "executive",
    "personality": {
      "profile": "project-supervisor",
      "instructions": "Apply decision routing and handle exceptions. Status and milestones go to the owning record; routing policy sends routine notices to the model-free line and recorded owner through existing callbacks, never to a chat. Legacy line-service launches can still use --to brain-chat, and supervisor/line-notice-aggregate.mjs still selects brain-chat notices. ENG-939 owns the runtime migration; these instructions alone do not activate it. Around 200K context tokens, prepare a short recorded handoff and recycle only at a verified safe boundary through existing native lifecycle guards. Preserve active work, proofs, watchers, saved recipients and unresolved deliveries; do not relay ordinary work through chats."
    },
    "intent": {
      "kind": "coordination",
      "purpose": "Project supervision",
      "authorityRef": "canonical-project-supervisor"
    },
    "context": [
      {
        "source": "identity-instructions",
        "required": true
      },
      {
        "source": "supervisor-protocol",
        "required": true
      },
      {
        "source": "project-cold-start",
        "required": true,
        "limit": 6
      },
      {
        "source": "latest-supervisor-handoff",
        "required": false
      }
    ],
    "memory": {
      "recordLessons": true,
      "claudeMem": {
        "mode": "off"
      },
      "handoff": "before-replacement"
    },
    "permissions": {
      "owner": "native",
      "profileRef": "identity-default"
    },
    "logs": {
      "serviceRef": "project/logs",
      "subscribe": [
        "exception",
        "review-ready"
      ],
      "delivery": "durable-inbox-when-quiet"
    },
    "lifecycle": {
      "scope": "supervisor-decision-cycle",
      "automaticRetirement": "never",
      "reset": "close-and-respawn-at-safe-boundary",
      "restartPolicy": "on-confirmed-exit-with-context-evidence",
      "recovery": {
        "knownNativeSession": "resume",
        "freshContext": "declared-safe-boundary-with-handoff",
        "missingEvidence": "hold"
      },
      "onRefusal": "hold",
      "replicas": 1
    },
    "execution": {
      "host": "herdr",
      "billing": "subscription",
      "modelApi": "forbidden"
    }
  }
}
```
