import { resolveLaunchRoute } from '../../lanes/routes.mjs';

// Compare raw editable fields, then resolve the resulting configuration with
// the same argument compatibility rules used by an actual lane launch.
export function routeReview(edit) {
  const patch = Object.fromEntries(['kind', 'model', 'effort'].flatMap((field, i) => {
    const value = edit.values[i].trim();
    return value && value !== edit.original[field] ? [[field, value]] : [];
  }));
  const config = { ...edit.config, routes: { ...edit.config.routes,
    [edit.name]: { ...edit.config.routes[edit.name], ...patch } } };
  return { patch, before: resolveLaunchRoute(edit.config, { route: edit.name }),
    after: resolveLaunchRoute(config, { route: edit.name }),
    writes: Boolean(edit.suggested || Object.keys(patch).length) };
}
