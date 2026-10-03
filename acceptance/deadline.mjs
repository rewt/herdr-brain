// Scratch workers import this local bridge. The runner copies the shared
// implementation alongside them, keeping their allowance independent of config.
export { loadFactor, loadTimeout } from '../lib/deadline.mjs';
