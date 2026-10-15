# Project triage status

The non-home logs triage position is a model-free reference view.

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "LogViewer",
  "metadata": {
    "name": "workspace-triage-status",
    "uid": "template-triage-status",
    "namespace": "default/project",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "lane/example",
    "role": "triage-status",
    "standardSlot": "logs",
    "paneSlot": "triage",
    "viewer": "project-triage-status",
    "intent": {
      "kind": "view",
      "purpose": "Read the home project triage status without a model session"
    },
    "context": [
      {
        "source": "project-triage-status",
        "required": true
      }
    ],
    "memory": {
      "mode": "none"
    },
    "permissions": {
      "owner": "native",
      "profileRef": "identity-default",
      "serviceAccess": "read"
    },
    "logs": {
      "serviceRef": "project/logs",
      "start": "saved-cursor-or-recent",
      "scope": "workspace"
    },
    "lifecycle": {
      "scope": "workspace-slot",
      "automaticRetirement": "never",
      "restartPolicy": "on-confirmed-exit-with-backoff",
      "onRefusal": "hold"
    }
  }
}
```
