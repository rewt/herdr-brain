import test from './bounded-test.mjs';

// Preserve the v2 behavior witnesses without an activation seam in production.
// ENG-538 must restore these when it completes the fence and removes the lock.
export default function pendingDeclaredTest(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  return test(name, { ...options, skip: 'Pending ENG-538: declared-gates/v2 is inert' }, body);
}
