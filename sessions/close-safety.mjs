// Herdr removes a workspace when its last tab closes. Ownership of the target
// tab is checked separately; any other tab in this exact workspace preserves it.
export function lastTabCloseVeto(observation, binding) {
  return observation.tabs.some(t => t.workspace_id === binding.workspace &&
    typeof t.tab_id === 'string' && t.tab_id && t.tab_id !== binding.tab) ? null :
    { code: 'last-tab-close', reason: `last-tab close refused: workspace ${binding.workspace} would be removed` };
}

export function unexpectedWorkspaceRemoval(observation, binding) {
  return observation.complete && !observation.errors?.length && observation.server === binding.server &&
    !observation.workspaces.some(w => w.workspace_id === binding.workspace) ?
    { code: 'unexpected-workspace-removal', reason: `unexpected workspace removal: ${binding.workspace}; hold, never respawn` } : null;
}
