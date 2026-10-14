import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export function relativeFile(value) {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || value.includes('\0')) throw Error('expectation path must be relative to the desk');
  return value;
}
export function parseExpectations(opt) {
  const result = [];
  for (const value of opt.expect ?? ['exit=0']) {
    const match = /^exit=(\d+)$/.exec(value);
    if (!match || Number(match[1]) > 255) throw Error('--expect requires exit=0..255');
    result.push({ kind: 'exit', expected: Number(match[1]) });
  }
  for (const format of ['tap', 'vitest']) for (const value of opt[`expect-${format}`] ?? []) {
    for (const part of value.split(',')) {
      const match = /^(pass|fail|skip)(=|>=|<=)(\d+)$/.exec(part);
      if (!match) throw Error(`invalid ${format} totals expectation: ${part}`);
      result.push({ kind: 'totals', format, field: match[1], operator: match[2], expected: Number(match[3]) });
    }
  }
  for (const title of opt['expect-test'] ?? []) {
    if (!title.trim()) throw Error('expected test title must be nonempty');
    result.push({ kind: 'test', title });
  }
  for (const value of opt['expect-file'] ?? []) {
    const match = /^(.*)=([a-f0-9]{64})$/.exec(value);
    if (!match) throw Error('--expect-file requires REL_PATH=SHA256');
    result.push({ kind: 'file', path: relativeFile(match[1]), expected: match[2] });
  }
  for (const value of opt['expect-json'] ?? []) {
    const match = /^([^#]+)#([^=]*)=(.*)$/s.exec(value);
    if (!match || (match[2] && !match[2].startsWith('/')) || /~(?![01])/.test(match[2])) throw Error('--expect-json requires REL_PATH#/json/pointer=JSON');
    result.push({ kind: 'json', path: relativeFile(match[1]), pointer: match[2], expected: JSON.parse(match[3]) });
  }
  return result;
}

// Read only the command log: prepare output cannot satisfy a test expectation.
export async function testOutput(file) {
  const totals = { tap: null, vitest: null }, titles = new Set();
  if (!fs.existsSync(file)) return { totals, titles };
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (let line of lines) {
    line = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const tap = /^#\s+(pass|fail|skipped)\s+(\d+)\s*$/.exec(line);
    if (tap) (totals.tap ??= {})[tap[1] === 'skipped' ? 'skip' : tap[1]] = Number(tap[2]);
    if (/^\s*Tests\s+/.test(line)) {
      totals.vitest = { pass: 0, fail: 0, skip: 0 };
      for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
        totals.vitest[{ passed: 'pass', failed: 'fail', skipped: 'skip', todo: 'skip' }[match[2]]] += Number(match[1]);
      }
      if (!/\d+\s+(passed|failed|skipped|todo)/.test(line)) totals.vitest = null;
    }
    const title = /^\s*(?:not )?ok\s+\d+\s+-\s+(.+?)\s*$/.exec(line);
    if (title && !/\s+#\s*(SKIP|TODO)\b/i.test(title[1])) titles.add(title[1]);
    const vitest = /^\s*[✓✔×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?\s*$/.exec(line);
    if (vitest && !/\(\d+ tests?\)/.test(vitest[1])) titles.add(vitest[1]);
  }
  return { totals, titles };
}
function artifact(desk, relative) {
  const root = fs.realpathSync(desk), file = fs.realpathSync(path.join(root, relativeFile(relative)));
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw Error('expectation file is outside the desk or not a regular file');
  return file;
}
const equal = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
};
export async function evaluate(expectations, { desk, exit, signal, log }) {
  const output = await testOutput(log);
  const results = await Promise.all(expectations.map(async expectation => {
    let actual, passed = false;
    try {
      switch (expectation.kind) {
        case 'exit': actual = exit; passed = !signal && actual === expectation.expected; break;
        case 'totals':
          actual = output.totals[expectation.format]?.[expectation.field] ?? null;
          passed = actual !== null && (expectation.operator === '=' ? actual === expectation.expected : expectation.operator === '>=' ? actual >= expectation.expected : actual <= expectation.expected); break;
        case 'test': actual = output.titles.has(expectation.title); passed = actual; break;
        case 'file': actual = await fileSha256(artifact(desk, expectation.path)); passed = actual === expectation.expected; break;
        case 'json': {
          actual = JSON.parse(fs.readFileSync(artifact(desk, expectation.path), 'utf8'));
          for (const key of expectation.pointer ? expectation.pointer.slice(1).split('/').map(k => k.replaceAll('~1', '/').replaceAll('~0', '~')) : []) {
            if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, key)) throw Error('JSON field is absent');
            actual = actual[key];
          }
          passed = equal(actual, expectation.expected); break;
        }
        default: throw Error('unknown expectation');
      }
      return { ...expectation, actual, passed };
    } catch (error) { return { ...expectation, passed: false, error: error.message }; }
  }));
  return { totals: output.totals, expectations: results };
}
