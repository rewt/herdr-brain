import {
  lists,
  selected,
  identity,
  openItems,
  byId,
  goalOf,
  sessions,
  projects,
} from './model.mjs';
import { moveGoal, goalFor, policyFor, decisionFor } from './autonomy.mjs';
export const browserViews = ['board', 'inbox', 'later', 'lanes', 'history', 'decisions'];
export const destinations = [
  ['board', 'Overview'],
  ['inbox', 'Needs you - all projects'],
  ['later', 'Saved for later'],
  ['history', 'Today: finished and decided'],
  ['lanes', 'Lanes and worktrees'],
  ['decisions', 'Next work: executive decisions'],
];
export function initialState() {
  return {
    view: 'board',
    scope: 'harbor',
    goal: null,
    task: null,
    stage: 'all',
    focus: 'open',
    cursor: {
      goals: null,
      tasks: null,
      open: 'queue:Q-1',
      sessions: 'import-recovery',
      lanes: 'lane-1',
    },
    query: '',
    scroll: 0,
    stack: [],
    dismissed: [],
    later: [],
    drafts: {},
    message: '',
    menuIndex: 0,
    control: 0,
    autonomy: { order: {}, policies: {}, requested: {} },
  };
}
export function push(s, change) {
  const { stack, ...snapshot } = s;
  return {
    ...s,
    ...change,
    scroll: 0,
    query: '',
    control: 0,
    stack: [...stack, snapshot],
  };
}
export function back(s) {
  if (!s.stack.length)
    return { ...s, goal: null, task: null, query: '', message: '' };
  return {
    ...s.stack.at(-1),
    stack: s.stack.slice(0, -1),
    dismissed: s.dismissed,
    later: s.later,
    drafts: s.drafts,
    autonomy: s.autonomy,
    message: s.message,
  };
}
export function rowDetail(s, row) {
  if (!row || (!identity(row) && !row.name)) return s;
  return push(s, { view: 'detail', detail: row, focus: 'detail' });
}
export function pick(s, area, row) {
  const next = {
    ...s,
    focus: area,
    cursor: { ...s.cursor, [area]: identity(row) },
    query: s.focus === area ? s.query : '',
  };
  if (area === 'goals') {
    next.goal = row.id;
    next.task = null;
    next.cursor.tasks = null;
    next.cursor.open = null;
  }
  if (area === 'tasks') {
    next.task = row.id;
    next.cursor.open = null;
  }
  return next;
}
function move(s, delta, edge) {
  const list = lists(s)[s.focus] ?? [];
  if (!list.length) return s;
  const at = Math.max(
    0,
    list.findIndex((r) => identity(r) === identity(selected(s))),
  );
  return pick(
    s,
    s.focus,
    list[
      Math.max(
        0,
        Math.min(
          list.length - 1,
          edge === 'home' ? 0 : edge === 'end' ? list.length - 1 : at + delta,
        ),
      )
    ],
  );
}
export function relationActions(row) {
  const task =
    row.task ?? (row.kind === 'item' && row.role !== 'human' ? row.id : null);
  const goal = row.goal ?? goalOf(row.id ?? task);
  const session = row.name
    ? sessions.find((s) => s.name === row.name)
    : row.data?.session
      ? sessions.find((s) => s.name === row.data.session)
      : sessions.find((s) => s.task === task);
  return [
    { key: 'G', label: 'Related goal', row: byId(goal) },
    { key: 'T', label: 'Related task', row: byId(task) },
    { key: 'S', label: 'Related session', row: session },
  ].filter((a) => a.row && identity(a.row) !== identity(row));
}
export function actions(row) {
  if (!row) return [];
  const waiting = row.kind === 'waiting';
  const session = row.name
    ? row
    : sessions.find((s) => s.name === row.data?.session);
  const result = [];
  if (waiting) {
    for (const o of (row.data.digest?.options ?? []).slice(0, 9))
      result.push({
        key: String(o.key),
        label: o.label,
        verb: 'pick',
        option: o.key,
      });
    if (row.data.digest?.recommend)
      result.push({
        key: 'y',
        label: 'Recommended choice',
        verb: 'recommended',
      });
    result.push(
      { key: 'r', label: 'Reply in your words', verb: 'reply' },
      { key: 'l', label: 'Save for later', verb: 'later' },
      { key: 'x', label: 'Drop from this inbox', verb: 'drop' },
      { key: 'd', label: 'Start a session to work it out', verb: 'start' },
    );
  }
  if (row.kind === 'read')
    result.push({ key: 'a', label: 'Mark read', verb: 'read' });
  if (session)
    result.push(
      { key: 'g', label: 'Go to the pane', verb: 'go' },
      { key: 'Enter', label: 'Peek at the screen', verb: 'peek' },
    );
  if (row.name)
    result.push({ key: 'r', label: 'Reply to the session', verb: 'reply' });
  if (row.kind === 'goal' || row.kind === 'item')
    result.push({ key: 'v', label: 'Browse related work', verb: 'browse' });
  if (row.kind === 'goal')
    result.push(
      { key: 'a', label: 'Authority', verb: 'authority' },
      { key: '[', label: 'Earlier goal', verb: 'earlier' },
      { key: ']', label: 'Later goal', verb: 'later-goal' },
    );
  if (row.kind === 'item' || row.name)
    result.push({ key: 'w', label: 'Why this work', verb: 'why-work' });
  if (row.kind === 'dispatch-decision') {
    result.push({ key: 'a', label: 'Current authority', verb: 'authority' });
    if (row.question) result.push({ key: 'o', label: 'Open authority question', verb: 'question' });
  }
  result.push(...relationActions(row).map((a) => ({ ...a, verb: 'related' })));
  return result;
}
function act(s, a) {
  const row = s.detail;
  if (!a || !row) return s;
  if (a.verb === 'earlier' || a.verb === 'later-goal')
    return moveGoal(s, row, a.verb === 'earlier' ? -1 : 1);
  if (a.verb === 'authority') {
    const goal = byId(row.goal) ?? goalFor(row.id ?? row.task);
    return goal ? push(s, { view: 'authority', detail: goal, focus: 'detail' }) : s;
  }
  if (a.verb === 'question') return rowDetail(s, openItems.find((q) => q.key === row.question));
  if (a.verb === 'why-work') {
    const decision = decisionFor(row);
    return decision ? rowDetail(s, decision) : { ...s, message: 'No pickup decision recorded for this work. No rationale inferred from its session.' };
  }
  if (a.verb === 'related') return rowDetail(s, a.row);
  if (a.verb === 'peek')
    return s.view === 'peek' ? s : push(s, { view: 'peek', focus: 'detail' });
  if (a.verb === 'go')
    return {
      ...s,
      message: `Demo: would focus ${row.name ?? row.data?.session}. Use Herdr's last-pane binding to return.`,
    };
  if (a.verb === 'browse')
    return push(s, {
      view: 'board',
      goal: row.kind === 'goal' ? row.id : goalOf(row.id),
      task: row.kind === 'item' ? row.id : null,
      focus: row.kind === 'goal' ? 'tasks' : 'open',
      cursor: {
        ...s.cursor,
        goals: row.kind === 'goal' ? row.id : goalOf(row.id),
        tasks: row.kind === 'item' ? row.id : null,
        open: null,
      },
    });
  if (a.verb === 'reply')
    return push(s, {
      view: 'reply',
      focus: 'detail',
      text:
        s.drafts[identity(row)] ??
        row.data?.unsent ??
        row.data?.suggestion ??
        '',
      control: 0,
    });
  if (a.verb === 'later')
    return back({
      ...s,
      later: [...new Set([...s.later, row.key])],
      message: 'Saved for later in this demo. Use : Screens to find it.',
    });
  if (a.verb === 'recommended')
    return act(s, { verb: 'pick', option: row.data.digest.recommend });
  const option = row.data?.digest?.options?.find(
    (o) => String(o.key) === String(a.option),
  );
  return push(s, {
    view: 'confirm',
    focus: 'detail',
    pending: { ...a, label: option?.label ?? a.label },
    text: a.text ?? '',
    menuIndex: 0,
  });
}
function confirm(s) {
  if (s.pending.verb === 'executive') {
    const project = s.detail.project;
    return { ...back(s), autonomy: { ...s.autonomy,
      requested: { ...s.autonomy.requested, [project]: true } },
      message: `Demo: executive requested for ${project}. No model ran; recorded decisions are unchanged.` };
  }
  if (s.pending.verb === 'authority-edit' || s.pending.verb === 'pickup') {
    const goal = s.detail;
    const prior = policyFor(s, goal);
    const policy = {
      ...prior, goal: goal.id, project: goal.project,
      revision: `${goal.id}/demo-${(prior?.edits ?? 0) + 1}`, edits: (prior?.edits ?? 0) + 1,
      by: 'operator (demo)', at: '2026-09-19 14:20',
      ...(s.pending.verb === 'authority-edit' ? { scope: s.text } : { pickup: s.pending.pickup }),
    };
    let next = back(s);
    if (next.view === 'authority-edit') next = back(next);
    return { ...next, autonomy: { ...s.autonomy, policies: { ...s.autonomy.policies, [goal.id]: policy } },
      message: 'Demo: authority revision recorded for future picks. Running work is unchanged.' };
  }
  const remove = ['pick', 'drop', 'read', 'send'].includes(s.pending.verb);
  let next = back(s);
  if (next.view === 'reply') next = back(next);
  return {
    ...next,
    dismissed: remove
      ? [...new Set([...s.dismissed, s.detail.key].filter(Boolean))]
      : s.dismissed,
    message: `Demo only: ${s.pending.label}. No command was run.`,
  };
}
export function key(s, input, key = {}, frame = {}) {
  if (key.ctrl || key.meta) return s; // Herdr owns its modifiers and prefix.
  if (['reply', 'search', 'screens', 'authority-edit'].includes(s.view)) {
    if (key.escape) return back(s);
    if (key.tab)
      return { ...s, control: (s.control + (key.shift ? 2 : 1)) % 3 };
    if (key.return) {
      if (s.control === 2) return back(s);
      if (s.view === 'authority-edit')
        return s.text.trim() ? act(s, { verb: 'authority-edit', label: 'Record allowed-work change', text: s.text })
          : { ...s, message: 'Describe the allowed work before recording it.' };
      if (s.view === 'reply')
        return s.text.trim()
          ? act(s, { verb: 'send', label: 'Send reply', text: s.text })
          : { ...s, message: 'Write a reply first.' };
      if (s.view === 'search') return { ...back(s), query: s.text };
      const dest = destinations.filter((d) =>
        d.join(' ').toLowerCase().includes(s.text.toLowerCase()),
      )[s.menuIndex];
      return dest
        ? {
            ...back(s),
            view: dest[0],
            goal: null,
            task: null,
            query: '',
            focus:
              dest[0] === 'lanes'
                ? 'lanes'
                : dest[0] === 'history'
                  ? 'history'
                  : dest[0] === 'decisions' ? 'decisions'
                  : 'open',
            scroll: 0,
          }
        : s;
    }
    if (s.view === 'screens' && (key.upArrow || key.downArrow))
      return {
        ...s,
        menuIndex: Math.max(
          0,
          Math.min(
            destinations.filter((d) =>
              d.join(' ').toLowerCase().includes(s.text.toLowerCase()),
            ).length - 1,
            s.menuIndex + (key.downArrow ? 1 : -1),
          ),
        ),
      };
    if (s.control !== 0) {
      if (input === 'b') return back(s);
      return s;
    }
    const text =
      key.backspace || key.delete
        ? [...s.text].slice(0, -1).join('')
        : s.text + (input ?? '').replace(/[\x00-\x1f\x7f]/g, '');
    return {
      ...s,
      text: text.slice(0, 2000),
      menuIndex: 0,
      drafts:
        s.view === 'reply'
          ? { ...s.drafts, [identity(s.detail)]: text.slice(0, 2000) }
          : s.drafts,
    };
  }
  if (input === 'b' || key.escape || (input === 'q' && s.stack.length))
    return back(s);
  if (input === 'q') return { ...s, quit: true };
  if (input === '?') return push(s, { view: 'help', focus: 'detail' });
  if (input === ':')
    return push(s, {
      view: 'screens',
      focus: 'detail',
      text: '',
      menuIndex: 0,
    });
  if (input === '!')
    return push(s, {
      view: 'inbox',
      focus: 'open',
      goal: null,
      task: null,
      query: '',
    });
  if (input === 'p')
    return push(s, { view: 'scope', focus: 'detail', menuIndex: 0 });
  if (input === 'R')
    return {
      ...s,
      message: 'Fixture data is fixed; no live refresh was made.',
    };
  if (s.view === 'scope') {
    if (key.upArrow || input === 'k')
      return { ...s, menuIndex: Math.max(0, s.menuIndex - 1) };
    if (key.downArrow || input === 'j')
      return { ...s, menuIndex: Math.min(projects.length, s.menuIndex + 1) };
    if (key.return)
      return {
        ...back(s),
        scope: ['all', ...projects.map((p) => p.name)][s.menuIndex],
        goal: null,
        task: null,
        query: '',
        cursor: { ...s.cursor, goals: null, tasks: null },
      };
    return s;
  }
  if (s.view === 'confirm') return key.return ? confirm(s) : s;
  if (s.view === 'actions') {
    const opts = actions(s.detail);
    if (key.downArrow || input === 'j')
      return { ...s, menuIndex: Math.min(opts.length - 1, s.menuIndex + 1) };
    if (key.upArrow || input === 'k')
      return { ...s, menuIndex: Math.max(0, s.menuIndex - 1) };
    if (key.return) return act(back(s), opts[s.menuIndex]);
    const a = opts.find((a) => a.key === input);
    return a ? act(back(s), a) : s;
  }
  if (input === 'e') return s.view === 'decisions' ? s : push(s, { view: 'decisions', focus: 'decisions' });
  if (s.view === 'decisions' && input === 'n') {
    if (s.scope === 'all') return { ...s, message: 'Choose one project with p before requesting an executive.' };
    if (s.autonomy.requested[s.scope]) return { ...s, message: 'Demo: executive already requested for this project; no duplicate request.' };
    return push(s, { view: 'confirm', focus: 'detail',
      detail: { id: 'Executive', project: s.scope },
      pending: { verb: 'executive', label: 'Run executive now' }, text: '' });
  }
  if (s.view === 'authority' && s.focus === 'detail') {
    const policy = policyFor(s, s.detail);
    if (input === 'r') return policy ? push(s, { view: 'authority-edit', text: policy.scope })
      : { ...s, message: 'No authority recorded. Establish the full envelope before enabling pickup.' };
    if (['1', '2'].includes(input)) return policy ? act(s, { verb: 'pickup',
      pickup: input === '1' ? 'allowed' : 'paused', label: input === '1' ? 'Allow pickup inside this envelope' : 'Pause future pickup for this goal' })
      : { ...s, message: 'No authority recorded; a rank is not permission.' };
  }
  if (s.view === 'board' && s.focus === 'goals' && ['[', ']'].includes(input)) {
    const goal = selected(s);
    return goal?.id ? moveGoal(s, goal, input === '[' ? -1 : 1) : s;
  }
  const browsing = browserViews.includes(s.view);
  const areas = browsing
    ? s.view === 'board'
      ? ['goals', 'tasks', 'open', 'sessions']
      : [
          s.view === 'lanes'
            ? 'lanes'
            : s.view === 'history'
              ? 'history'
              : s.view === 'decisions' ? 'decisions'
              : 'open',
          'sessions',
        ]
    : ['detail', 'sessions'];
  if (key.tab || key.leftArrow || key.rightArrow) {
    const delta = key.leftArrow || key.shift ? -1 : 1;
    return {
      ...s,
      focus:
        areas[
          (Math.max(0, areas.indexOf(s.focus)) + delta + areas.length) %
            areas.length
        ],
      query: '',
    };
  }
  if (input === 's') return { ...s, focus: 'sessions', query: '' };
  if (browsing && input === '/')
    return push(s, { view: 'search', focus: 'detail', text: s.query });
  if (browsing && input === 't')
    return {
      ...s,
      stage: ['all', '1', '2', '3', '4', 'keys', 'parked'][
        (['all', '1', '2', '3', '4', 'keys', 'parked'].indexOf(s.stage) + 1) % 7
      ],
      cursor: { ...s.cursor, tasks: null },
      task: null,
    };
  if (browsing && input === '0')
    return {
      ...s,
      goal: null,
      task: null,
      query: '',
      stage: 'all',
      cursor: { ...s.cursor, goals: null, tasks: null },
    };
  if (browsing && input === ' ' && (s.focus === 'goals' || s.focus === 'tasks'))
    return pick(s, s.focus, { id: null });
  const delta = key.pageDown
    ? 8
    : key.pageUp
      ? -8
      : key.downArrow || input === 'j'
        ? 1
        : key.upArrow || input === 'k'
          ? -1
          : 0;
  if (delta || key.home || key.end) {
    if (s.focus !== 'detail')
      return move(s, delta, key.home ? 'home' : key.end ? 'end' : null);
    return {
      ...s,
      scroll: Math.max(
        0,
        Math.min(
          frame.maxScroll ?? 100,
          key.home ? 0 : key.end ? (frame.maxScroll ?? 100) : s.scroll + delta,
        ),
      ),
    };
  }
  if (s.focus === 'sessions' || browsing) {
    if (key.return) return rowDetail(s, selected(s));
    return s;
  }
  if (s.view === 'detail' || s.view === 'peek') {
    if (input === 'u' && s.later.includes(s.detail.key))
      return {
        ...s,
        later: s.later.filter((k) => k !== s.detail.key),
        message: 'Returned to the inbox in this demo.',
      };
    if (input === 'm') return push(s, { view: 'actions', menuIndex: 0 });
    return act(
      s,
      actions(s.detail).find((a) => a.key === (key.return ? 'Enter' : input)),
    );
  }
  return s;
}
export function click(s, target) {
  if (!target) return s;
  if (target.type === 'key') {
    if (s.view === 'authority' && ['r', '1', '2'].includes(target.input))
      return key({ ...s, focus: 'detail' }, target.input);
    if (
      ['reply', 'search', 'screens', 'authority-edit'].includes(s.view) &&
      !target.key?.return
    ) {
      if (['b', 'q'].includes(target.input)) return back(s);
      if (target.input === 'R')
        return {
          ...s,
          message: 'Fixture data is fixed; no live refresh was made.',
        };
      if (target.input === 's') return s;
      if (target.input === '!')
        return push(s, {
          view: 'inbox',
          focus: 'open',
          goal: null,
          task: null,
        });
      if (target.input === ':')
        return push(s, {
          view: 'screens',
          focus: 'detail',
          text: '',
          menuIndex: 0,
        });
      if (target.input === 'p')
        return push(s, { view: 'scope', focus: 'detail', menuIndex: 0 });
      if (target.input === '?')
        return push(s, { view: 'help', focus: 'detail' });
    }
    return key(s, target.input ?? '', target.key ?? {});
  }
  if (
    ['reply', 'search', 'screens', 'authority-edit', 'confirm', 'scope', 'actions'].includes(
      s.view,
    ) &&
    ['row', 'focus'].includes(target.type)
  )
    return s;
  if (target.type === 'focus') return { ...s, focus: target.area, query: '' };
  if (target.type === 'row') {
    const next = pick(s, target.area, target.row);
    return target.open ? rowDetail(next, target.row) : next;
  }
  if (target.type === 'action') return act(s, target.action);
  if (target.type === 'related') return rowDetail(s, target.row);
  if (target.type === 'control') return { ...s, control: target.index };
  if (target.type === 'cancel') return back(s);
  if (target.type === 'submit')
    return key({ ...s, control: 1 }, '', { return: true });
  if (target.type === 'destination') {
    const next = {
      view: target.view,
      focus:
        target.view === 'lanes'
          ? 'lanes'
          : target.view === 'history'
            ? 'history'
            : target.view === 'decisions' ? 'decisions'
            : 'open',
      goal: null,
      task: null,
      query: '',
    };
    next.cursor = { ...s.cursor, goals: null, tasks: null };
    return s.view === 'screens' ? { ...back(s), ...next } : push(s, next);
  }
  if (target.type === 'scope')
    return {
      ...back(s),
      scope: target.scope,
      goal: null,
      task: null,
      query: '',
      cursor: { ...s.cursor, goals: null, tasks: null },
    };
  if (target.type === 'menu')
    return act(back(s), actions(s.detail)[target.index]);
  return s;
}
export function mouse(s, event, frame) {
  if (!event.press || !['left', 'wheelUp', 'wheelDown'].includes(event.button))
    return s;
  const hits = frame.hits
    .filter(
      (h) =>
        event.x >= h.x &&
        event.x < h.x + h.w &&
        event.y >= h.y &&
        event.y < h.y + h.h,
    )
    .sort((a, b) => a.w * a.h - b.w * b.h);
  const target = hits[0]?.target;
  if (event.button === 'left') return click(s, target);
  const area = frame.areas.find(
    (a) =>
      event.x >= a.x &&
      event.x < a.x + a.w &&
      event.y >= a.y &&
      event.y < a.y + a.h,
  )?.name;
  if (
    !area ||
    (area === 'sessions' &&
      ['reply', 'search', 'screens', 'authority-edit', 'confirm', 'scope', 'actions'].includes(
        s.view,
      ))
  )
    return s;
  return key(
    { ...s, focus: area },
    '',
    { [event.button === 'wheelDown' ? 'downArrow' : 'upArrow']: true },
    frame,
  );
}
