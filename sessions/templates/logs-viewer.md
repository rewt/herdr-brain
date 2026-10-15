# logs-viewer

Offline desired configuration; reading this file grants no authority.

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "LogViewer",
  "metadata": {
    "name": "workspace-logs",
    "uid": "template-logs-viewer",
    "namespace": "default/project",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "home",
    "role": "logs",
    "standardSlot": "logs",
    "paneSlot": "viewer",
    "viewer": "brain-structured-events",
    "intent": {
      "kind": "view",
      "purpose": "Inspect this workspace and its project event stream"
    },
    "context": [
      {
        "source": "workspace-event-filter",
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
