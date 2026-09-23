// Tab visits regions; arrows visit controls within the selected region.
export const REGION_ORDER = ['project', 'checkouts', 'tabs', 'sessions', 'goals', 'tasks', 'needs', 'content', 'terminal', 'actions', 'tools'];

export function regionFor({ id, bodyRow, y, rail, from }) {
  if (id === 'scope' || id === 'home' || id === 'checkouts') return 'project';
  if (id.startsWith('space:')) return 'checkouts';
  if (bodyRow != null) return 'content';
  if (y === 4 || id.startsWith('tab:')) return 'tabs';
  if (rail && from < rail) return 'tools';
  return 'actions';
}

export function focusControl(state, control) {
  if (!control) return;
  state.focus = control.id;
  state.regionFocus[control.region] = control.id;
  if (control.bodyRow != null) {
    if (control.bodyRow < state.scroll) state.scroll = control.bodyRow;
    else if (control.bodyRow >= state.scroll + state.frame.bodyHeight) state.scroll = control.bodyRow - state.frame.bodyHeight + 1;
  }
}

export function moveRegion(state, amount) {
  const controls = state.frame?.controls ?? [];
  const regions = REGION_ORDER.filter(r => controls.some(c => c.region === r));
  if (!regions.length) return;
  const current = controls.find(c => c.id === state.focus);
  if (current) state.regionFocus[current.region] = current.id;
  const index = regions.indexOf(current?.region);
  const next = regions[(index + amount + regions.length) % regions.length];
  const candidates = controls.filter(c => c.region === next);
  const preferred = next === 'tabs' ? state.view === 'output' ? `tab:${state.tab}` : `view:${state.view}` : null;
  focusControl(state, candidates.find(c => c.id === state.regionFocus[next]) ?? candidates.find(c => c.id === preferred) ?? candidates[0]);
}

export function moveWithin(state, amount) {
  const controls = state.frame?.controls ?? [], current = controls.find(c => c.id === state.focus);
  const region = current?.region ?? 'content';
  const candidates = controls.filter(c => c.region === region);
  const index = candidates.findIndex(c => c.id === state.focus);
  focusControl(state, candidates[Math.max(0, Math.min(candidates.length - 1, (index < 0 ? 0 : index) + amount))]);
}

export function pickerEntries(state) {
  const query = (state.picker?.query ?? '').toLowerCase();
  return [...state.projects.filter(p => `${p.name} ${p.root ?? p.cwd}`.toLowerCase().includes(query)).map(p => ({ id: `project:${p.id}`, label: p.name, path: p.root ?? p.cwd, selected: p.id === state.projectId })),
    { id: 'folder', label: '+ Open folder', path: 'Inspect an existing folder' },
    { id: 'ideas', label: 'Start with an idea', path: 'Onboarding design · not connected yet' }];
}
