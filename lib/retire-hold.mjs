// Callers supply the checkout resolved by canonical Git common-directory identity.
// Existence alone is the brake; never follow the entry or inspect its contents.
import fs from 'node:fs';
import path from 'node:path';

export const RETIREMENT_HOLD_PATH = '.lane/supervisor/HOLD-WORKER-TAB-CLOSE';
export const RETIREMENT_HOLD_REASON = `retirement held: ${RETIREMENT_HOLD_PATH}`;

export function retirementHold(canonical) {
  try { fs.lstatSync(path.join(canonical, RETIREMENT_HOLD_PATH)); }
  catch (error) { if (error.code === 'ENOENT') return null; }
  return RETIREMENT_HOLD_REASON;
}
