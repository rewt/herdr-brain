// Read-only evidence check; evaluate the actual lane projection functions without dispatch.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, isAbsolute, relative, sep } from 'node:path';

const git = args => execFileSync('git', args, { encoding: 'utf8' });
const before = '196c6a2c7b1971cff08a49d680de1d48851a865a';
const base = git(['merge-base', before, 'main']).trim();
const source = fs.readFileSync('lanes/lane.mjs', 'utf8');
const sandbox = { Buffer, userInfo, homedir, hostname, basename, isAbsolute, relative, sep,
  realpathSync: fs.realpathSync, REPO_ROOT: process.cwd(), fail(message) { throw Error(message); } };
vm.createContext(sandbox);
vm.runInContext(source.slice(source.indexOf('const REVIEW_COMPLETE_MARKER ='), source.indexOf('async function waitForPrivateReview(')), sandbox);
const diff = git(['diff', '--unified=0', base, before, '--', 'console/**/*.mjs']);
let file, line;
const additions = [];
for (const row of diff.split('\n')) {
  if (row.startsWith('+++ b/')) file = row.slice(6);
  else if (row.startsWith('@@')) line = Number(/\+(\d+)/.exec(row)[1]);
  else if (row.startsWith('+') && !row.startsWith('+++')) additions.push({ file, line: line++, text: row.slice(1) });
  else if (row.startsWith(' ')) line++;
}
const characters = [...new Set(additions.flatMap(row => [...row.text].filter(c => c.codePointAt(0) > 126)))].sort((a,b) => a.codePointAt(0)-b.codePointAt(0));
const escapes = characters.map(c => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
for (const character of characters) assert.throws(() => sandbox.assertPublicPayloadRestrictions(character, 'projected payload'), /unsupported non-ASCII text/);
console.log(`Original added JavaScript characters rejected by production projection: ${escapes.join(', ')}`);
const rejected = additions.filter(row => /[^\x20-\x7e]/u.test(row.text));
console.log(`Original added JavaScript lines rejected: ${rejected.length}`);
let checked = 0;
for (const row of additions) {
  const current = fs.readFileSync(row.file, 'utf8').split('\n')[row.line - 1];
  sandbox.assertPublicPayloadRestrictions(current, 'projected payload');
  assert.equal(current.replace(/\\u([0-9a-f]{4})/gu, (match, digits) => characters.some(c => c.codePointAt(0) === parseInt(digits, 16)) ? String.fromCodePoint(parseInt(digits, 16)) : match), row.text);
  checked++;
}
console.log(`Current added JavaScript lines accepted and escape-decoded identical: ${checked}`);
const privatePath = process.argv[2];
if (!privatePath) throw Error('usage: node console/evidence/ENG-200-ascii/projection-check.mjs PRIVATE_REVIEW');
const record = fs.readFileSync(privatePath, 'utf8');
console.log(`Retained R-250 private review non-ASCII count: ${[...record].filter(c => c.codePointAt(0) > 127).length}`);
const expected = { head: before, topic: 'pipelines', round: 1, reviewId: /^Review ID: (.+)$/m.exec(record)[1],
  baseBranch: 'main', baseCommit: /^Base commit: (.+)$/m.exec(record)[1], path: process.cwd() };
const parsed = sandbox.validateReviewRecord(record, expected);
const projected = sandbox.sanitizeReviewProjection(parsed, expected);
console.log(`Retained R-250 private review full projection: accepted (${Buffer.byteLength(projected)} bytes); verdict ${parsed.verdict}`);
