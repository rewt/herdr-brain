// Role identity comes from this table; generated ID prefixes may also have a fallback.
export const ROLE_PREFIX = {
  engineer: 'ENG', engineering: 'ENG', architect: 'ARCH', architecture: 'ARCH',
  researcher: 'RES', research: 'RES', reviewer: 'REV', review: 'REV',
  planner: 'PLAN', triage: 'TRI', human: 'HUM', writer: 'DOC', designer: 'DES',
};

export const roleIs = (item, prefix) => ROLE_PREFIX[String(item?.role ?? '').toLowerCase()] === prefix;
