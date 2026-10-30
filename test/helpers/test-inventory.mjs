// One live candidate inventory for focused planners, independent of tier placement.
import { execFileSync } from 'node:child_process';

export const safeInputPath = file => typeof file === 'string' && file.length > 0 &&
  !/^(?:\/|[A-Za-z]:)/.test(file) && !/[\\\x00-\x1f\x7f]/u.test(file) &&
  file.split('/').every(part => part && part !== '.' && part !== '..');

export function testInventory(files) {
  if (!Array.isArray(files) || files.length > 10000 || files.some(file => !safeInputPath(file))) {
    throw Error('affected-test inventory requires at most 10000 safe relative paths');
  }
  return [...new Set(files.filter(file => file.endsWith('.test.mjs')))].sort();
}

export function trackedTestInventory(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  return { files, tests: testInventory(files) };
}
