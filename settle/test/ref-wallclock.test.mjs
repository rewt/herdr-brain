import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/ref-transaction.mjs';
process.env.ORG_ACTOR = 'ref-wallclock-test';
for (const stage of ['start', 'prepare', 'commit']) {
  test(`load 24 admits a ${stage} reply beyond the former fifteen-second ref-transaction deadline`, async t => {
    const f = fixture(t, stage, 'delayed'), started = Date.now();
    const r = await f.run();
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(Date.now() - started >= 15200, 'the actual transaction reply crossed the old limit');
    assert.equal(f.git(['rev-parse', f.plan.branch]), f.plan.to);
    assert.equal(f.git(['rev-parse', 'main']), f.plan.mainHead);
    assert.equal(f.git(['symbolic-ref', 'HEAD'], f.workspace), f.plan.branch);
    assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'to\n');
    assert.equal(fs.existsSync(f.headLock), false); assert.equal(fs.existsSync(f.indexLock), false);
    assert.deepEqual(fs.readFileSync(f.timers, 'utf8').trim().split('\n').map(JSON.parse), [90000, 90000, 90000]);
    const commands = fs.readFileSync(f.requests, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(commands.filter(command => command === stage).length, 1, 'a delayed mutation is never replayed');
  });
}
