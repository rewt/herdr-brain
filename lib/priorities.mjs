// Operator outcomes have their own ordering. Legacy item priority numbers
// remain scheduling hints and never change this list.
import { ancestors, itemStatus, isResolved, openRuns } from './state.mjs';
import { UserError } from './store.mjs';

export function validateServes(s, value) {
  if (value != null && !s.priorities.has(value)) throw new UserError(`unknown priority ${value}`);
}

export function itemServes(s, id) {
  for (const item of [s.items.get(id), ...ancestors(s, id)]) {
    if (item && Object.hasOwn(item.meta, 'serves')) return item.meta.serves;
  }
  return null;
}

export function prioritiesJson(s) {
  const work = [...s.items.values()].filter(i => i.kind !== 'goal' && i.role !== 'human' && !isResolved(itemStatus(s, i.id)))
    .map(i => {
      const running = openRuns(s, i.id);
      const serves = running.length ? [...new Set(running.map(r => r.meta.serves ?? null))] : [itemServes(s, i.id)];
      return { id: i.id, title: i.title, status: itemStatus(s, i.id), serves };
    });
  const runs = [...s.runs.values()].map(r => ({ id: r.id, item: r.item, title: s.items.get(r.item)?.title,
    serves: r.meta.serves ?? null, status: r.abandoned ? 'abandoned' : r.report ? r.report.outcome : 'active' }));
  const history = new Map();
  let order = [];
  for (const e of s.priorityChanges) {
    const next = e.type === 'priority.added' ? [...order, e.id] : e.order;
    next.forEach((id, index) => {
      if (order.indexOf(id) !== index) {
        const entries = history.get(id) ?? [];
        entries.push({ rank: index + 1, previous: order.includes(id) ? order.indexOf(id) + 1 : null,
          at: e.at, by: e.by, why: e.why, seq: e.seq });
        history.set(id, entries);
      }
    });
    order = next;
  }
  return {
    revision: s.priorityRevision,
    priorities: s.priorityOrder.map((id, index) => ({ ...s.priorities.get(id), rank: index + 1,
      history: history.get(id) ?? [], work: work.filter(i => i.serves.includes(id)), runs: runs.filter(r => r.serves === id) })),
    unaligned: { work: work.filter(i => i.serves.some(id => !s.priorities.has(id))), runs: runs.filter(r => !s.priorities.has(r.serves)) },
  };
}
