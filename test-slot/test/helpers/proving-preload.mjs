// Native lifecycle fixtures that call private slot adapters can still declare
// their exact proving command through the public CLI resource argument. This
// preload is fixture-only and leaves every other executable untouched.
import { fileURLToPath } from 'node:url';
import { provingRun } from './proving.mjs';
if (process.argv[1] === fileURLToPath(new URL('../../test-slot.mjs', import.meta.url)))
  process.argv = provingRun(process.argv);
