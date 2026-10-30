import { parseArgs } from 'node:util';
import { findOrgDir, loadRecordReader } from './store.mjs';
import { obligationInventory } from './obligations.mjs';

export function obligationsCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean' }, project: { type: 'string' },
  } });
  if (positionals.length) throw Error('use record obligations [--json] [--project COMMON_DIR]');
  const reader = loadRecordReader(findOrgDir());
  try {
    const inventory = obligationInventory(reader.state, { position: reader.position, project: values.project });
    reader.verify();
    if (values.json) process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
    else {
      for (const [kind, count] of Object.entries(inventory.counts)) process.stdout.write(
        `${kind}: ${count.pending} pending (${count.supported} supported, ${count.unsupported} unsupported); oldest_ms=${count.oldest_ms ?? 'Unknown'}\n`);
      process.stdout.write(inventory.limits + '\n');
    }
    return 0;
  } finally { reader.close(); }
}
