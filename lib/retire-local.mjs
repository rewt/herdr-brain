// External preflight seals. Verification reads metadata, never evidence payloads.
import fs from 'node:fs';
import path from 'node:path';

function stamp(file, recursive, omit, inertLinkParents, root = true) {
  let s;
  try { s = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const identity = [s.dev, s.ino, s.birthtimeMs, s.mode, s.size, s.mtimeMs, s.ctimeMs];
  if (s.isSymbolicLink()) {
    // regularJsonFiles ignores these immediate directory entries. Retain their
    // identity and link text as inert inventory, never read their destinations.
    if (!root && inertLinkParents.has(path.dirname(file))) return [identity, fs.readlinkSync(file)];
    throw Error(`redirected removal input ${file}; keep`);
  }
  if (recursive && s.isDirectory()) return [identity, fs.readdirSync(file).sort().filter(n => !omit.has(n))
    .map(n => [n, stamp(path.join(file, n), true, omit, inertLinkParents, false)])];
  return identity;
}

// Directory metadata detects additions/removals, file ctime detects edits even
// with restored mtime. Authority redirects remain uncertainty. Only ignored
// immediate entries in explicitly named receipt directories can be inert links;
// root inputs and redirected receipt directories always refuse. Evidence links
// are preserved by the evidence verifier, with their lstat identities.
export function sealRemovalInputs(files, { evidence = false, inertLinkParents = [] } = {}) {
  const inert = new Set(inertLinkParents.map(file => path.resolve(file)));
  const read = file => {
    if (!evidence) return stamp(file, true, new Set(), inert);
    const walk = f => {
      const s = fs.lstatSync(f);
      const identity = [s.dev, s.ino, s.birthtimeMs, s.mode, s.size, s.mtimeMs, s.ctimeMs];
      return s.isDirectory() ? [identity, fs.readdirSync(f).sort().filter(n => f !== file || n !== '.git')
        .map(n => [n, walk(path.join(f, n))])] : identity;
    };
    return walk(file);
  };
  const inputs = [...new Set(files.filter(Boolean))].map(file => [file, JSON.stringify(read(file))]);
  return () => {
    for (const [file, saved] of inputs) if (JSON.stringify(read(file)) !== saved)
      throw Error(`removal preflight input changed: ${file}; prepare and observe again; lane kept`);
  };
}
