// Runtime planner codec: shared by installed promotion and source-only planners.
// Lossless wire representation: share path strings, witness prefixes and rows.
// The in-process planner/adapter API continues to expose full consumer objects.
const ENCODING = 'indexed-witnesses/v2';
export function compactPlanDetails(plan) {
  if (!Array.isArray(plan.graph?.consumers)) return plan;
  const paths = [], pathIds = new Map(), via = [], viaIds = new Map(), reasons = [], reasonIds = new Map();
  const intern = (value, values, ids) => {
    if (!ids.has(value)) { ids.set(value, values.length); values.push(value); }
    return ids.get(value);
  };
  const pathId = value => intern(value, paths, pathIds);
  const rows = plan.graph.consumers.map(row => {
    let parent = -1;
    for (const file of row.via) {
      const id = pathId(file), key = `${parent}:${id}`;
      if (!viaIds.has(key)) { viaIds.set(key, via.length); via.push([parent, id]); }
      parent = viaIds.get(key);
    }
    if (row.via[0] !== row.input || row.via.at(-1) !== row.file) throw Error('invalid consumer witness endpoints');
    return [parent, intern(row.reason, reasons, reasonIds)];
  });
  const rowIds = new Map(plan.graph.consumers.map((row, index) => [JSON.stringify(row), index]));
  const compactRows = entries => entries?.map(row => row.consumers ? { ...row,
    consumers: row.consumers.map(consumer => {
      const index = rowIds.get(JSON.stringify(consumer));
      if (index === undefined) throw Error('consumer missing from plan graph');
      return index;
    }) } : row);
  return { ...plan,
    ...(plan.selected ? { selected: compactRows(plan.selected) } : {}),
    ...(plan.deferred ? { deferred: compactRows(plan.deferred) } : {}),
    graph: { ...plan.graph, consumers: rows, details: { encoding: ENCODING, paths, via, reasons } } };
}

export function expandPlanDetails(plan) {
  if (!plan?.graph?.details) return plan; // Existing third-party planners stay valid.
  const { encoding, paths, via, reasons } = plan.graph.details;
  const fail = () => { throw Error('invalid indexed planner details'); };
  const legacy = encoding === 'indexed-witnesses/v1';
  if ((!legacy && encoding !== ENCODING) || ![paths, via, reasons, plan.graph.consumers].every(Array.isArray) ||
      [...paths, ...reasons].some(value => typeof value !== 'string')) fail();
  const at = (values, index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) fail();
    return values[index];
  };
  const witnesses = [];
  for (const node of via) {
    if (!Array.isArray(node) || node.length !== 2) fail();
    // Parents must precede children, so malformed input cannot create cycles.
    witnesses.push([...(node[0] === -1 ? [] : at(witnesses, node[0])), at(paths, node[1])]);
  }
  const consumers = plan.graph.consumers.map(row => {
    if (!Array.isArray(row) || row.length !== (legacy ? 4 : 2)) fail();
    const witness = at(witnesses, row[legacy ? 2 : 0]);
    return { input: legacy ? at(paths, row[0]) : witness[0], file: legacy ? at(paths, row[1]) : witness.at(-1),
      via: witness, reason: at(reasons, row[legacy ? 3 : 1]) };
  });
  const expandRows = rows => {
    if (!Array.isArray(rows)) fail();
    return rows.map(row => {
      if (!row || typeof row !== 'object') fail();
      if (row.consumers === undefined) return row;
      if (!Array.isArray(row.consumers)) fail();
      return { ...row, consumers: row.consumers.map(index => at(consumers, index)) };
    });
  };
  const { details, ...graph } = plan.graph;
  return { ...plan, graph: { ...graph, consumers },
    ...(plan.selected !== undefined ? { selected: expandRows(plan.selected) } : {}),
    ...(plan.deferred !== undefined ? { deferred: expandRows(plan.deferred) } : {}) };
}
