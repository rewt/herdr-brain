import { DEFAULTS, FIELDS, parseOverride } from '../../housekeeping/config.mjs';
export { DEFAULTS, FIELDS };

export function housekeepingReview(edit) {
  const patch = {}, unset = [];
  FIELDS.forEach((key, i) => {
    const text = edit.values[i].trim();
    if (!text) { if (Object.hasOwn(edit.original, key)) unset.push(key); }
    else {
      const value = parseOverride(key, text);
      if (edit.original[key] !== value) patch[key] = value;
    }
  });
  const after = { ...DEFAULTS, ...edit.original, ...patch };
  for (const key of unset) after[key] = DEFAULTS[key];
  return { patch, unset, after, writes: Boolean(Object.keys(patch).length || unset.length) };
}
