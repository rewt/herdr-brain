// Importing console controllers and facts never requires optional UI packages.
// Only starting the minimal profile loads its Ink renderer.
let pending;
export function loadMinimalRenderer() {
  return pending ??= Promise.all([import('react'), import('./minimal-view.mjs'), import('./detail-view.mjs')])
    .then(([{ default: React }, minimal, detail]) => ({ ...minimal, ...detail,
      sessionTree: props => React.createElement(minimal.SessionView, props) }))
    .catch(error => { pending = null; throw error; });
}
