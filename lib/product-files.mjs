// One distribution inventory for release copies and copied product fixtures.
// Copy whole runtime modules so adding a relative import needs no fixture edit.
import fs from 'node:fs';
import path from 'node:path';

const modules = ['bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping', 'dispatch', 'watch',
  'settle', 'promote', 'test-slot', 'supervisor', 'brain', 'contrib'];
const omit = new Set(['node_modules', 'test', 'tests', 'docs', '.git', '.org', '.lane']);
// Data read by bundled commands belongs to the distribution even under docs/.
const assets = ['package.json', 'lanes/docs/REVIEW_TEMPLATE.md'];

export function productFiles(root) {
  const result = [];
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!omit.has(name) && !name.endsWith('.test.mjs')) visit(path.join(relative, name));
    } else if (stat.isFile()) result.push(relative);
    else throw new Error(`runtime source is not a plain file: ${file}`);
  }
  // Older releases and deliberately small test products may lack modules.
  for (const name of [...modules, ...assets]) if (fs.existsSync(path.join(root, name))) visit(name);
  if (fs.existsSync(path.join(root, 'lanes/lane.mjs')) && !fs.existsSync(path.join(root, 'lanes/docs/REVIEW_TEMPLATE.md'))) throw new Error('product runtime is missing the lane review template');
  return result.sort((a, b) => a.localeCompare(b));
}

export function copyProduct(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of productFiles(source)) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
}
