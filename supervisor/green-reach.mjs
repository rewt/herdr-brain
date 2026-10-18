// Conservative source inventory, never a JavaScript evaluator. Unsupported
// loads/launches are retained as unknown, even when another edge was resolved.
import path from 'node:path';
import { isBuiltin } from 'node:module';

const script = /\.(?:mjs|cjs|js|sh|json|ya?ml)$/;
const identifier = /^[A-Za-z_$][\w$]*$/;
const launcher = /^(?:fork|spawn(?:Sync)?|exec(?:Sync|File|FileSync)?)$/;
const value = token => token?.v;
const regexPrefix = new Set(['(', '[', '{', '}', ',', ':', ';', '?', '!', '~', '=>',
  '=', '+=', '-=', '*=', '**=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
  '+', '-', '*', '**', '/', '%', '<<', '>>', '>>>', '<', '>', '<=', '>=', '==', '!=', '===', '!==', '&', '|', '^', '&&', '||', '??',
  'typeof', 'else', 'do', 'in', 'of', 'instanceof', 'await', 'yield', 'void', 'delete', 'new', 'return', 'case', 'throw']);

// Keep strings, comments, regexes and template expressions separate. Escaped
// identifiers and syntax outside this scanner's profile fail closed.
function lex(source, choices) {
  const out = []; let i = 0;
  const add = (v, type = 'token') => { if (out.length >= 100000) throw Error('source exceeds token limit'); out.push({ v, type }); };
  const quoted = quote => {
    let text = ''; i++;
    while (i < source.length) {
      let c = source[i++];
      if (c === quote) return text;
      if (c !== '\\') { if (/[\r\n]/.test(c)) throw Error('newline in string'); text += c; continue; }
      c = source[i++];
      if (c === '\n') continue;
      if (c === '\r') { if (source[i] === '\n') i++; continue; }
      if (c === 'x' || c === 'u') {
        const length = c === 'x' ? 2 : 4;
        if (source[i] === '{') {
          const end = source.indexOf('}', ++i), digits = source.slice(i, end);
          if (end < 0 || !/^[a-f\d]{1,6}$/i.test(digits)) throw Error('unknown string escape');
          text += String.fromCodePoint(parseInt(digits, 16)); i = end + 1;
        } else {
          const digits = source.slice(i, i + length);
          if (!new RegExp(`^[a-f\\d]{${length}}$`, 'i').test(digits)) throw Error('unknown string escape');
          text += String.fromCharCode(parseInt(digits, 16)); i += length;
        }
      } else if (c === '0' && !/[0-9]/.test(source[i] ?? '')) text += '\0';
      else if (/[0-9]/.test(c)) throw Error('numeric string escape');
      else text += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[c] ?? c;
    }
    throw Error('unterminated string');
  };
  const scan = templateExpression => {
    let braces = 0;
    while (i < source.length) {
      const c = source[i], next = source[i + 1];
      if (/\s/.test(c)) { i++; continue; }
      if (i === 0 && source.startsWith('#!')) { i = source.indexOf('\n'); if (i < 0) return; continue; }
      if (c === '/' && next === '/') { i = source.indexOf('\n', i); if (i < 0) { i = source.length; return; } continue; }
      if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); if (end < 0) throw Error('unterminated comment'); i = end + 2; continue; }
      if (c === '"' || c === "'") { add(quoted(c), 'string'); continue; }
      if (c === '`') {
        i++; let raw = '', dynamic = false, closed = false;
        while (i < source.length) {
          if (source[i] === '`') { i++; closed = true; break; }
          if (source[i] === '\\') { raw += source.slice(i, i + 2); i += 2; continue; }
          if (source[i] === '$' && source[i + 1] === '{') { dynamic = true; i += 2; add('template', 'template'); scan(true); continue; }
          raw += source[i++];
        }
        if (!closed) throw Error('unterminated template');
        // Escaped static templates are deliberately unsupported as paths.
        add(raw, dynamic || raw.includes('\\') ? 'template' : 'string'); continue;
      }
      const previous = out.at(-1), member = ['.', '?.'].includes(value(out.at(-2)));
      let startsRegex = !previous || (previous.type === 'token' && !member && regexPrefix.has(previous.v));
      if (c === '/' && previous?.type === 'token' && [')', '}', 'of'].includes(previous.v) && !member) {
        // Braces and parentheses can end either an expression or a statement.
        // Retain both lexical readings rather than letting a fake string hide
        // a later loader. Contextual `of` can also be an ordinary identifier.
        if (!choices.has(i)) throw { slash: i };
        startsRegex = choices.get(i);
      }
      if (c === '/' && startsRegex) {
        i++; let bracket = false, closed = false;
        while (i < source.length && !/[\r\n]/.test(source[i])) {
          const r = source[i++];
          if (r === '\\') { i++; continue; }
          if (r === '[') bracket = true;
          if (r === ']') bracket = false;
          if (r === '/' && !bracket) { closed = true; break; }
        }
        if (!closed) throw Error('unterminated regular expression');
        while (/[a-z]/i.test(source[i] ?? '') && i < source.length) i++;
        add('regexp', 'regexp'); continue;
      }
      if (c === '\\' || c.charCodeAt(0) > 127) throw Error('unsupported source identifier');
      const word = /^[A-Za-z_$][\w$]*|^\d+(?:\.\d+)?/.exec(source.slice(i));
      if (word) { add(word[0]); i += word[0].length; continue; }
      if (templateExpression && c === '}' && braces === 0) { i++; return; }
      if (c === '{') braces++;
      if (c === '}') braces--;
      const operator = /^(?:>>>=|===|!==|\*\*=|<<=|>>=|&&=|\|\|=|\?\?=|>>>|=>|\?\.|\.\.\.|==|!=|<=|>=|<<|>>|\*\*|&&|\|\||\?\?|\+\+|--|[+*/%&|^\-]=)/.exec(source.slice(i));
      add(operator?.[0] ?? c); i += operator?.[0].length ?? 1;
    }
    if (templateExpression) throw Error('unterminated template expression');
  };
  try { scan(false); return { tokens: out }; }
  catch (error) { return Number.isInteger(error.slash) ? { slash: error.slash } : { error }; }
}

function tokenReadings(source) {
  const pending = [new Map()], readings = []; let passes = 0, firstError;
  while (pending.length) {
    if (++passes > 64) throw Error('regex/division analysis exceeds work limit');
    const choices = pending.pop(), result = lex(source, choices);
    if (result.slash !== undefined) {
      pending.push(new Map([...choices, [result.slash, true]]), new Map([...choices, [result.slash, false]]));
    } else if (result.error) firstError ??= result.error;
    else readings.push(result.tokens);
  }
  if (!readings.length) throw firstError ?? Error('source has no supported lexical reading');
  return readings;
}
function tokens(source) {
  const readings = tokenReadings(source);
  // Include all identifiers, so renamed launcher bindings are covered too.
  const signature = ts => JSON.stringify(ts.filter(t => ['string', 'template'].includes(t.type) ||
    t.type === 'token' && identifier.test(t.v)).map(t => [t.type, t.v]));
  const expected = signature(readings[0]);
  if (readings.some(ts => signature(ts) !== expected)) throw Error('ambiguous regex/division execution tokens');
  return readings[0];
}

// This derivation reads the trusted running source, not candidate modules.
// Union static declarations over every lexical reading; unlike execution reach,
// authority protection only grows when a slash has multiple interpretations.
export function staticImportClosure(tree, entries) {
  const paths = new Set(), unknown = [], queue = [...entries];
  while (queue.length) {
    const file = queue.pop(); if (paths.has(file)) continue;
    paths.add(file);
    if (paths.size > 10000) { unknown.push({ file, reason: 'authority closure exceeds file limit' }); break; }
    try {
      for (const ts of tokenReadings(tree.read(file))) for (let i = 0; i < ts.length; i++) {
        if (ts[i].type !== 'token') continue;
        const kind = value(ts[i]);
        if (!(kind === 'import' && !['(', '.'].includes(value(ts[i + 1]))) && kind !== 'export') continue;
        let end = i + 1, spec;
        if (kind === 'import' && ts[end]?.type === 'string') spec = ts[end].v;
        else if (kind === 'import' || ['{', '*'].includes(value(ts[end]))) {
          while (end < ts.length && !(ts[end].type === 'token' && [';', 'from'].includes(value(ts[end])))) end++;
          if (value(ts[end]) === 'from' && ts[end + 1]?.type === 'string') spec = ts[end + 1].v;
        }
        if (spec === undefined || isBuiltin(spec)) continue;
        if (!spec.startsWith('.')) throw Error(`unsupported authority import: ${spec}`);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        if (target.startsWith('../') || path.posix.isAbsolute(target)) throw Error('authority import escapes source tree');
        queue.push(target);
      }
    } catch (error) { unknown.push({ file, reason: error.message }); }
  }
  return { paths: [...paths].sort(), unknown };
}

function group(ts, start, open = '(', close = ')') {
  if (value(ts[start]) !== open) return null;
  const parts = []; let from = start + 1, depth = 0;
  for (let i = from; i < ts.length; i++) {
    if (ts[i].type !== 'token') continue;
    const v = value(ts[i]);
    if (v === close && depth === 0) { parts.push(ts.slice(from, i)); return { parts, end: i }; }
    if (v === ',' && depth === 0) { parts.push(ts.slice(from, i)); from = i + 1; }
    if (['(', '[', '{'].includes(v)) depth++;
    if (depth > 128) throw Error('expression exceeds nesting limit');
    if ([')', ']', '}'].includes(v)) depth--;
  }
  throw Error('unbalanced expression');
}
const joined = ts => ts.map(t => t.type === 'string' ? JSON.stringify(t.v) : t.v).join(' ');

export function sourceReach(file, source, files) {
  const dependencies = new Set(), unknown = [];
  const fail = reason => { if (unknown.length < 32) unknown.push({ file, reason }); };
  try {
    const ts = tokens(source), bindings = new Map(), native = new Map(), dispatchImports = new Set(), dispatchCalls = new Set();
    if (ts.some(t => ['constructor', '__proto__', 'prototype'].includes(t.v))) fail('unsupported reflective property');
    const resolve = spec => {
      if (isBuiltin(spec)) return;
      if (!spec.startsWith('.')) { fail(`non-relative module: ${spec}`); return; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!files.has(target)) { fail(`missing repository module: ${spec}`); return; }
      dependencies.add(target);
    };
    // All literal repository file references are edges, regardless of which
    // branch/dispatch command uses them. Basenames match every tracked target.
    for (const t of ts) if (t.type === 'string' && script.test(t.v)) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), t.v));
      for (const candidate of [relative, t.v]) if (files.has(candidate)) dependencies.add(candidate);
      if (!t.v.includes('/')) for (const candidate of files.keys()) if (path.posix.basename(candidate) === t.v) dependencies.add(candidate);
    }
    for (let i = 0; i < ts.length; i++) {
      if (ts[i].type !== 'token') continue;
      const v = value(ts[i]);
      if ((v === 'import' && !['(', '.'].includes(value(ts[i + 1]))) || v === 'export') {
        let end = i + 1;
        if (v === 'import' && ts[end]?.type === 'string') resolve(ts[end].v);
        else {
          while (end < ts.length && ![';', 'from'].includes(value(ts[end]))) end++;
          if (value(ts[end]) === 'from' && ts[end + 1]?.type === 'string') {
            const spec = ts[end + 1].v; resolve(spec);
            if (['child_process', 'node:child_process'].includes(spec)) {
              if (v === 'export') fail('re-export of child_process');
              if (value(ts[i + 1]) !== '{') fail('namespace/default process launcher import');
              for (let j = i + 1; j < end; j++) if (launcher.test(value(ts[j]))) {
                native.set(value(ts[j + 1]) === 'as' ? value(ts[j + 2]) : ts[j].v, { method: ts[j].v, declaration: j });
              }
            }
          }
        }
      }
      if (['eval', 'Function', 'createRequire', 'require', 'globalThis', 'global', 'Reflect', 'WebAssembly', 'getBuiltinModule', 'binding', 'dlopen'].includes(v)) fail(`unsupported code loader/reflection: ${v}`);
      if (ts[i].type === 'token' && v === 'from' && ['vm', 'node:vm', 'module', 'node:module', 'worker_threads', 'node:worker_threads'].includes(value(ts[i + 1]))) fail(`unsupported code loader module: ${value(ts[i + 1])}`);
    }
    // A locally imported launcher may be exported before its import declaration
    // in source order. Check exports after building the complete registry.
    for (let i = 0; i < ts.length; i++) if (ts[i].type === 'token' && value(ts[i]) === 'export') {
      if (value(ts[i + 1]) === '{' && group(ts, i + 1, '{', '}').parts.some(p => native.has(value(p[0])))) fail('re-exported process launcher binding');
      if (value(ts[i + 1]) === 'default' && native.has(value(ts[i + 2]))) fail('re-exported process launcher binding');
    }
    // Closed dynamic-import wrappers: no aliases, reassignment or escaping
    // helper. Every call contributes its literal first argument, not just the
    // command used by the cross-project caller (org's lazy table uses this).
    let dispatchWork = 0;
    for (let i = 0; i < ts.length; i++) if (value(ts[i]) === 'const' && identifier.test(value(ts[i + 1])) && value(ts[i + 2]) === '=') {
      let end = i + 3;
      while (end < ts.length && value(ts[end]) !== ';') end++;
      const body = joined(ts.slice(i + 3, end));
      const simple = /^(?:\( (\w+) \)|(\w+)) => import \( (\w+) \)$/.exec(body);
      const table = /^\( (\w+) , (\w+) \) => async \( (\w+) \) => \( await import \( (\w+) \) \) \[ (\w+) \] \( (\w+) \)$/.exec(body);
      if (!(simple && (simple[1] ?? simple[2]) === simple[3]) && !(table && table[1] === table[4] && table[2] === table[5] && table[3] === table[6])) continue;
      if ((dispatchWork += ts.length) > 2000000) throw Error('dispatch analysis exceeds work limit');
      const name = value(ts[i + 1]); let valid = true, calls = 0;
      for (let j = 0; j < ts.length; j++) if (ts[j].type === 'token' && value(ts[j]) === name && (j < i || j > end)) {
        if (value(ts[j + 1]) !== '(') { valid = false; break; }
        const args = group(ts, j + 1);
        if (args.parts[0].length !== 1 || args.parts[0][0].type !== 'string') { valid = false; break; }
        resolve(args.parts[0][0].v); calls++;
      }
      if (valid && calls) for (let j = i + 3; j < end; j++) {
        if (value(ts[j]) === 'import' && value(ts[j + 1]) === '(') dispatchImports.add(j);
        if (value(ts[j]) === ']' && value(ts[j + 1]) === '(') dispatchCalls.add(j);
      }
    }
    const expression = (parts, seen = new Set()) => {
      const s = joined(parts);
      if (parts.length === 1 && parts[0].type === 'string') return parts[0].v;
      if (s === 'process . execPath') return '@node';
      if (parts.length === 1 && bindings.has(s) && !seen.has(s)) return expression(bindings.get(s), new Set([...seen, s]));
      // These literal URL/path wrappers cannot introduce a computed filename.
      let url = parts;
      if (value(url[0]) === 'fileURLToPath' && value(url[1]) === '(' && group(url, 1)?.end === url.length - 1) url = url.slice(2, -1);
      if (url.length === 11 && joined(url.slice(0, 3)) === 'new URL (' && url[3].type === 'string' && joined(url.slice(4)) === ', import . meta . url )') {
        return path.posix.normalize(path.posix.join(path.posix.dirname(file), url[3].v));
      }
      return null;
    };
    for (let i = 0; i < ts.length; i++) if (value(ts[i]) === 'const' && identifier.test(value(ts[i + 1])) && value(ts[i + 2]) === '=') {
      let end = i + 3, depth = 0;
      for (; end < ts.length; end++) {
        const v = value(ts[end]);
        if (depth === 0 && [';', ','].includes(v)) break;
        if (['(', '[', '{'].includes(v)) depth++;
        if ([')', ']', '}'].includes(v)) depth--;
      }
      const name = value(ts[i + 1]);
      // Multiple declarations/shadowing are unknown, never pick a convenient one.
      bindings.set(name, bindings.has(name) ? [] : ts.slice(i + 3, end));
    }
    // A function parameter can shadow a constant in any nested scope. Losing
    // precision is preferable to using the outer constant for a dynamic load.
    for (let i = 0; i < ts.length; i++) {
      if (value(ts[i + 1]) === '=>' && identifier.test(value(ts[i]))) bindings.delete(value(ts[i]));
      if (value(ts[i]) !== '(') continue;
      const args = group(ts, i);
      if (['=>', '{'].includes(value(ts[args.end + 1])) && !['if', 'while', 'for', 'switch', 'with'].includes(value(ts[i - 1]))) {
        for (const p of args.parts.flat()) if (identifier.test(value(p))) { bindings.delete(value(p)); if (native.has(value(p))) fail('shadowed process launcher'); }
      }
    }
    // A closed literal command map can dispatch by an input key. Its complete
    // set of value expressions was already scanned; the selected key does not
    // remove any edge. Escapes, spreads, computed keys and mutation are unknown.
    for (const [name, body] of bindings) {
      if (value(body[0]) !== '{') continue;
      const object = group(body, 0, '{', '}');
      if (object.end !== body.length - 1 || object.parts.some(p => ['...', '['].includes(value(p[0])))) continue;
      const calls = new Set(); let closed = true;
      for (let i = 0; i < ts.length; i++) if (ts[i].type === 'token' && value(ts[i]) === name) {
        if (value(ts[i - 1]) === 'const') continue;
        if (value(ts[i + 1]) === '[') {
          const key = group(ts, i + 1, '[', ']');
          if (value(ts[key.end + 1]) === '(') { calls.add(key.end); continue; }
        }
        if (joined(ts.slice(Math.max(0, i - 4), i)) === 'Object . hasOwn (' && value(ts[i + 1]) === ',') continue;
        closed = false;
      }
      if (closed) for (const index of calls) dispatchCalls.add(index);
    }
    for (let i = 0; i < ts.length; i++) {
      if (ts[i].type !== 'token') continue;
      const v = value(ts[i]);
      if (v === ']' && value(ts[i + 1]) === '(' && !dispatchCalls.has(i)) fail('unresolved computed call');
      if (v === 'import' && value(ts[i + 1]) === '(' && !dispatchImports.has(i)) {
        const args = group(ts, i + 1), spec = expression(args.parts[0]);
        if (spec === null) fail('unresolved dynamic import'); else resolve(spec);
        if (spec && /^(?:node:)?(?:child_process|module|vm|worker_threads)$/.test(spec)) fail('dynamic code-loader builtin');
      }
      const imported = native.get(v);
      if (!imported) continue;
      if (imported?.declaration === i || value(ts[i - 1]) === 'as') continue;
      if (value(ts[i + 1]) !== '(') { fail(`escaped process launcher: ${v}`); continue; }
      const args = group(ts, i + 1), executable = expression(args.parts[0]), method = imported?.method ?? v;
      if (['exec', 'execSync'].includes(method)) { fail('shell execution'); continue; }
      let options = args.parts[2];
      if (method === 'fork' && args.parts[1]?.length) {
        let second = args.parts[1];
        // Only a bound literal array has a stable argv/options role. An object
        // binding may have acquired executable options after its declaration.
        const bound = second.length === 1 && bindings.get(value(second[0]));
        if (value(bound?.[0]) === '[') second = bound;
        if (value(second[0]) === '{') options = second;
        else if (value(second[0]) !== '[' || group(second, 0, '[', ']').end !== second.length - 1) {
          fail('unresolved fork argv/options'); continue;
        }
      }
      const optionFields = options?.length && value(options[0]) === '{' ? group(options, 0, '{', '}') : null;
      if (options?.length && (!optionFields || optionFields.end !== options.length - 1 || optionFields.parts.some(p => ['...', '[', 'get', 'set', 'shell', 'execPath', 'execArgv'].includes(value(p[0]))))) { fail('unresolved process options or shell'); continue; }
      if (method !== 'fork' && ['ps', 'kill'].includes(executable)) continue;
      if (method !== 'fork' && executable === 'git') {
        const argv = group(args.parts[1] ?? [], 0, '[', ']');
        const literal = argv?.parts.map(p => p.length === 1 && p[0].type === 'string' ? p[0].v : null);
        if (literal?.length && literal.every(v => v !== null) && ['rev-parse', 'status', 'ls-tree', 'cat-file', 'merge-base', 'log', 'show'].includes(literal[0]) && !literal.some(v => v === '-c' || v.startsWith('--config') || v.startsWith('--exec'))) continue;
        fail('unresolved Git command/configuration'); continue;
      }
      if (method === 'fork' || ['@node', 'node', 'bash', 'sh'].includes(executable)) {
        let argv = args.parts[1];
        if (argv?.length === 1 && bindings.has(value(argv[0]))) argv = bindings.get(value(argv[0]));
        const first = group(argv ?? [], 0, '[', ']')?.parts[0], target = method === 'fork' ? executable : first && expression(first);
        if (!target || target.startsWith('-')) { fail('unresolved script argv'); continue; }
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
        if (files.has(target)) dependencies.add(target);
        else if (files.has(relative)) dependencies.add(relative);
        else fail(`unresolved spawned script: ${target}`);
      } else if (executable && files.has(executable)) dependencies.add(executable);
      else fail(`unresolved process executable: ${executable ?? joined(args.parts[0])}`);
    }
  } catch (error) { fail(error.message); }
  return { dependencies: [...dependencies].sort(), unknown };
}

export function executionClosure(tree, entries) {
  const paths = new Set(), unknown = [], queue = [...entries];
  while (queue.length) {
    const file = queue.pop(); if (paths.has(file)) continue;
    paths.add(file);
    if (paths.size > 10000) { unknown.push({ file, reason: 'execution closure exceeds 10000 files' }); break; }
    const entry = tree.files.get(file);
    if (!entry || !['100644', '100755'].includes(entry.mode)) { unknown.push({ file, reason: 'missing or non-regular execution input' }); continue; }
    if (/\.json$/.test(file)) { try { JSON.parse(tree.read(file)); } catch { unknown.push({ file, reason: 'unreadable JSON input' }); } continue; }
    if (!/\.(?:mjs|js|cjs)$/.test(file)) { unknown.push({ file, reason: 'unsupported launcher or configuration' }); continue; }
    const reach = sourceReach(file, tree.read(file), tree.files);
    unknown.push(...reach.unknown.slice(0, Math.max(0, 128 - unknown.length))); queue.push(...reach.dependencies);
  }
  return { paths: [...paths].sort(), unknown };
}
