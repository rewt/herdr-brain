// Bounded pointers into this record, never another memory store or filesystem read.
import { ancestors, children, compareIds } from './state.mjs';
import { itemContextText, lessonsJson, mentionsSelector } from './lessons.mjs';

export function briefContext(s, itemId, extraText = '') {
  const item = s.items.get(itemId), chain = ancestors(s, itemId);
  const text = `${itemContextText(item)}\n${extraText}`;
  // Paths must be literal project-relative tokens; no URL/absolute-path inference.
  const paths = [...new Set([...text.matchAll(/(?<![\w./:-])(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+)/g)]
    .map(match => match[1].replace(/\.$/, '')).filter(p => !p.split('/').includes('..')))];
  const modules = [...new Set(lessonsJson(s).flatMap(l => l.modules))]
    .filter(module => mentionsSelector(text, module));
  const own = new Set([itemId, ...chain.map(i => i.id)]), candidates = new Map(), missing = new Set();
  const add = (target, reason, rank) => {
    if (target && !own.has(target.id) && !candidates.has(target.id)) candidates.set(target.id, { item: target, reason, rank });
  };
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_-])([A-Z][A-Z0-9]*-[1-9]\d*)(?![\p{L}\p{N}_-])/gu)) {
    const id = match[1];
    if (!s.items.has(id) && !s.runs.has(id) && !s.lessons.has(id)) missing.add(id);
    add(s.items.get(id) ?? s.items.get(s.runs.get(id)?.item), `explicit ${id}`, 0);
  }
  for (const sibling of item.parent ? children(s, item.parent) : []) {
    const siblingText = itemContextText(sibling);
    const selector = paths.find(p => mentionsSelector(siblingText, p, true))
      ?? modules.find(m => mentionsSelector(siblingText, m));
    if (selector) add(sibling, `shared selector ${selector}`, 1);
  }
  const all = [...candidates.values()].sort((a, b) => a.rank - b.rank || compareIds(a.item.id, b.item.id));
  return { chain, paths, modules, related: all.slice(0, 4), omitted: all.length - Math.min(4, all.length), missing: [...missing] };
}

// Keep source identity and authorship; excerpts cannot resolve supersession or
// grant authority. A newer report may still contain challenges, never inferred mistakes.
export function contextDecision(s, item) {
  const note = item.notes.filter(n => n.decision).at(-1);
  const reportDecisions = report => report?.extra?.decisions ?? report?.decisions ?? [];
  const run = item.runs.map(id => s.runs.get(id)).filter(r => reportDecisions(r?.report).length).at(-1);
  if (note && (!run || note.seq > run.report.seq)) return { text: note.text, source: item.id, seq: note.seq, by: note.by };
  if (run) return { text: reportDecisions(run.report).map(d => typeof d === 'string' ? d : d.text).join('; '), source: run.id, seq: run.report.seq, by: run.report.by ?? 'not retained in report fold; inspect source event' };
  return null;
}
