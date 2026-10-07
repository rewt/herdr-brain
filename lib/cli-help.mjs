// Shared, side-effect-free help rendering for dependency-free module CLIs.
import path from 'node:path';
import { parseArgs as nodeParseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export function parseArgs({ usage, ...config } = {}) {
  const options = { ...config.options, help: { type: 'boolean', short: 'h' } };
  const parsed = nodeParseArgs({ ...config, options });
  if (parsed.values.help) {
    const program = path.relative(process.cwd(), process.argv[1]) || path.basename(process.argv[1]);
    console.log(usage ?? `Usage: node ${program}${config.allowPositionals ? ' [COMMAND|ARGUMENT ...]' : ''} [OPTIONS]`);
    console.log('\nOptions:');
    for (const [name, option] of Object.entries(options)) {
      console.log(`  ${option.short ? `-${option.short}, ` : ''}--${name}${option.type === 'string' ? ' VALUE' : ''}${option.multiple ? ' (repeatable)' : ''}${option.default !== undefined ? ` (default: ${option.default})` : ''}`);
    }
    process.exit(0);
  }
  return parsed;
}

// Positional/internal transports must only intercept their own bare help request.
export function cliHelp(url, usage) {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url) &&
      process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log(usage);
    process.exit(0);
  }
}
