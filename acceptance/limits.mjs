import fs from 'node:fs';
import path from 'node:path';

export class HarnessLimit extends Error {
  constructor(message) { super(message); this.name = 'HarnessLimit'; }
}

export class ProductBoundary extends Error {
  constructor(message) { super(message); this.name = 'ProductBoundary'; }
}
export class Pending extends Error {}
export const isHarnessBoundary = (text) => /acceptance_harness_limit|sandbox_apply: Operation not permitted|fs sandbox helper failed/.test(text);
export const isProductBoundary = (text) => /acceptance_product_boundary|acceptance_boundary|native-transport boundary:/.test(text);
const environmentCode = /\b(?:EACCES|EPERM|EROFS|ENOSPC|EDQUOT|EMFILE|ENFILE|EIO)\b/;
function scratchPath(file, root) {
  if (!path.isAbsolute(file)) return false;
  // Resolve existing ancestors too: missing npm/node_modules paths are common,
  // but a symlink pointing outside scratch must never qualify.
  let ancestor = path.resolve(file);
  while (true) {
    try {
      const relative = path.relative(fs.realpathSync(root), fs.realpathSync(ancestor));
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    } catch (error) {
      if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) return false;
      ancestor = path.dirname(ancestor);
    }
  }
}
function scratchEnvironmentError(error, scratchRoot) {
  if (!scratchRoot || !environmentCode.test(`${error.code ?? ''} ${error.message}`)) return false;
  const paths = [error.path, error.dest,
    ...[...error.message.matchAll(/['"](\/[^'"\r\n]+)['"]|(?:^|\n)npm error path ([^\r\n]+)/g)].map((match) => match[1] ?? match[2])];
  return paths.some((file) => typeof file === 'string' && scratchPath(file, scratchRoot));
}
export function commandFailure(message, { scratchRoot, error } = {}) {
  if (isProductBoundary(message)) return new ProductBoundary(message);
  return isHarnessBoundary(message) || scratchEnvironmentError({ ...error, message }, scratchRoot)
    ? new HarnessLimit(message) : new Error(message);
}
export function classifyFailure(error, { cleanup = false, scratchRoot } = {}) {
  if (error instanceof ProductBoundary || isProductBoundary(error.message)) return { status: 'FAIL', origin: 'product', detail: error.message };
  if (error instanceof HarnessLimit || cleanup || scratchEnvironmentError(error, scratchRoot)) return { status: 'PENDING', origin: 'harness', detail: error.message };
  return { status: error instanceof Pending ? 'PENDING' : 'FAIL', origin: 'product', detail: error.message };
}

// Dependent cases retain the cause and classification of their prerequisites.
export function requirePrerequisite(results, key) {
  const result = results.find((v) => v.key === key);
  if (result?.status === 'PASS') return;
  const reason = result ? `prerequisite ${key} (${result.name}): ${result.detail}` : `prerequisite ${key} has no result`;
  if (!result || result.origin === 'harness') throw new HarnessLimit(reason);
  if (result.status === 'PENDING') throw new Pending(reason);
  throw commandFailure(reason);
}

// Preserve the original kind of failure while collecting independent checks.
export function requireSuccessfulChecks(results) {
  const failures = results.filter((v) => v.status !== 'PASS');
  if (!failures.length) return;
  const product = failures.filter((v) => v.status === 'FAIL');
  const chosen = product.length ? product : failures;
  const detail = chosen.map((v) => `${v.key} (${v.name}): ${v.detail}`).join('; ');
  if (product.length) throw commandFailure(detail);
  if (chosen.some((v) => v.origin === 'harness')) throw new HarnessLimit(detail);
  throw new Pending(detail);
}
