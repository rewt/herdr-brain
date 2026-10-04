# box-empty.py: read `herdr pane read --format ansi` on stdin; exit 0 when the Claude Code input box holds no typed text (operator 2026-10-02).
# Typed text renders in the default colour; the prompt glyph and any placeholder suggestion render grey or dim, so those are ignored.
import sys, re
raw = sys.stdin.buffer.read().decode('utf-8', 'replace')
lines = raw.replace('\r', '').split('\n')
plain = [re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', l) for l in lines]
rules = [i for i, l in enumerate(plain) if l.strip().startswith('─' * 4)]
if len(rules) < 2: sys.exit(1)
typed = ''
for l in lines[rules[-2] + 1:rules[-1]]:
    style = set()
    for tok in re.split(r'(\x1b\[[0-9;?]*[A-Za-z])', l):
        m = re.fullmatch(r'\x1b\[([0-9;?]*)m', tok)
        if m:
            p = m.group(1)
            if p in ('', '0'): style = set()
            elif p == '2': style.add('dim')
            elif p == '22': style.discard('dim')
            elif p.startswith('38;2;'):
                rgb = tuple(int(x) for x in p.split(';')[2:5])
                style.discard('grey')
                if max(rgb) - min(rgb) < 16 and 90 <= rgb[0] <= 170: style.add('grey')
            elif p == '39': style.discard('grey')
            continue
        if tok.startswith('\x1b'): continue
        if not style & {'dim', 'grey'}: typed += tok
typed = typed.replace('❯', '').replace(' ', ' ').strip()
sys.exit(0 if typed == '' else 1)
