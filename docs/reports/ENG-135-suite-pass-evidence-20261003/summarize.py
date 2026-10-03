"""Rebuild the retained tier totals and file inventory from JSONL/TAP evidence."""
import collections
import gzip
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TIERS = ['fast', 'slot', 'core', 'cycle', 'lanes', 'acceptance', 'release']
BEHAVIORS = json.loads((HERE / 'behaviors.json').read_text())


def read(name):
    file = HERE / name
    if file.exists():
        return file.read_text()
    with gzip.open(str(file) + '.gz', 'rt') as stream:
        return stream.read()


def boundary(row):
    binary = pathlib.Path(row['command']).name
    args = row.get('args', [])
    return {'gitInit': binary == 'git' and 'init' in args,
            'gitWorktree': binary == 'git' and 'worktree' in args and 'add' in args,
            'pty': binary == 'script', 'compiler': binary == 'cc',
            'fakeHerdr': binary in ['herdr', 'fake-herdr', 'fake-herdr.mjs']}


def metrics(label, tier):
    rows = [json.loads(line) for line in read(f'{label}-{tier}.jsonl').splitlines()]
    starts, files = {}, collections.defaultdict(lambda: {'launches': 0, 'wallMs': None, 'exitCodes': []})
    totals = collections.Counter(launches=0)
    commands = collections.Counter()
    for row in rows:
        file = row.get('file')
        if row['kind'] == 'file-start':
            starts[(file, row['pid'])] = row['at']
        if row['kind'] == 'file-end' and (file, row['pid']) in starts:
            duration = row['at'] - starts[(file, row['pid'])]
            old = files[file]['wallMs']
            files[file]['wallMs'] = duration if old is None else min(old, duration)
            files[file]['exitCodes'].append(row.get('code'))
        if row['kind'] == 'spawn':
            totals['launches'] += 1
            files[file]['launches'] += 1
            commands[pathlib.Path(row['command']).name] += 1
            for key, matched in boundary(row).items():
                if matched:
                    totals[key] += 1
                    files[file][key] = files[file].get(key, 0) + 1
    log = read(f'{label}-{tier}.log')
    tap = {name: sum(map(int, re.findall(rf'^# {name} (\d+)$', log, re.M)))
           for name in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}
    # The old shell glob ran these imported support files as empty TAP entries.
    for file in ['test/helpers.mjs', 'test/fixtures/state-v0.mjs', 'console/test/fixtures/board.mjs']:
        match = re.search(r'^# Subtest: ' + re.escape(file) + r'\n.*?duration_ms: ([\d.]+)', log, re.M | re.S)
        if match:
            files[file]['wallMs'] = float(match[1])
    return {'counts': dict(totals), 'commands': dict(commands), 'tap': tap,
            'files': {file if file is not None else '(runner overhead)': value for file, value in files.items()}}


result = {'method': 'Observed Node child-process launch calls; excludes uninstrumented native/shell grandchildren. File seconds are child entry-to-exit, not summed across concurrent files.',
          'before': {}, 'after': {}}
for label in ['before', 'after']:
    timing = json.loads((HERE / f'{label}-tiers.json').read_text())
    for timed in timing['results']:
        tier = timed['tier']
        result[label][tier] = {**timed, **metrics(label, tier)}
    included = [value for tier, value in result[label].items() if tier not in ['fast', 'release']]
    result[label]['promotion'] = {'wallMs': sum(value['wallMs'] for value in included),
        'counts': dict(sum((collections.Counter(value['counts']) for value in included), collections.Counter())),
        'tap': dict(sum((collections.Counter(value['tap']) for value in included), collections.Counter())),
        'code': 0 if all(value['code'] == 0 for value in included) else 1}
(HERE / 'measurements.json').write_text(json.dumps(result, indent=2) + '\n')


def primary(label):
    selected = {}
    for tier in ['slot', 'core', 'cycle', 'lanes', 'acceptance', 'release']:
        for file, value in result[label].get(tier, {}).get('files', {}).items():
            if file != '(runner overhead)':
                selected[file] = (tier, value)
    return selected


before, after = primary('before'), primary('after')
fast = set(result['after']['fast']['files'])
all_files = sorted(set(BEHAVIORS) | set(before) | set(after))
notes = [
    '# Per-file coverage and measured cost', '',
    'Seconds are each test child’s entry-to-exit wall time and overlap across concurrent files. Launches include attributed descendant Node calls; each real Git operation remains real. Git columns count observed `init` / `worktree add` boundaries, PTY counts native `script` calls, and H counts fake Herdr CLI calls. Live Herdr/model calls are zero. Compiler totals are available in `measurements.json`.', '',
    'Fast files are a subset of promotion; their primary promotion measurement appears here. The native slot file also has a Node test parent, so its shorter child interval is used. A dash means no comparable file execution; the new release files split older cases, whose old cost remains attributed to their old file. The optional MCP file is reached conditionally through its wrapper and is not counted twice. All acceptance files retain their source unchanged.', '',
    '| File | Tier | Protected behavior | Before s / launches | After s / launches | Git init/worktree before → after | PTY before → after | H before → after |',
    '| --- | --- | --- | ---: | ---: | --- | --- | --- |'
]


def cost(value):
    if not value:
        return '—'
    data = value[1]
    return f"{data['wallMs']/1000:.3f} / {data['launches']}" if data['wallMs'] is not None else f"— / {data['launches']}"


def count(value, key):
    return str(value[1].get(key, 0)) if value else '—'


for file in all_files:
    assert file in BEHAVIORS, f'Name the protected behavior: {file}'
    b, a = before.get(file), after.get(file)
    if file == 'mcp/test/server.test.mjs' and not a:
        tier = 'conditional core via test/mcp'
    elif file.startswith('kit/'):
        tier = 'frozen external-project inventory'
    elif a:
        tier = a[0] + (' + fast' if file in fast else '')
    elif file in ['test/helpers.mjs', 'test/fixtures/state-v0.mjs', 'console/test/fixtures/board.mjs']:
        tier = 'imported support; empty entry removed'
    else:
        tier = 'unmeasured'
    git = f"{count(b, 'gitInit')}/{count(b, 'gitWorktree')} → {count(a, 'gitInit')}/{count(a, 'gitWorktree')}"
    behavior = BEHAVIORS[file].replace('|', '\\|')
    notes.append(f"| `{file}` | {tier} | {behavior} | {cost(b)} | {cost(a)} | {git} | {count(b, 'pty')} → {count(a, 'pty')} | {count(b, 'fakeHerdr')} → {count(a, 'fakeHerdr')} |")
notes += ['', 'Runner/transport overhead (unattributed child launches) is retained per tier in `measurements.json`; file columns therefore need not add to the tier totals. Zero Git-init calls after fixture reuse do not mean zero real repositories: copied complete `.git` trees remain independent and every subsequent Git operation/worktree still crosses the native boundary.', '']
(HERE / 'inventory.md').write_text('\n'.join(notes))
print(json.dumps({label: {tier: {key: value[key] for key in ['wallMs', 'counts', 'tap', 'code']} for tier, value in rows.items()} for label, rows in result.items() if label in ['before', 'after']}, indent=2))
