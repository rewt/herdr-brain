#!/usr/bin/env python3
# usage: extract-brief.py SETTLE_REPORT ITEM BRIEF_OUT REPORT_OUT [LANE] [EXTRA_MD_FILE]
# Pulls the first fenced block after the first '## Draft' heading of a settle report, replaces ITEM-NEW with ITEM,
# and appends a REQUIRED OUTPUT section naming REPORT_OUT (and an optional supervisor-additions file).
import re, sys
rep, item, out, report = sys.argv[1:5]
lane = sys.argv[5] if len(sys.argv) > 5 else ''
extra = open(sys.argv[6]).read() if len(sys.argv) > 6 else ''
s = open(rep).read()
i = s.index('## Draft')
m = re.search(r'(```|~~~)(?:markdown|md)?\n(.*?)\n\1', s[i:], re.S)
b = m.group(2).replace('ITEM-NEW', item)
if extra: b += '\n\n## Supervisor additions\n\n' + extra.strip()
ev = report[:-3] + '-evidence/' if report.endswith('.md') else report + '-evidence/'
b += (f"\n\n## Report: REQUIRED OUTPUT\n\n`{report}` with front matter `run: R-RUN`; evidence in `{ev}` with SHA256SUMS. "
      "No herdr, no tasks.md, no openspec/." + (f" Commit on `lane/{lane}`; no push." if lane else "") +
      " Run org check until it passes, then stop.\n")
open(out, 'w').write(b)
print(f"brief {out} ({len(b)} chars)")
