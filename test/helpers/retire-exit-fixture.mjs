import fs from 'node:fs';
import { fixture } from './retire-fixture.mjs';
import { sessionBindFact } from './session-bind.mjs';
import { loadEvents } from '../../lib/store.mjs';
import { fold } from '../../lib/state.mjs';

// A native worker whose registry entry disappears when its exit command runs.
export function exitFixture(t, { bound = false } = {}) {
  const f = fixture(t);
  f.state.agents[0].agent = 'codex';
  f.state.agents[0].agent_status = 'idle';
  f.state.panes[0].terminal_id = 'term';
  f.state.exitMode = 'exit'; f.state.unregisterOnExit = true;
  f.state.screen = fs.readFileSync(new URL('../../supervisor/test/fixtures/codex-empty.ansi', import.meta.url), 'utf8');
  f.state.info = { shell_pid: 1, foreground_processes: [{ name: 'codex', pid: 2 }], process_tree_complete: true,
    process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' },
      { pid: 2, ppid: 1, identity: 'native', state: 'S', command: '[codex]' },
      { pid: 3, ppid: 2, identity: 'helper', state: 'S', command: '[node]' }] };
  if (bound) {
    const [item, start, report, closed] = loadEvents(f.org).events;
    delete start.meta.agent_session_id;
    Object.assign(start.meta, { dispatch_attempt: 'attempt', dispatch_journal: `${f.org}/dispatch/attempt.json`,
      dispatch_project: f.common, dispatch_record: f.org });
    const recorded = { type: 'run.updated', id: 'R-1', meta: { ...start.meta }, seq: 3, at: start.at, by: 'test' };
    const before = [item, start, recorded], state = fold(before);
    const bind = sessionBindFact(state.runs.get('R-1'), state, { seq: 4, at: Date.parse(start.at) + 1000, by: 'test' });
    const events = [...before, bind, { ...report, seq: 5 }, { ...closed, seq: 6 }];
    fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  }
  f.save();
  return f;
}
