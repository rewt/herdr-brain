import * as W from './workspace.mjs';
const ws = W.loadWorkspace(process.argv[2]);
const bch = W.resolveProject(ws, '/Users/rewt/development/bastian/bch-cloak');
console.log('ignored now:', JSON.stringify(W.effective(ws, bch, { lanes: { max_workers: 2 }, memory: { min_free_percent: 10 }, approvals: { reserved: ['prover'] } }).ignored.map(i => i.key)));
for (const home of ['/Users/rewt/.herdr-monitor', '/Users/firstname.lastname-long/.herdr-monitor']) for (const name of ['herdr-brain', 'some-longer-project-name-2cc165']) {
  const p = { area: `${home}/p/${name}`, identity: name };
  const t = W.runTemp({ home }, p, 'R-1512', 60);
  console.log(home.length, name.padEnd(32), 'natural', t.natural.length, '-> chosen', t.chosen, t.length, 'socket room', t.socket_room);
}
