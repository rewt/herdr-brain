// Closed source profile, never a JavaScript evaluator. Every token must belong
// to a recognized production; unsupported syntax/values always retain unknown.
import path from 'node:path';

const script = /\.(?:mjs|cjs|js|sh|json|ya?ml)$/;
const launchers = new Set(['fork', 'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']);
const reserved = new Set(('await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield process URL undefined').split(' '));
const v = token => token?.value;
const unsupported = detail => { throw Error(`outside closed source profile: ${detail}`); };

// There are no speculative lexer branches. In particular, code slashes (both
// regex and division), interpolated templates and escaped identifiers are not
// in this profile. A failed scan retains both its error and all preceding tokens.
function lex(source) {
  const tokens = []; let i = 0;
  // Keep the refusal while still inventorying known imports before/around
  // harmless display text. Never discard this error in favor of a parse result.
  const sourceError = /[^\x09\x0a\x0d\x20-\x7e]/.test(source) ? Error('outside closed source profile: non-ASCII/control source') : undefined;
  const add = (value, type) => {
    if (tokens.length >= 100000) unsupported('token limit');
    tokens.push({ value, type });
  };
  const lineEnd = () => {
    const offset = source.slice(i).search(/[\r\n\u2028\u2029]/);
    i = offset < 0 ? source.length : i + offset;
  };
  const quoted = quote => {
    let text = ''; i++;
    while (i < source.length) {
      let c = source[i++];
      if (c === quote) return text;
      if (quote === '`' && c === '$' && source[i] === '{') unsupported('interpolated template');
      if (c !== '\\') { if (/[\r\n]/.test(c)) unsupported('multiline string'); text += c; continue; }
      c = source[i++];
      if (c === '\n') continue;
      if (c === '\r') { if (source[i] === '\n') i++; continue; }
      if (c === 'x' || c === 'u') {
        const length = c === 'x' ? 2 : 4;
        if (source[i] === '{' && c === 'u') {
          const end = source.indexOf('}', i + 1), digits = source.slice(i + 1, end);
          if (end < 0 || !/^[a-f\d]{1,6}$/i.test(digits)) unsupported('string escape');
          text += String.fromCodePoint(parseInt(digits, 16)); i = end + 1;
        } else {
          const digits = source.slice(i, i + length);
          if (!new RegExp(`^[a-f\\d]{${length}}$`, 'i').test(digits)) unsupported('string escape');
          text += String.fromCharCode(parseInt(digits, 16)); i += length;
        }
      } else if (c === '0' && !/[0-9]/.test(source[i] ?? '')) text += '\0';
      else if (/[0-9]/.test(c) || c === undefined) unsupported('string escape');
      else text += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[c] ?? c;
    }
    unsupported('unterminated string');
  };
  try {
    while (i < source.length) {
      const c = source[i];
      if (/\s/.test(c)) { i++; continue; }
      if (i === 0 && source.startsWith('#!')) { lineEnd(); continue; }
      if (source.startsWith('//', i)) { lineEnd(); continue; }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2); if (end < 0) unsupported('unterminated comment'); i = end + 2; continue;
      }
      if (['"', "'", '`'].includes(c)) { add(quoted(c), 'string'); continue; }
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
      if (word) { add(word[0], 'identifier'); i += word[0].length; continue; }
      const number = /^(?:0|[1-9]\d*)(?:\.\d+)?/.exec(source.slice(i));
      if (number) { add(number[0], 'number'); i += number[0].length; continue; }
      // Punctuation can be inventoried without accepting its grammar. For
      // example, arrow/function bodies still expose literal file references,
      // while the parser below refuses the unsupported function production.
      if ('{}[](),;:=.*-+?!~<>&|^%'.includes(c)) { add(c, 'punctuation'); i++; continue; }
      unsupported(c === '/' ? 'regex/division syntax' : 'lexical token');
    }
    return { tokens, error: sourceError };
  } catch (error) { return { tokens, error }; }
}

function repositoryPath(file, spec, files, root) {
  if (/[\\%?#\x00-\x20\x7f]/.test(spec)) unsupported('path outside literal filesystem profile');
  let target;
  if (path.posix.isAbsolute(spec)) {
    if (!root || !spec.startsWith(path.posix.normalize(root) + '/')) unsupported('absolute target outside source tree');
    target = path.posix.relative(root, spec);
  } else target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  if (!target || target.startsWith('../') || path.posix.isAbsolute(target) || target.includes('\\') || !files.has(target)) unsupported(`missing or external repository target: ${spec}`);
  return target;
}
function literalEdges(file, strings, files, root) {
  const edges = new Set(); let basenames;
  for (const text of strings) if (script.test(text)) {
    // Data strings only add conservative references. Every actual module or
    // launcher production independently requires repositoryPath to succeed;
    // an unresolved execution target is never discarded as a data hint.
    const candidates = [text, path.posix.normalize(path.posix.join(path.posix.dirname(file), text))];
    if (root && path.posix.isAbsolute(text)) candidates.push(path.posix.relative(root, text));
    for (const candidate of candidates) if (files.has(candidate)) edges.add(candidate);
    if (!text.includes('/')) {
      if (!basenames) {
        basenames = new Map();
        for (const candidate of files.keys()) {
          const name = path.posix.basename(candidate);
          if (!basenames.has(name)) basenames.set(name, []);
          basenames.get(name).push(candidate);
        }
      }
      for (const candidate of basenames.get(text) ?? []) edges.add(candidate);
    }
  }
  return edges;
}

export function sourceReach(file, source, files, { root } = {}) {
  const scanned = lex(source), ts = scanned.tokens;
  const dependencies = literalEdges(file, ts.filter(t => t.type === 'string').map(v), files, root), unknown = [];
  const fail = error => unknown.push({ file, reason: error.message });
  if (scanned.error) fail(scanned.error);
  const bindings = new Map(); let at = 0, depth = 0;
  const syntax = token => ['identifier', 'punctuation'].includes(token?.type) ? v(token) : undefined;
  const peek = () => syntax(ts[at]);
  const take = expected => {
    const token = ts[at++]; if (!token || (expected !== undefined && syntax(token) !== expected)) unsupported(`expected ${expected ?? 'token'}`);
    return token;
  };
  const name = () => {
    const token = take(); if (token.type !== 'identifier' || reserved.has(v(token))) unsupported('binding name'); return v(token);
  };
  const bind = (id, value) => { if (bindings.has(id)) unsupported('duplicate/shadowed binding'); bindings.set(id, value); };
  const moduleTarget = spec => {
    if (typeof spec !== 'string' || !spec.startsWith('.')) unsupported('non-relative module');
    dependencies.add(repositoryPath(file, spec, files, root));
  };
  const text = () => { const token = take(); if (token.type !== 'string') unsupported('nonliteral string'); return v(token); };
  const anchored = spec => ({ kind: 'path', file: repositoryPath(file, spec, files, root) });
  const value = () => {
    if (++depth > 64) unsupported('expression nesting limit');
    try {
      let result;
      const token = ts[at];
      if (token?.type === 'string') { at++; result = { kind: 'scalar', value: v(token) }; }
      else if (token?.type === 'number' || peek() === '-') {
        const sign = peek() === '-' ? (take('-'), -1) : 1, number = take();
        if (number.type !== 'number' || !Number.isFinite(Number(v(number)))) unsupported('number');
        result = { kind: 'scalar', value: sign * Number(v(number)) };
      } else if (['true', 'false', 'null'].includes(peek())) result = { kind: 'scalar', value: JSON.parse(v(take())) };
      else if (peek() === '[') {
        take('['); const items = [];
        while (peek() !== ']') { items.push(value()); if (peek() !== ',') break; take(','); }
        take(']'); result = { kind: 'array', items };
      } else if (peek() === '{') {
        take('{'); const fields = new Map();
        while (peek() !== '}') {
          const key = take(); if (!['identifier', 'string'].includes(key.type) || fields.has(v(key))) unsupported('object key');
          take(':'); fields.set(v(key), value()); if (peek() !== ',') break; take(',');
        }
        take('}'); result = { kind: 'object', fields };
      } else if (peek() === 'new') {
        take('new'); take('URL'); take('('); const spec = text(); take(',');
        take('import'); take('.'); take('meta'); take('.'); take('url'); take(')');
        if (!spec.startsWith('.') && !path.posix.isAbsolute(spec)) unsupported('URL scheme');
        result = { ...anchored(spec), kind: 'url' };
      } else if (peek() === 'process') {
        take('process'); take('.'); take('execPath'); result = { kind: 'node' };
      } else {
        const id = name(), binding = bindings.get(id);
        if (binding?.kind === 'fileURLToPath') {
          take('('); result = value(); take(')');
          if (result.kind !== 'url') unsupported('fileURLToPath argument'); result = { ...result, kind: 'path' };
        } else if (binding?.kind === 'constant') result = binding.value;
        else unsupported(`unrecognized value: ${id}`);
      }
      // Only indexing a known, literal data array by a numeric literal is
      // understood. All other bracket reads, including stored methods, refuse.
      while (peek() === '[') {
        take('['); const key = take(); take(']');
        if (result.kind !== 'array' || key.type !== 'number' || !/^\d+$/.test(v(key)) || Number(v(key)) >= result.items.length) unsupported('bracket member access');
        result = result.items[Number(v(key))];
      }
      return result;
    } finally { depth--; }
  };
  const named = () => {
    take('{'); const specifiers = [];
    while (peek() !== '}') {
      const imported = take(); if (imported.type !== 'identifier') unsupported('import/export specifier');
      const local = peek() === 'as' ? (take('as'), name()) : v(imported);
      specifiers.push({ imported: v(imported), local }); if (peek() !== ',') break; take(',');
    }
    take('}'); return specifiers;
  };
  const declaration = () => {
    take('import');
    if (ts[at]?.type === 'string') { moduleTarget(text()); take(';'); return; }
    const specifiers = [];
    if (peek() !== '{' && peek() !== '*') {
      specifiers.push({ imported: 'default', local: name() });
      if (peek() !== 'from') take(',');
    }
    if (peek() === '{') specifiers.push(...named());
    else if (peek() === '*') { take('*'); take('as'); specifiers.push({ imported: '*', local: name() }); }
    take('from'); const spec = text(); take(';');
    const native = ['child_process', 'node:child_process'].includes(spec), url = ['url', 'node:url'].includes(spec);
    if (!native && !url) moduleTarget(spec);
    for (const part of specifiers) {
      if (reserved.has(part.local)) unsupported('reserved import binding');
      if (native && !launchers.has(part.imported)) unsupported('unrecognized child_process import');
      if (url && part.imported !== 'fileURLToPath') unsupported('unrecognized URL import');
      bind(part.local, native ? { kind: 'launcher', method: part.imported } : { kind: url ? 'fileURLToPath' : 'opaque' });
    }
    if (!specifiers.length) unsupported('empty builtin/import binding form');
  };
  const scalar = (item, type) => item?.kind === 'scalar' && typeof item.value === type;
  // This is an option allowlist. Every other key, including env/cwd and all
  // executable controls, is unknown even when its supplied value looks literal.
  const optionTypes = {
    silent: item => scalar(item, 'boolean'), detached: item => scalar(item, 'boolean'), windowsHide: item => scalar(item, 'boolean'),
    encoding: item => scalar(item, 'string') && ['utf8', 'utf-8', 'buffer'].includes(item.value),
    stdio: item => scalar(item, 'string') && ['inherit', 'ignore', 'pipe'].includes(item.value),
    timeout: item => scalar(item, 'number') && Number.isSafeInteger(item.value) && item.value >= 0,
    maxBuffer: item => scalar(item, 'number') && Number.isSafeInteger(item.value) && item.value > 0,
  };
  const target = (item, url = false) => {
    if (item?.kind === 'path' || url && item?.kind === 'url') { dependencies.add(item.file); return; }
    if (!scalar(item, 'string') || !path.posix.isAbsolute(item.value)) unsupported('launcher target must be URL-anchored or absolute');
    dependencies.add(repositoryPath(file, item.value, files, root));
  };
  const launch = binding => {
    const method = binding.method; take(); take('(');
    if (!['fork', 'spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(method)) unsupported('shell launcher form');
    if (method === 'fork') target(value(), true);
    else {
      if (value().kind !== 'node') unsupported('launcher executable');
      take(','); const argv = value();
      if (argv.kind !== 'array' || !argv.items.length || argv.items.slice(1).some(item => item.kind !== 'scalar')) unsupported('launcher argv');
      target(argv.items[0]);
    }
    if (peek() === ',') {
      take(',');
      if (method === 'fork' && peek() === '[') {
        const argv = value(); if (argv.kind !== 'array' || argv.items.some(item => item.kind !== 'scalar')) unsupported('fork argv');
        if (peek() === ',') take(','); else { take(')'); take(';'); return; }
      }
      if (peek() !== '{') unsupported('nonliteral process options');
      const options = value();
      if (options.kind !== 'object' || [...options.fields].some(([key, item]) => !Object.hasOwn(optionTypes, key) || !optionTypes[key](item))) unsupported('unrecognized process option');
    }
    take(')'); take(';');
  };
  try {
    while (at < ts.length) {
      if (peek() === ';') { take(';'); continue; }
      if (peek() === 'import' && syntax(ts[at + 1]) !== '(') { declaration(); continue; }
      if (peek() === 'export') {
        take('export');
        if (['{', '*'].includes(peek())) {
          const star = peek() === '*', parts = star ? (take('*'), []) : named();
          if (star && peek() !== 'from') unsupported('star re-export form');
          if (peek() === 'from') {
            take('from'); const spec = text();
            if (['child_process', 'node:child_process'].includes(spec)) unsupported('re-export of child_process');
            moduleTarget(spec);
          } else for (const part of parts) if (bindings.get(part.imported)?.kind !== 'constant') unsupported('re-exported nonconstant/launcher binding');
          take(';'); continue;
        }
        if (peek() === 'default') { take('default'); value(); take(';'); continue; }
        if (peek() !== 'const') unsupported('export form');
      }
      if (peek() === 'const') {
        take('const'); const id = name(); take('='); bind(id, { kind: 'constant', value: value() }); take(';'); continue;
      }
      if (peek() === 'await' || peek() === 'import') {
        if (peek() === 'await') take('await'); take('import'); take('('); moduleTarget(text()); take(')'); take(';'); continue;
      }
      if (bindings.get(peek())?.kind === 'launcher') { launch(bindings.get(peek())); continue; }
      unsupported(`statement/token: ${peek()}`);
    }
  } catch (error) { fail(error); }
  return { dependencies: [...dependencies].sort(), unknown };
}

export function executionClosure(tree, entries) {
  const paths = new Set(), unknown = [], queue = [...entries];
  const fail = (file, reason) => { if (unknown.length < 128) unknown.push({ file, reason }); };
  while (queue.length) {
    const file = queue.pop(); if (paths.has(file)) continue;
    paths.add(file);
    if (paths.size > 10000) { fail(file, 'execution closure exceeds 10000 files'); break; }
    const entry = tree.files.get(file);
    if (!entry || !['100644', '100755'].includes(entry.mode)) { fail(file, 'missing or non-regular execution input'); continue; }
    try {
      const source = tree.read(file);
      if (/\.json$/.test(file)) {
        const data = JSON.parse(source), strings = [];
        const visit = value => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child); };
        visit(data); queue.push(...literalEdges(file, strings, tree.files, tree.root)); continue;
      }
      if (!/\.(?:mjs|js|cjs)$/.test(file)) { fail(file, 'unsupported launcher or configuration'); continue; }
      const reach = sourceReach(file, source, tree.files, { root: tree.root });
      for (const edge of reach.unknown) fail(file, edge.reason);
      queue.push(...reach.dependencies);
    } catch (error) { fail(file, error.message); }
  }
  return { paths: [...paths].sort(), unknown };
}
