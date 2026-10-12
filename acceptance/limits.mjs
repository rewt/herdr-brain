import fs from 'node:fs';
import path from 'node:path';
import { LoadTimeout, isTimeout, loadReason } from './load.mjs';

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
  // Never collapse parent segments before resolving symlinks. Reject traversal
  // conservatively, even when it could turn out to stay inside scratch.
  if (!path.isAbsolute(file) || file.split(path.sep).includes('..')) return false;
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync.native(root); } catch { return false; }
  let ancestor = file;
  while (true) {
    try {
      const relative = path.relative(canonicalRoot, fs.realpathSync.native(ancestor));
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    } catch (error) {
      if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) return false;
      // A dangling symlink is an existing, unresolved entry, not a missing
      // scratch child. Stop rather than peeling past it into an owned parent.
      try { fs.lstatSync(ancestor); return false; }
      catch (missing) { if (missing.code !== 'ENOENT') return false; }
      ancestor = path.dirname(ancestor);
    }
  }
}
function scratchEnvironmentError(error, scratchRoots) {
  if (!scratchRoots.length || !environmentCode.test(`${error.code ?? ''} ${error.message}`)) return false;
  const paths = [error.path, error.dest,
    ...[...error.message.matchAll(/['"](\/[^'"\r\n]+)['"]|(?:^|\n)npm error path ([^\r\n]+)/g)].map((match) => match[1] ?? match[2])]
    .filter((file) => file !== undefined);
  // Mixed or unresolved paths cannot prove this is solely scratch I/O.
  return paths.length > 0 && paths.every((file) => typeof file === 'string'
    && scratchRoots.some((root) => scratchPath(file, root)));
}
function independentAssertionFailure(message) {
  // Read diagnostics belonging to a failed TAP result, never success names or
  // arbitrary mentions in combined output. A process can fail an assertion and
  // subsequently hit its teardown deadline; the assertion retains precedence.
  return message.split(/(?=^[ \t]*(?:not )?ok \d+[ \t-])/m).some((block) =>
    /^[ \t]*not ok \d+[ \t-]/.test(block)
    && /^[ \t]*(?:code:[ \t]*['"]?ERR_ASSERTION\b|name:[ \t]*['"]?AssertionError\b)/m.test(block));
}
export function commandFailure(message, { scratchRoot, scratchRoots = scratchRoot ? [scratchRoot] : [], error, load } = {}) {
  if (isProductBoundary(message)) return new ProductBoundary(message);
  if (independentAssertionFailure(message)) {
    const failure = new Error(message); failure.code = 'ERR_ASSERTION'; return failure;
  }
  if (isHarnessBoundary(message) || scratchEnvironmentError({ ...error, message }, scratchRoots)) return new HarnessLimit(message);
  // Successful test names and unrelated diagnostics can mention timeouts.
  // Only the process API's typed timeout establishes a child deadline here.
  return error?.code === 'ETIMEDOUT'
    ? new LoadTimeout(message, load) : new Error(message);
}

export function classifyFailure(error, { cleanup = false, scratchRoot, scratchRoots = scratchRoot ? [scratchRoot] : [], load } = {}) {
  if (error instanceof ProductBoundary || isProductBoundary(error.message)) return { status: 'FAIL', origin: 'product', detail: error.message };
  if (error.code === 'ERR_ASSERTION') return { status: 'FAIL', origin: 'product', detail: error.message };
  const measured = error instanceof LoadTimeout ? error.load : load;
  if ((error instanceof LoadTimeout || (error instanceof HarnessLimit && isTimeout(error.message))) && measured?.heavy) {
    return { status: 'PENDING', origin: 'harness', detail: `${loadReason(measured)}; ${error.message}` };
  }
  if (error instanceof HarnessLimit || cleanup || scratchEnvironmentError(error, scratchRoots)) return { status: 'PENDING', origin: 'harness', detail: error.message };
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
