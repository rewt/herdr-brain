# Reviewer example

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "Session",
  "metadata": {
    "name": "review-docs-install-guidance-round-1",
    "uid": "template-reviewer-round-1",
    "namespace": "default/project",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "lane/example",
    "role": "reviewer",
    "route": "review",
    "personality": {
      "profile": "lane-reviewer",
      "instructions": "Use lanes/docs/REVIEW_TEMPLATE.md as the authoritative reviewer personality, rendered for this review round."
    },
    "intent": {
      "kind": "work-item",
      "item": "ENG-232",
      "purpose": "Independently review the authorized change for this item"
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
        "source": "product-file",
        "path": "lanes/docs/REVIEW_TEMPLATE.md",
        "required": true
      }
    ],
    "memory": {
      "recordLessons": true,
      "claudeMem": {
        "mode": "off"
      },
      "handoff": "private-review-record"
    },
    "permissions": {
      "owner": "native",
      "profileRef": "read-only"
    },
    "logs": {
      "serviceRef": "project/logs",
      "subscribe": [],
      "delivery": "existing-dispatch-only"
    },
    "lifecycle": {
      "scope": "work-item",
      "afterReport": "park-awaiting-verdict-ingestion",
      "corrections": "new-reviewer-session",
      "retainUntil": "verdict-ingested-or-explicit-disposition",
      "resetWhileParked": false,
      "automaticRetirement": "safe-planner-after-disposition",
      "restartPolicy": "on-confirmed-exit-resume-known-session",
      "recovery": {
        "freshContextWhileItemOpen": "explicit-recovery-disposition-only",
        "missingEvidence": "hold"
      },
      "reset": "never-before-verdict-ingestion",
      "onRefusal": "hold"
    },
    "execution": {
      "host": "herdr",
      "billing": "subscription",
      "modelApi": "forbidden"
    },
    "tools": {
      "input": "preloaded-scoped-files",
      "allowed": [
        "write-own-review-output"
      ]
    }
  }
}
```
