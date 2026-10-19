# Project home workspace

Composition only. Copy the four complete session templates alongside this file
inside the canonical project's `.sessions/` directory and commit them together.
Native permissions, enrollment and authority remain owner-managed.

## Manifest

```json
{
  "apiVersion": "brain.herdr.dev/v1alpha1",
  "kind": "Workspace",
  "metadata": {
    "name": "home",
    "uid": "project-home",
    "namespace": "default/project",
    "generation": 1
  },
  "spec": {
    "workspaceRef": "home",
    "sessions": ["chat.md", "supervisor.md", "logs-viewer.md", "logs-triage.md"],
    "routeProfileRef": "project-default",
    "validationProfileRef": "project-default"
  }
}
```
