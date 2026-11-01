import { createHash } from 'node:crypto';

// Part 1's immutable report format. Shared by intake and the read-only inventory.
export function batchedMinorSection(body) {
  const rows = [], malformed = [];
  let section = false, sections = 0, fence, fenceLine;
  for (const [index, line] of String(body).split('\n').entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) { if (!fence) { fence = marker[1]; fenceLine = index + 1; } else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    if (/^\s+(`{3,}|~{3,})/.test(line)) {
      malformed.push({ body_line: index + 1, text: line, reason: 'Fence indented beyond three spaces' });
      continue;
    }
    if (/^\s*#{1,6}\s+batched\s+minors\s*#*\s*$/i.test(line) && line !== '## Batched Minors') {
      malformed.push({ body_line: index + 1, text: line, reason: 'Expected exact ## Batched Minors heading' });
      section = true;
      sections++;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      section = line.trim() === '## Batched Minors';
      if (section) sections++;
      continue;
    }
    if (!section || !line.trim()) continue;
    const row = /^- `?([^\s`]+:\d+(?::\d+)?(?:-\d+)?)`? - (\S.*)$/.exec(line);
    if (row) rows.push({ location: row[1], text: row[2], body_line: index + 1 });
    else malformed.push({ body_line: index + 1, text: line });
  }
  if (fence) malformed.push({ body_line: fenceLine, text: fence, reason: 'Unclosed fence' });
  return { rows, malformed, sections };
}

export const batchedMinorKey = (review, run, sha256, row) => `batched-minor/v1:${createHash('sha256')
  .update(JSON.stringify([review, run, sha256, row.body_line, row.location, row.text])).digest('hex')}`;
