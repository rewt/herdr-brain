import { pad, clip, wrap, sanitize, charWidth } from '../lib/text.mjs';
import {
  lists,
  selected,
  identity,
  counts,
  goals,
  tasks,
  openItems,
  sessions,
  runs,
  lanes,
  byId,
  goalOf,
  projects,
} from './model.mjs';
import {
  actions,
  browserViews,
  destinations,
  relationActions,
} from './controller.mjs';
export const palette = {
  bg: '#101820',
  fg: '#dce4e8',
  muted: '#98a9b4',
  focus: '#80c6df',
  attention: '#efbd76',
  selected: '#293e4b',
};
const keyHit = (input, key) => ({ type: 'key', input, key });
export function frame(s, W = 100, H = 40) {
  W = Math.max(1, W);
  H = Math.max(1, H);
  const grid = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => ({ text: ' ', fg: 'fg', bg: 'bg' })),
  );
  const hits = [];
  const areas = [];
  let maxScroll = 0;
  const put = (x, y, text, w = W - x, style = {}) => {
    if (y < 0 || y >= H) return;
    let col = x;
    for (const ch of clip(sanitize(text), Math.max(0, w))) {
      const cw = charWidth(ch);
      if (col >= 0 && col + cw <= W) {
        grid[y][col] = { text: ch, fg: 'fg', bg: 'bg', ...style };
        for (let n = 1; n < cw; n++) grid[y][col + n] = { text: '', ...style };
      }
      col += cw;
    }
  };
  const hit = (x, y, w, target, h = 1) => hits.push({ x, y, w, h, target });
  const button = (x, y, text, target, active = false) => {
    put(x, y, text, W - x, { fg: active ? 'focus' : 'muted', bold: active });
    hit(x, y, text.length, target);
    return x + text.length + 1;
  };
  const rule = (y) => put(0, y, '─'.repeat(W), W, { fg: 'muted' });
  const bar = (y, buttons) => {
    let x = 1;
    for (const b of buttons) {
      if (x + b[0].length > W) break;
      x = button(x, y, b[0], b[1], b[2]);
    }
  };
  const totals = counts(s);
  if (W < 80 || H < 23) {
    put(0, 0, `Needs you: ${totals.needs} across all projects`);
    put(0, 2, 'Resize to 80 columns and 24 rows.');
    button(0, 4, '[q Quit]', keyHit('q'));
    return finish();
  }
  bar(0, [
    ['herdr-brain / demo', keyHit('0')],
    [`[p ${s.scope}]`, keyHit('p')],
    ['[: Screens]', keyHit(':')],
    ['[b Back]', keyHit('b')],
    ['[q Quit]', keyHit('q')],
    ['[R Refresh]', keyHit('R')],
  ]);
  bar(1, [
    [`[! Needs you ${totals.needs}]`, keyHit('!'), true],
    [`${totals.read} to read`, { type: 'destination', view: 'inbox' }],
    [`${totals.later} later`, { type: 'destination', view: 'later' }],
    [`[s Sessions ${sessions.length}]`, keyHit('s')],
    ['all projects', keyHit('!')],
    [`[${lanes.length} Lanes]`, { type: 'destination', view: 'lanes' }],
  ]);
  const title =
    s.view === 'board'
      ? `${s.scope} > ${s.goal ?? 'All goals'} > ${s.task ?? 'All tasks'} > Open items`
      : ({
          inbox: 'Needs you / all projects / filters cleared',
          later: 'Saved for later / all projects',
          detail: 'Read one thing / return to the same row',
          peek: 'Session screen / fixture capture',
          lanes: 'Lanes and worktrees',
          history: 'Today / finished and decided',
          scope: 'Choose a project',
          screens: 'Choose a screen',
          search: 'Find in the focused column',
          reply: 'Reply / draft stays here until reviewed',
          confirm: 'Review the action',
          actions: 'Actions for this row',
          help: 'Keys and mouse',
        }[s.view] ?? s.view);
  put(1, 2, title, W - 2, { fg: 'muted' });
  rule(3);
  const browsing = browserViews.includes(s.view);
  const sessionHeight = browsing ? (H >= 40 ? 13 : 10) : H >= 40 ? 8 : 6;
  const sessionY = H - sessionHeight - 4;
  const bodyY = 4;
  const bodyH = Math.max(3, sessionY - bodyY);
  const all = lists(s);
  function panel(name, label, list, x, y, w, h, format) {
    areas.push({ name, x, y, w, h });
    button(
      x,
      y,
      clip(`${s.focus === name ? '>' : ' '} ${label}`, w),
      { type: 'focus', area: name },
      s.focus === name,
    );
    const selectedRow = selected(s, name);
    const at = Math.max(
      0,
      list.findIndex((r) => identity(r) === identity(selectedRow)),
    );
    const cap = h - 2,
      offset = Math.max(
        0,
        Math.min(list.length - cap, at - Math.floor(cap / 2)),
      );
    if (!list.length)
      put(x + 1, y + 1, clip('None here. ! opens all.', w - 2), w - 2, {
        fg: 'muted',
      });
    list.slice(offset, offset + cap).forEach((row, i) => {
      const is = identity(row) === identity(selectedRow);
      const active = is && s.focus === name;
      put(
        x,
        y + 1 + i,
        pad(`${active ? '>' : is ? '*' : ' '} ${format(row, w - 4)}`, w - 2),
        w - 2,
        { bg: active ? 'selected' : 'bg', fg: active ? 'focus' : 'fg' },
      );
      put(x + w - 2, y + 1 + i, ' >', 2, { fg: 'muted' });
      hit(x, y + 1 + i, w - 2, { type: 'row', area: name, row });
      hit(x + w - 2, y + 1 + i, 2, {
        type: 'row',
        area: name,
        row,
        open: true,
      });
    });
    const range = list.length
      ? `${offset + 1}-${Math.min(offset + cap, list.length)} / ${list.length}`
      : '0 rows';
    put(x + 1, y + h - 1, range, w - 2, { fg: 'muted' });
  }
  const basic = (r, w) =>
    r.id ? `${r.id} ${clip(r.title, w - r.id.length - 1)}` : r.title;
  const taskFormat = (r, w) =>
    !r.id
      ? r.title
      : `${pad(r.id, 6)} ${clip(r.title, w - 15)} ${pad(r.status, 7)}`;
  const openFormat = (r, w) => {
    const proj = 8,
      tag = 8,
      id = 7,
      desc = Math.max(3, w - proj - tag - id - 3);
    return `${pad(r.id, id)} ${pad(r.title, desc)} ${pad(r.project, proj)} ${pad(r.tag, tag)}`;
  };
  if (s.view === 'board') {
    const wide = W >= 100;
    const showGoals = wide || s.focus === 'goals';
    if (wide) {
      const a = W >= 140 ? 28 : 21,
        b = W >= 140 ? 36 : 27;
      panel(
        'goals',
        `Goals ${all.goals.length - 1}`,
        all.goals,
        0,
        bodyY,
        a,
        bodyH,
        basic,
      );
      put(a, bodyY, '│', 1, { fg: 'muted' });
      panel(
        'tasks',
        `Tasks ${all.tasks.length - 1}`,
        all.tasks,
        a + 1,
        bodyY,
        b,
        bodyH,
        taskFormat,
      );
      panel(
        'open',
        `Open items ${all.open.length}`,
        all.open,
        a + b + 2,
        bodyY,
        W - a - b - 2,
        bodyH,
        openFormat,
      );
      for (let y = bodyY; y < sessionY; y++) {
        put(a, y, '│', 1, { fg: 'muted' });
        put(a + b + 1, y, '│', 1, { fg: 'muted' });
      }
    } else {
      const a = 26;
      panel(
        showGoals ? 'goals' : 'tasks',
        showGoals
          ? `Goals ${all.goals.length - 1}`
          : `Tasks ${all.tasks.length - 1}`,
        showGoals ? all.goals : all.tasks,
        0,
        bodyY,
        a,
        bodyH,
        showGoals ? basic : taskFormat,
      );
      panel(
        showGoals ? 'tasks' : 'open',
        showGoals
          ? `Tasks ${all.tasks.length - 1}`
          : `Open items ${all.open.length}`,
        showGoals ? all.tasks : all.open,
        a + 1,
        bodyY,
        W - a - 1,
        bodyH,
        showGoals ? taskFormat : openFormat,
      );
      for (let y = bodyY; y < sessionY; y++) put(a, y, '│', 1, { fg: 'muted' });
    }
  } else if (s.view === 'inbox' || s.view === 'later')
    panel(
      'open',
      `${s.view === 'inbox' ? 'Waiting on you + results' : 'Saved for later'} ${all.open.length}`,
      all.open,
      0,
      bodyY,
      W,
      bodyH,
      openFormat,
    );
  else if (s.view === 'lanes')
    panel(
      'lanes',
      'Lanes: topic / branch / ahead / behind / dirty / rebase',
      all.lanes,
      0,
      bodyY,
      W,
      bodyH,
      (r, w) =>
        clip(
          `${pad(r.topic, 22)} ${pad(r.branch, 18)} +${r.ahead} -${r.behind} ${r.dirty ? 'dirty' : 'clean'} ${r.rebase}`,
          w,
        ),
    );
  else if (s.view === 'history')
    panel(
      'history',
      'Finished and decided today',
      all.history,
      0,
      bodyY,
      W,
      bodyH,
      (r, w) => clip(`${r.id} ${r.title} ${r.project}`, w),
    );
  else {
    areas.push({ name: 'detail', x: 0, y: bodyY, w: W, h: bodyH });
    hit(0, bodyY, W, { type: 'focus', area: 'detail' }, bodyH);
    let lines = [];
    const add = (text = '', style = {}, target) => {
      for (const t of wrap(text, W - 4)) lines.push({ text: t, style, target });
    };
    const head = (text) => add(text, { fg: 'focus', bold: true });
    const detail = s.detail;
    if (s.view === 'detail') {
      head(
        `${s.focus === 'detail' ? '>' : ' '} ${detail.id ?? detail.name}  ${detail.title ?? detail.doing ?? detail.topic ?? ''}`,
      );
      if (detail.kind === 'waiting') {
        add('Summary', { fg: 'muted' });
        add(
          detail.data.digest?.explain ??
            detail.data.said ??
            'No summary recorded. Peek at the captured screen.',
        );
        add('Choices', { fg: 'muted' });
        for (const o of detail.data.digest?.options ?? [])
          add(
            ` [${o.key}] ${o.label}${String(o.key) === String(detail.data.digest?.recommend) ? '  <- recommended' : ''}`,
            {
              fg:
                String(o.key) === String(detail.data.digest?.recommend)
                  ? 'attention'
                  : 'fg',
            },
            { type: 'action', action: { verb: 'pick', option: o.key } },
          );
        add(`Why: ${detail.data.digest?.why ?? 'No reason recorded.'}`);
        const run = runs.find((r) => r.item === detail.task);
        add(
          `Related: ${detail.goal ?? 'No goal'} > ${detail.task ?? 'Goal-wide question'} > ${run?.run ?? 'No run'} > ${detail.project}`,
          { fg: 'muted' },
        );
        const operatorDraft = s.drafts[detail.key] ?? detail.data.unsent;
        const draft = operatorDraft ?? detail.data.suggestion;
        if (draft) {
          add(
            operatorDraft !== undefined
              ? 'Your draft / never sent'
              : 'Agent draft / never sent',
            { fg: 'attention' },
          );
          add(draft);
        }
        if (detail.data.next_step || detail.data.digest?.next_step)
          add(
            `Next: ${detail.data.next_step ?? detail.data.digest.next_step}`,
            { fg: 'muted' },
          );
        if (detail.data.meta?.stage)
          add(
            `Stage ${detail.data.meta.stage}; open stage 1. Questions stay visible across stages.`,
            { fg: 'muted' },
          );
        add('1-9 picks a choice; y always reviews the recommended choice.', {
          fg: 'muted',
        });
      } else if (detail.kind === 'goal' || detail.kind === 'item') {
        add(detail.kind === 'goal' ? 'Outcome' : 'Work', { fg: 'muted' });
        add(detail.title);
        add(
          `State: ${detail.status}   Priority: ${detail.priority}   Project: ${detail.project}`,
        );
        if (detail.meta?.stage)
          add(
            `Stage: ${detail.meta.stage}   Open stage: 1 (advisory in this view)`,
          );
        head('Acceptance');
        for (const a of detail.accept ?? []) add(`- ${a}`);
        add(
          `Budget: ${detail.budget?.tokens ?? 'unknown'} tokens, advisory; never a stop rule.`,
        );
        add(
          `Blocked by: ${detail.blocked_by?.join(', ') || 'nothing recorded'}`,
        );
        add(`Children: ${detail.children?.join(', ') || 'none'}`);
        add(`Runs: ${detail.runs?.join(', ') || 'none yet'}`);
        head('Latest direction');
        add(detail.notes?.at(-1)?.text ?? 'No direction recorded.');
        add('v browses related work without starting anything.', {
          fg: 'muted',
        });
      } else if (detail.name) {
        add(`${detail.kind} / ${detail.status} / up ${detail.up}`);
        add(`Doing: ${detail.doing}`);
        const run = runs.find((r) => r.agent === detail.name);
        add(
          `Serves: ${detail.task} ${byId(detail.task)?.title ?? 'No linked task'}`,
        );
        add(
          `Goal: ${goalOf(detail.task)} ${byId(goalOf(detail.task))?.title ?? ''}`,
        );
        add(
          `Run: ${run?.run ?? 'none'} / ${run?.model ?? 'unknown model'} / ${run?.effort ?? 'unknown effort'}`,
        );
        add(`Where: ${detail.cwd}`);
        add(`Herdr: ${detail.workspace} > ${detail.tab} > ${detail.pane}`);
        head('Last message');
        add(
          'The fixture session checked the failure path and recorded the remaining choice.',
        );
        add(`Brief: ${run?.brief_path ?? 'none'}`);
        add('Enter peeks here. g goes to the pane (simulated).', {
          fg: 'muted',
        });
      } else if (detail.branch) {
        add(`Branch: ${detail.branch}`);
        add(
          `Ahead ${detail.ahead}; behind ${detail.behind}; ${detail.dirty ? 'dirty' : 'clean'}; rebase ${detail.rebase}`,
        );
        add(`Worktree: ${detail.path}`);
        add('Reading this lane never promotes or rebases it.');
      } else {
        add(
          detail.data?.note ??
            detail.note ??
            detail.summary ??
            detail.text ??
            'No summary recorded.',
        );
        add(
          `Related task: ${detail.task ?? detail.id}; project: ${detail.project}`,
        );
        add(
          detail.kind === 'read'
            ? 'a marks this result read; opening it does not.'
            : 'This is recorded history.',
        );
      }
      for (const a of relationActions(detail))
        add(
          `[${a.key}] ${a.label}: ${a.row.title ?? a.row.name}`,
          { fg: 'focus' },
          { type: 'related', row: a.row },
        );
    } else if (s.view === 'peek') {
      head('> Peek / fixture capture, not a live connection');
      for (const l of (
        detail.data?.screen ??
        'Fixture session screen\nChecked saved work and recorded the next step.\nWaiting for the next instruction.'
      ).split('\n'))
        add(l);
      add(
        'b Back returns to the detail screen. g simulates going to the pane.',
      );
    } else if (s.view === 'help') {
      head('> The short map');
      for (const line of [
        '> is active focus; * retains a selection elsewhere; states are words.',
        'Tab / Shift-Tab or Left / Right: focus a column or the sessions.',
        'Up / Down or j / k: select; PageUp / PageDown: eight rows.',
        'Home / End: first / last row; in a reader these keys scroll.',
        'Enter: open detail. Click a row to select, its > to open.',
        'b or Esc: back; q: back from detail, quit from the overview.',
        '! opens the global inbox; p chooses project; : chooses a screen.',
        '/ finds in the focused list; 0 clears browse filters; t cycles task stage.',
        'Space clears the focused goal or task. s focuses sessions.',
        'Detail: 1-9 choices; y recommended; r reply; l later; x drop.',
        'd start a session; g go to pane; Enter peek; m all actions.',
        'Goal/task: v browse. G/T/S: linked goal, task, session.',
        'Result: a marks read. R explains that fixture data is fixed.',
        'Wheel selects/scrolls the region under the pointer. Headers focus.',
        'Editor: Tab visits field, Review, Cancel; Enter activates.',
        'Ctrl/Alt/prefix chords stay with Herdr. This demo never sends.',
      ])
        add(line);
    } else if (s.view === 'scope') {
      head('> Project scope');
      ['all', ...projects.map((p) => p.name)].forEach((p, i) =>
        add(
          `${i === s.menuIndex ? '>' : ' '} ${p} (${openItems.filter((o) => (p === 'all' || o.project === p) && o.kind === 'waiting' && !s.dismissed.includes(o.key) && !s.later.includes(o.key)).length} need you)`,
          { fg: i === s.menuIndex ? 'focus' : 'fg' },
          { type: 'scope', scope: p },
        ),
      );
      add('This changes browsing and sessions. Global counts stay global.');
    } else if (s.view === 'actions') {
      head('> Actions');
      actions(detail).forEach((a, i) =>
        add(
          `${i === s.menuIndex ? '>' : ' '} [${a.key}] ${a.label}`,
          { fg: i === s.menuIndex ? 'focus' : 'fg' },
          { type: 'menu', index: i },
        ),
      );
    } else if (s.view === 'confirm') {
      head('> Review / demo only');
      add(`${s.pending.label}`);
      add(`For: ${detail.id ?? detail.name} in ${detail.project}`);
      add(
        `Destination: ${detail.data?.session ?? (detail.name || 'organization answer')}`,
      );
      if (s.text) add(`Reply: ${s.text}`);
      add(
        s.pending.verb === 'drop'
          ? 'This removes the inbox entry. It does not close its task or stop a session.'
          : s.pending.verb === 'start'
            ? 'A session would investigate this question and return with choices.'
            : 'The prototype records this action in memory only.',
      );
      add(
        '[Enter Confirm demo action]',
        { fg: 'attention' },
        { type: 'submit' },
      );
      add('[b Cancel]', { fg: 'muted' }, { type: 'cancel' });
    } else if (['reply', 'search', 'screens'].includes(s.view)) {
      head(
        `> ${s.view === 'reply' ? 'Reply' : s.view === 'search' ? 'Find' : 'Screen name'}`,
      );
      add(
        `${s.control === 0 ? '>' : ' '} ${s.text || ''}${s.control === 0 ? '|' : ''}`,
        { fg: 'focus', bg: 'selected' },
        { type: 'control', index: 0 },
      );
      if (s.view === 'screens')
        destinations
          .filter((d) =>
            d.join(' ').toLowerCase().includes(s.text.toLowerCase()),
          )
          .forEach(([view, label], i) =>
            add(
              `${i === s.menuIndex ? '>' : ' '} ${label}`,
              { fg: i === s.menuIndex ? 'focus' : 'fg' },
              { type: 'destination', view },
            ),
          );
      add(
        `${s.control === 1 ? '>' : ' '} [Enter ${s.view === 'reply' ? 'Review reply' : 'Apply'}]`,
        { fg: 'focus' },
        { type: 'submit' },
      );
      add(
        `${s.control === 2 ? '>' : ' '} [Cancel]`,
        { fg: 'muted' },
        { type: 'cancel' },
      );
      add('Tab: field > Review/Apply > Cancel. Shift-Tab goes backwards.');
      add(
        'Letters are text while the field has focus; b cancels from a button.',
      );
    }
    const cap = bodyH - 1;
    maxScroll = Math.max(0, lines.length - cap);
    let offset = Math.min(s.scroll, maxScroll);
    if (s.view === 'actions')
      offset = Math.min(maxScroll, Math.max(0, s.menuIndex - cap + 3));
    lines.slice(offset, offset + cap).forEach((l, i) => {
      put(2, bodyY + i, l.text, W - 4, l.style);
      if (l.target) hit(2, bodyY + i, W - 4, l.target);
    });
    put(
      2,
      sessionY - 1,
      `${offset + 1}-${Math.min(offset + cap, lines.length)} / ${lines.length}${maxScroll ? '  j/k or wheel for more' : ''}`,
      W - 4,
      { fg: 'muted' },
    );
  }
  // Same repository groups and session columns as the existing console.
  rule(sessionY);
  areas.push({ name: 'sessions', x: 0, y: sessionY, w: W, h: sessionHeight });
  button(
    0,
    sessionY,
    `${s.focus === 'sessions' ? '>' : ' '} Sessions / ${s.scope} / ${all.sessions.length} shown`,
    { type: 'focus', area: 'sessions' },
    s.focus === 'sessions',
  );
  const narrow = W < 100;
  const who = (r) => {
    const run = runs.find((x) => x.agent === r.name);
    return `${r.kind === 'codex' ? 'Codex' : 'Claude'} ${run?.model ?? 'unknown'}`;
  };
  const fmt = (r) =>
    narrow
      ? `${pad(r.name, 29)} ${pad(who(r), 18)} ${pad(r.status, 9)}`
      : W < 140
        ? `${pad(r.name, 21)} ${pad(who(r), 18)} ${pad(r.up, 5)} ${pad(r.status, 8)} ${pad(r.task, 7)} ${r.doing}`
        : `${pad(r.name, 24)} ${pad(who(r), 20)} ${pad(r.cwd.split('/').at(-1), 15)} ${pad(r.up, 5)} ${pad(r.status, 8)} ${pad(r.task, 7)} ${r.doing}`;
  put(
    2,
    sessionY + 1,
    narrow
      ? `${pad('SESSION', 29)} ${pad('WHO', 18)} STATE`
      : W < 140
        ? `${pad('SESSION', 21)} ${pad('WHO', 18)} ${pad('UP', 5)} ${pad('STATE', 8)} ${pad('SERVES', 7)} DOING`
        : `${pad('SESSION', 24)} ${pad('WHO', 20)} ${pad('WHERE', 15)} ${pad('UP', 5)} ${pad('STATE', 8)} ${pad('SERVES', 7)} DOING`,
    W - 4,
    { fg: 'muted' },
  );
  let rendered = [];
  let group = null;
  for (const row of all.sessions) {
    if (row.project !== group) {
      group = row.project;
      rendered.push({ group });
    }
    rendered.push({ row });
    if (narrow) rendered.push({ row, continuation: true });
  }
  const target = identity(selected(s, 'sessions'));
  const at = Math.max(
    0,
    rendered.findIndex((l) => l.row && identity(l.row) === target),
  );
  const cap = sessionHeight - 3;
  let contentCap = cap;
  let offset = Math.max(
    0,
    Math.min(rendered.length - contentCap, at - Math.floor(contentCap / 2)),
  );
  // A repeated group label consumes a line. Recompute the window at the smaller
  // capacity so the selected session cannot be displaced from the viewport.
  if (rendered[offset]?.row) {
    contentCap = cap - 1;
    offset = Math.max(
      0,
      Math.min(rendered.length - contentCap, at - Math.floor(contentCap / 2)),
    );
  }
  let visible = rendered.slice(offset, offset + contentCap);
  if (visible[0]?.row)
    visible = [{ group: visible[0].row.project }, ...visible];
  visible.forEach((l, i) => {
    const y = sessionY + 2 + i;
    if (l.group) {
      put(
        2,
        y,
        `${l.group} / ${all.sessions.filter((r) => r.project === l.group).length} sessions`,
        W - 4,
        { fg: 'muted' },
      );
      return;
    }
    const active = identity(l.row) === target && s.focus === 'sessions';
    put(
      0,
      y,
      pad(
        l.continuation
          ? `    ${l.row.task} / ${l.row.up} / ${l.row.doing}`
          : `${active ? '>' : ' '} ${fmt(l.row)}`,
        W - 2,
      ),
      W - 2,
      {
        fg: active ? 'focus' : l.continuation ? 'muted' : 'fg',
        bg: active ? 'selected' : 'bg',
      },
    );
    put(W - 2, y, ' >', 2, { fg: 'muted' });
    hit(0, y, W - 2, { type: 'row', area: 'sessions', row: l.row });
    hit(W - 2, y, 2, { type: 'row', area: 'sessions', row: l.row, open: true });
  });
  put(
    2,
    H - 5,
    `Sessions ${offset + 1}-${Math.min(offset + contentCap, rendered.length)} / ${rendered.length} lines; scroll here for more`,
    W - 4,
    { fg: 'muted' },
  );
  const shown = all.open?.filter((o) => o.kind === 'waiting').length ?? 0;
  const notice =
    s.message ||
    (browsing
      ? `Showing ${shown} of ${totals.needs} needing you; ! opens all. Task stages: ${s.stage}.`
      : 'Demo: actions stay in memory. Session list remains available below.');
  put(1, H - 4, notice, W - 2, { fg: s.message ? 'attention' : 'muted' });
  if (browsing) {
    bar(H - 3, [
      ['[Tab focus]', keyHit('', { tab: true })],
      ['[j/k select]', keyHit('j')],
      ['[Enter detail]', keyHit('', { return: true })],
      ['[/ Find]', keyHit('/')],
      ['[t Stage]', keyHit('t')],
    ]);
    bar(H - 2, [
      ...(s.view === 'board'
        ? [
            ['[Goals]', { type: 'focus', area: 'goals' }],
            ['[Tasks]', { type: 'focus', area: 'tasks' }],
            ['[Open items]', { type: 'focus', area: 'open' }],
          ]
        : []),
      ['[0 Clear filters]', keyHit('0')],
      ['[? Help]', keyHit('?')],
    ]);
  } else if (s.view === 'detail' || s.view === 'peek') {
    const available = actions(s.detail);
    bar(
      H - 3,
      available
        .filter((a) => ['y', 'r', 'l', 'x', 'd', 'a', 'v'].includes(a.key))
        .map((a) => [
          `[${a.key} ${{ y: 'Recommended', r: 'Reply', l: 'Later', x: 'Drop', d: 'Start session', a: 'Mark read', v: 'Browse' }[a.key]}]`,
          { type: 'action', action: a },
        ]),
    );
    const secondary = available.filter(
      (a) => a.key === 'g' || (a.key === 'Enter' && s.view !== 'peek'),
    );
    bar(H - 2, [
      ...secondary.map((a) => [
        `[${a.key} ${a.key === 'g' ? 'Go to pane' : 'Peek'}]`,
        { type: 'action', action: a },
      ]),
      ['[m Actions]', keyHit('m')],
      ...(s.later.includes(s.detail.key)
        ? [['[u Return to inbox]', keyHit('u')]]
        : []),
      ['[? Help]', keyHit('?')],
    ]);
  } else
    bar(H - 2, [
      ['[Enter Apply]', { type: 'submit' }],
      ['[Cancel]', { type: 'cancel' }],
      ['[? Help]', keyHit('?')],
    ]);
  bar(H - 1, [
    ['[b Back]', keyHit('b')],
    ['[! All needs you]', keyHit('!')],
    ['[s Sessions]', keyHit('s')],
    ['[: Screens]', keyHit(':')],
  ]);
  return finish();
  function finish() {
    const lines = grid.map((row) => {
      const spans = [];
      for (const c of row) {
        const last = spans.at(-1);
        if (
          last &&
          last.fg === c.fg &&
          last.bg === c.bg &&
          last.bold === c.bold
        )
          last.text += c.text;
        else spans.push({ ...c });
      }
      return { spans };
    });
    return { lines, hits, areas, maxScroll };
  }
}
export const plain = (f) =>
  f.lines
    .map((l) =>
      l.spans
        .map((s) => s.text)
        .join('')
        .trimEnd(),
    )
    .join('\n') + '\n';
