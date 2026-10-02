import { DESK_FIELDS, DESK_DEFAULTS, deskFallback, parseDeskValue, validateDeskSettings } from '../../settle/config.mjs';
import { mergeRoutesConfig } from '../../lanes/routes.mjs';
export const DESK_LABELS = ['Review route', 'Fix route', 'Review round cap', 'Review timeout (seconds)', 'Reuse stopped worker', 'Notify supervisor'];
export function settingsEditor(kind, doc, project, extra = {}) {
  const base = { kind, project: { ...project }, revision: doc.revision, target: doc.target, config: doc.config, field: 0, confirm: false, busy: false, ...extra };
  if (kind === 'desks') return { ...base, title: 'Settle and review desks', labels: DESK_LABELS, original: doc.settings,
    values: DESK_FIELDS.map(key => doc.settings[key] === undefined ? '' : String(doc.settings[key])) };
  if (kind === 'add') return { ...base, title: 'Add route', labels: ['Name', 'Kind', 'Model', 'Effort'], values: ['', '', '', ''] };
  if (kind === 'pool') return { ...base, title: 'Primary pool', labels: ['Primary pool'], values: [doc.config.selection_policy?.primary_implementation_pool ?? ''] };
  if (kind === 'policy') {
    const choice = doc.config.selection_policy?.by_task_class?.[extra.task];
    return { ...base, title: 'Task route selection', labels: ['Task class', 'Pool (blank for every pool)', 'Route'], values: [extra.task ?? '', extra.pool ?? '', typeof choice === 'string' ? choice : choice?.[extra.pool] ?? ''] };
  }
  if (kind === 'defaults') return { ...base, title: 'Dispatch defaults', labels: ['Kind', 'Model', 'Effort', 'Launch arguments (JSON array)'],
    original: doc.config.dispatch ?? {}, values: ['kind', 'model', 'effort'].map(key => doc.config.dispatch?.[key] ?? '').concat(JSON.stringify(doc.config.dispatch?.args ?? [])) };
  return { ...base, title: 'Always launch arguments', labels: ['Kind', 'Arguments (JSON array)'], values: [extra.harness ?? '', JSON.stringify(doc.config.always_args?.[extra.harness] ?? [])] };
}
function array(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Launch arguments must be a JSON array of strings.');
  return value;
}
export function settingsReview(edit) {
  const v = edit.values.map(text => text.trim()), config = edit.config;
  if (edit.kind === 'desks') {
    const patch = {}, unset = [], settings = { ...edit.original };
    DESK_FIELDS.forEach((key, i) => {
      if (!v[i]) { if (Object.hasOwn(settings, key)) { unset.push(key); delete settings[key]; } }
      else { const value = parseDeskValue(key, v[i]); if (value !== settings[key]) patch[key] = value; settings[key] = value; }
    });
    validateDeskSettings(settings, config);
    const display = (obj, key) => obj[key] ?? DESK_DEFAULTS[key] ?? deskFallback(key, config);
    return { patch, unset, writes: Boolean(Object.keys(patch).length || unset.length), lines: DESK_FIELDS.map((key, i) => `${DESK_LABELS[i]}: ${display(edit.original, key)} → ${display(settings, key)}`) };
  }
  let command = edit.kind, value, next;
  if (command === 'add') {
    if (!v[0] || !v[1]) throw new Error('Route name and kind are required.');
    if (Object.hasOwn(config.routes ?? {}, v[0])) throw new Error(`Route already exists: ${v[0]}`);
    value = { name: v[0], route: Object.fromEntries(['kind', 'model', 'effort'].flatMap((key, i) => v[i + 1] ? [[key, v[i + 1]]] : [])) };
    next = { routes: { [value.name]: value.route } };
  } else if (command === 'pool' || command === 'policy') {
    value = structuredClone(config.selection_policy ?? { by_task_class: Object.hasOwn(config.routes ?? {}, 'review') ? { review: 'review' } : {} });
    if (command === 'pool') { if (v[0]) value.primary_implementation_pool = v[0]; else delete value.primary_implementation_pool; }
    else {
      if (!v[0] || !v[2]) throw new Error('Task class and route are required.');
      const prior = value.by_task_class[v[0]];
      value.by_task_class = { ...value.by_task_class, [v[0]]: v[1] ? { ...(typeof prior === 'object' ? prior : {}), [v[1]]: v[2] } : v[2] };
    }
    command = 'policy'; next = { selection_policy: value };
  } else if (command === 'defaults') {
    value = { ...edit.original };
    ['kind', 'model', 'effort'].forEach((key, i) => { if (v[i]) value[key] = v[i]; else delete value[key]; });
    const args = array(v[3]); if (args.length || Object.hasOwn(edit.original, 'args')) value.args = args;
    next = { dispatch: value };
  } else {
    if (!v[0]) throw new Error('Kind is required.');
    value = { ...config.always_args, [v[0]]: array(v[1]) }; next = { always_args: value };
  }
  mergeRoutesConfig([config, next]);
  const field = Object.keys(next)[0];
  const selections = command === 'policy' ? ['Resulting task selections:', ...Object.entries(value.by_task_class).flatMap(([task, choice]) => typeof choice === 'string' ? [`${task} → ${choice}`] : Object.entries(choice).map(([pool, route]) => `${task} · ${pool} → ${route}`))] : [];
  return { command, value, writes: command === 'add' || JSON.stringify(next[field]) !== JSON.stringify(config[field]),
    lines: command === 'add' ? [`New route ${value.name}: ${value.route.kind} · ${value.route.model ?? 'harness default'} · ${value.route.effort ?? 'harness default'}`] : edit.labels.map((label, i) => `${label}: ${edit.initial[i] || '(default)'} → ${v[i] || '(default)'}`).concat(selections) };
}
