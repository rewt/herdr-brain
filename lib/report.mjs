// Reports: a markdown file whose front matter carries a small envelope, followed by
// free-form details. Parsing is deliberately lenient; only what the ledger needs
// (outcome, summary, well-formed proposals) is required.

import { CATEGORY_CHECKLIST } from './discernment.mjs';
export const OUTCOMES = ['done', 'blocked', 'needs_human', 'failed'];

const SUMMARY_PLACEHOLDER = '(what you did and where things stand, in a few sentences)';

export function reportTemplate(runId, { includeWorkflow = true } = {}) {
  return `---
run: ${runId}
outcome:            # done | blocked | needs_human | failed
summary: |
  ${SUMMARY_PLACEHOLDER}
headline:           # one plain sentence for the operator, e.g. "The storage tool review needs work"
blockers: []        # if blocked or needs_human: what exactly is in the way
proposals: []       # follow-on notes awaiting separate selection (formal findings stay linked), e.g.
${includeWorkflow ? `# Under the current land-first waiver, self-land OWN finished source before checks/review.
# Hand immutable landed source/evidence to ONE async record-queue review: cap1, zero reviewer suites.
# Keep findings linked to corrections/follow-ups; do not hold finished source or its parent.
# Fix Majors and check their corrections before final release; preserve the original verdict.
` : ''}\
#  - role: architect
#    title: Decide the storage backend
#    why: what this unblocks or why it matters
learnings: []       # facts a future session should not have to rediscover
artifacts: []       # commits, branches, files, commands that show the work
decisions: []       # each: text, category, why; record the action and rationale
questions: []       # each: question, category, recommend, why; id from ask --wait if unsure
challenges: []      # discrepancies or assumptions that change the outcome, with evidence
# ${CATEGORY_CHECKLIST.replaceAll('\n', '\n# ')}
---

(free-form details: evidence, dead ends, anything worth keeping)
`;
}

export function readReport(text) {
  const split = splitReport(text);
  if (split.error) return { errors: [split.error], warnings: [] };
  let data;
  try {
    data = split.front.trim().startsWith('{') ? JSON.parse(split.front) : parseYamlSubset(split.front);
  } catch (err) {
    const where = err.line ? `line ${err.line + split.offset}: ` : '';
    return { errors: [`could not read the front matter: ${where}${err.message}`], warnings: [] };
  }
  const { report, errors, warnings } = normalizeReport(data);
  return { report, body: split.body, errors, warnings };
}

export function splitReport(text) {
  let t = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fenced = /^\s*```[\w-]*\n([\s\S]*)\n```\s*$/.exec(t);
  if (fenced) t = fenced[1];
  const lines = t.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (lines[start]?.trim() !== '---') {
    return { error: 'a report must start with a front matter block between "---" lines' };
  }
  let end = start + 1;
  while (end < lines.length && !['---', '...'].includes(lines[end].trim())) end++;
  if (end >= lines.length) return { error: 'the front matter block is not closed with a "---" line' };
  return {
    front: lines.slice(start + 1, end).join('\n'),
    offset: start + 1,
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

export function normalizeReport(data) {
  const errors = [];
  const warnings = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: ['the front matter must be a set of "key: value" fields'], warnings };
  }
  const rest = { ...data };
  const take = (key) => {
    const value = rest[key];
    delete rest[key];
    return value;
  };
  const report = {};

  const run = take('run');
  if (run != null && String(run).trim()) report.run = String(run).trim();

  const outcome = take('outcome');
  if (outcome == null || String(outcome).trim() === '') {
    errors.push(`outcome is required (${OUTCOMES.join(' | ')})`);
  } else {
    report.outcome = String(outcome).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!OUTCOMES.includes(report.outcome)) {
      errors.push(`outcome "${outcome}" must be one of ${OUTCOMES.join(' | ')}`);
    }
  }

  const summary = take('summary');
  if (summary == null || String(summary).trim() === '') {
    errors.push('summary is required');
  } else {
    report.summary = String(summary).trim();
    if (report.summary === SUMMARY_PLACEHOLDER) warnings.push('summary still contains the template placeholder');
  }

  const headline = take('headline');
  if (headline == null || String(headline).trim() === '') {
    warnings.push('headline is missing: add one plain sentence for the operator');
  } else {
    report.headline = String(headline).replace(/\s+/g, ' ').trim();
  }

  report.blockers = texts(take('blockers'));
  report.proposals = [];
  asList(take('proposals')).forEach((entry, index) => {
    const proposal = normalizeProposal(entry, index, errors, warnings);
    if (proposal) report.proposals.push(proposal);
  });
  report.learnings = texts(take('learnings'));
  report.artifacts = texts(take('artifacts'));

  const usage = take('usage');
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) report.usage = usage;
  else if (usage != null) warnings.push('usage should be a set of "key: value" fields; ignored');

  if (Object.keys(rest).length) report.extra = rest;

  if (report.outcome === 'blocked' && !report.blockers.length && !report.proposals.length) {
    warnings.push('outcome is blocked but there are no blockers or proposals; say what would unblock this');
  }
  if (report.outcome === 'needs_human' && !report.blockers.length) {
    warnings.push('outcome is needs_human; add a blocker saying what you need from a human');
  }
  return { report, errors, warnings };
}

const PROPOSAL_KEYS = new Set(['title', 'name', 'role', 'capability', 'why', 'reason', 'rationale', 'accept', 'acceptance', 'blocking']);

function normalizeProposal(entry, index, errors, warnings) {
  let p = entry;
  if (typeof p === 'string') p = { title: p };
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push(`proposals[${index}] must have at least a title`);
    return null;
  }
  const keys = Object.keys(p);
  // "- architect: Decide the storage backend" reads naturally; accept it.
  if (keys.length === 1 && !PROPOSAL_KEYS.has(keys[0]) && typeof p[keys[0]] === 'string') {
    p = { role: keys[0], title: p[keys[0]] };
  }
  const title = p.title ?? p.name;
  if (title == null || isPlaceholder(String(title))) {
    errors.push(`proposals[${index}] needs a title`);
    return null;
  }
  const out = { title: String(title).trim() };
  if (p.role != null && String(p.role).trim()) out.role = String(p.role).trim().toLowerCase();
  else warnings.push(`proposal "${out.title}" has no role`);
  if (p.capability != null) out.capability = String(p.capability).trim();
  const why = p.why ?? p.reason ?? p.rationale;
  if (why != null) out.why = String(why).trim();
  const accept = texts(p.accept ?? p.acceptance);
  if (accept.length) out.accept = accept;
  if (p.blocking != null) out.blocking = p.blocking === true || String(p.blocking).toLowerCase() === 'true';
  const extra = Object.fromEntries(Object.entries(p).filter(([k]) => !PROPOSAL_KEYS.has(k)));
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isPlaceholder(text) {
  return ['', '...', '…', '-'].includes(text.trim());
}

function texts(value) {
  return asList(value).map(toText).filter((t) => !isPlaceholder(t));
}

function toText(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value).trim();
  if (Array.isArray(value)) return value.map(toText).join('; ');
  for (const key of ['text', 'question', 'description', 'summary']) {
    if (typeof value[key] === 'string') return value[key].trim();
  }
  // "- Storage: Redis is unavailable in CI" parses as a one-key mapping; keep it as text.
  return Object.entries(value).map(([k, v]) => `${k}: ${toText(v)}`).join('; ');
}

// A YAML subset sufficient for report envelopes: mappings, lists, lists of
// mappings, block scalars (| and >), quoted and flow scalars, full-line and
// " # " trailing comments. Anything else is reported with a line number.
export function parseYamlSubset(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((raw, index) => {
    const trimmed = raw.trim();
    return {
      n: index + 1,
      raw,
      indent: raw.length - raw.trimStart().length,
      text: trimmed,
      blank: trimmed === '' || trimmed.startsWith('#'),
    };
  });
  for (const line of lines) {
    if (!line.blank && /^\s*\t/.test(line.raw)) throw yamlError(line, 'use spaces, not tabs, for indentation');
  }
  const first = nextContent(lines, 0);
  if (first === -1) return {};
  const [value, end] = parseNode(lines, first, lines[first].indent);
  const leftover = nextContent(lines, end);
  if (leftover !== -1) throw yamlError(lines[leftover], 'unexpected content');
  return value;
}

const KEY_RE = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/;

function yamlError(line, message) {
  const err = new Error(message);
  err.line = line.n;
  return err;
}

function nextContent(lines, i) {
  while (i < lines.length && lines[i].blank) i++;
  return i < lines.length ? i : -1;
}

function isListItem(line) {
  return line.text === '-' || line.text.startsWith('- ');
}

function parseNode(lines, i, indent) {
  return isListItem(lines[i]) ? parseList(lines, i, indent) : parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const obj = {};
  for (;;) {
    i = nextContent(lines, i);
    if (i === -1) return [obj, lines.length];
    const line = lines[i];
    if (line.indent < indent) return [obj, i];
    if (line.indent > indent) throw yamlError(line, 'unexpected indentation');
    const match = KEY_RE.exec(line.text);
    if (!match) throw yamlError(line, 'expected "key: value"');
    const key = match[1];
    const rest = stripComment(match[2] ?? '');
    let value;
    i++;
    if (/^[|>][-+]?$/.test(rest)) {
      [value, i] = parseBlockScalar(lines, i, indent, rest);
    } else if (rest === '') {
      const j = nextContent(lines, i);
      if (j !== -1 && (lines[j].indent > indent || (lines[j].indent === indent && isListItem(lines[j])))) {
        [value, i] = parseNode(lines, j, lines[j].indent);
      } else {
        value = null;
      }
    } else {
      value = parseScalar(rest, line);
    }
    if (Object.hasOwn(obj, key)) throw yamlError(line, `duplicate key "${key}"`);
    obj[key] = value;
  }
}

function parseList(lines, i, indent) {
  const arr = [];
  for (;;) {
    i = nextContent(lines, i);
    if (i === -1) return [arr, lines.length];
    const line = lines[i];
    if (line.indent < indent || (line.indent === indent && !isListItem(line))) return [arr, i];
    if (line.indent > indent) throw yamlError(line, 'unexpected indentation');
    const rest = line.text === '-' ? '' : line.text.slice(1).trimStart();
    if (rest === '' || stripComment(rest) === '') {
      const j = nextContent(lines, i + 1);
      if (j !== -1 && lines[j].indent > indent) {
        let value;
        [value, i] = parseNode(lines, j, lines[j].indent);
        arr.push(value);
      } else {
        arr.push(null);
        i++;
      }
    } else if (KEY_RE.test(rest)) {
      // "- key: value" starts a mapping whose keys align with "key".
      const contentIndent = line.indent + (line.text.length - rest.length);
      lines[i] = { ...line, indent: contentIndent, text: rest };
      let value;
      [value, i] = parseMap(lines, i, contentIndent);
      arr.push(value);
    } else {
      arr.push(parseScalar(stripComment(rest), line));
      i++;
    }
  }
}

function parseBlockScalar(lines, i, parentIndent, indicator) {
  const collected = [];
  let blockIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.raw.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    if (line.indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = line.indent;
    if (line.indent < blockIndent) throw yamlError(line, 'block text is indented less than its first line');
    collected.push(line.raw.slice(blockIndent).trimEnd());
    i++;
  }
  while (collected.length && collected.at(-1) === '') collected.pop();
  if (indicator.startsWith('>')) {
    const paragraphs = [];
    let current = [];
    for (const text of collected) {
      if (text === '') {
        paragraphs.push(current.join(' '));
        current = [];
      } else {
        current.push(text);
      }
    }
    paragraphs.push(current.join(' '));
    return [paragraphs.join('\n'), i];
  }
  return [collected.join('\n'), i];
}

function stripComment(text) {
  const t = text.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const quote = t[0];
    for (let k = 1; k < t.length; k++) {
      if (quote === '"' && t[k] === '\\') {
        k++;
        continue;
      }
      if (t[k] === quote) {
        if (quote === "'" && t[k + 1] === "'") {
          k++;
          continue;
        }
        return t.slice(0, k + 1);
      }
    }
    return t;
  }
  if (t.startsWith('# ') || t === '#') return '';
  // Only " # " starts a comment, so "#42" in a title survives.
  return t.replace(/\s+#\s.*$/, '').trim();
}

function parseScalar(text, line) {
  const s = text.trim();
  if (s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw yamlError(line, 'invalid double-quoted text');
    }
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) throw yamlError(line, 'unterminated single-quoted text');
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitFlow(inner).map((part) => parseScalar(part, line)) : [];
  }
  if (s === '{}') return {};
  return s;
}

function splitFlow(text) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
