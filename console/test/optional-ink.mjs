import test from 'node:test';

let packages;
try { packages = await Promise.all([import('react'), import('ink')]); }
catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !/Cannot find package '(?:react|ink)'/.test(error.message)) throw error;
}
export const React = packages?.[0].default;
export const ink = packages?.[1];
export const inkTest = (name, options, fn) => {
  if (typeof options === 'function') { fn = options; options = {}; }
  return test(name, { ...options, skip: !packages ? 'Optional console Ink/React dependencies absent; run npm --prefix console ci to exercise this view' : options?.skip }, fn);
};
export const minimalView = packages ? await import('../modern/minimal-view.mjs') : {};
