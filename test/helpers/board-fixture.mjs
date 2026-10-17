import fs from 'node:fs';
import path from 'node:path';
import { fixtureFleet } from './offline-herdr.mjs';

export function boardFixture(t) {
  const parent = path.resolve(import.meta.dirname, '../../.lane/board-fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'case-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const slotEnvironment = ['MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH'];
  const previous = slotEnvironment.map(key => process.env[key]);
  for (const key of slotEnvironment) process.env[key] = path.join(root, 'fixture-slot.lock');
  t.after(() => slotEnvironment.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
  }));
  fixtureFleet(t, root);
  const write = (name, value) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
  };
  const log = write('logs/job.log', 'TAP version 13\n# duration_ms 1200\n');
  const row = () => ({ id: 'C1-PROMOTE-20261016', item: 'ENG-1517', lane: 'eng1517-example', kind: 'promotion', phase: 'stage',
    stage: { n: 3, m: 7 }, startedAt: '2026-10-16T12:00:00.000Z', phaseAt: '2026-10-16T12:01:00.000Z', endedAt: null,
    clocks: [{ label: 'code-ready to main', seconds: 5400, legacy: false }],
    status: { code: 'stage-running', text: 'step-012 running 340s mem_avail=6.1GB' },
    result: { exit: null, main: null, candidate: 'a'.repeat(40) }, where: { pane: 'w2XS:p4', log }, worktree: root });
  const document = () => ({ schema: 'board-rows/v1', project: 'bch-cloak', generatedAt: '2026-10-16T12:02:00.000Z', rows: [row()] });
  return { root, write, log, row, document, options: { project: 'bch-cloak', roots: [root], panes: new Set(['w2XS:p4']) } };
}

export function brainFixture(t) {
  const f = boardFixture(t), common = path.join(f.root, 'common');
  const original = fs.readFileSync(new URL('../fixtures/board/brain.json', import.meta.url), 'utf8');
  const bundle = JSON.parse(original.replaceAll('@COMMON@', common).replaceAll('@ROOT@', f.root));
  const queueFile = f.write('common/promote/queue.json', bundle.queue);
  const trainFile = f.write('common/promote/batches/batch-1/train.json', bundle.train);
  const receiptFile = f.write('common/lane-validation/' + bundle.receipt.key + '.json', bundle.receipt);
  f.write('common/promote/batches/batch-1/train.log', bundle.log);
  f.write('common/promote/batches/batch-2/train.log', bundle.log);
  for (const dir of ['active', 'done', 'waiting']) fs.mkdirSync(path.join(f.root, dir));
  const project = { canonical: f.root, checkout: f.root, identity: common, name: 'herdr-brain', paths: [f.root] };
  const show = async (_project, _job, value) => /^R-\d+$/.test(value ?? '') ? { id: value, item: 'ENG-' + value.slice(2), meta: { pane: 'w2XS:p4', dispatch_token: 'PLANTED' }, workspace: f.root + '/waiting' } : value?.startsWith('ENG-') ? { id: value } : null;
  return { ...f, ...bundle, queueFile, trainFile, receiptFile, project, show, now: Date.parse('2026-10-16T13:00:00Z'),
    save() { fs.writeFileSync(queueFile, JSON.stringify(bundle.queue)); fs.writeFileSync(trainFile, JSON.stringify(bundle.train)); fs.writeFileSync(receiptFile, JSON.stringify(bundle.receipt)); } };
}
