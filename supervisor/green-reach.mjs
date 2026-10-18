// Execution-edge profile, never a JavaScript evaluator. Ordinary code is opaque;
// every load/launch capability must match a closed, understood production.
import path from 'node:path';

const script = /\.(?:mjs|cjs|js|sh|json|ya?ml)$/;
const launchers = new Set(['fork', 'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']);
const reserved = new Set(('await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield process URL undefined').split(' '));
const v = token => token?.value;
const unsupported = detail => { throw Error(`outside closed source profile: ${detail}`); };

// Leaf imports are explicit: being a Node builtin does not make a module safe.
// Loader, debugger, worker, REPL and test-runner modules are deliberately absent.
const leafModules = new Set(('fs fs/promises path path/posix path/win32 crypto os url util util/types assert assert/strict events stream stream/promises stream/consumers stream/web buffer timers timers/promises string_decoder querystring punycode zlib readline readline/promises tty console constants async_hooks diagnostics_channel perf_hooks').split(' '));
const regexPrefix = new Set(('return throw case break continue debugger delete void typeof instanceof in new yield await else do extends default of = => ( [ { , : ; ! ~ ? + - * ** % & | ^ && || ?? == === != !== < > <= >= << >> >>> ...').split(' '));
const reflection = new Set(['eval', 'Function', 'require', 'createRequire', 'getBuiltinModule', 'dlopen', 'binding', 'mainModule', 'constructor', '__proto__', 'prototype', 'Reflect', 'WebAssembly', 'global', 'globalThis', 'execArgv', 'NODE_OPTIONS', 'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'defineProperty', 'defineProperties', '__lookupGetter__', '__lookupSetter__', '__defineGetter__', '__defineSetter__', 'setEngine']);
const processLeaves = new Set(('env argv argv0 execPath pid ppid platform arch versions version cwd chdir exit exitCode stdin stdout stderr uptime hrtime memoryUsage cpuUsage resourceUsage kill on once off removeListener removeAllListeners emit nextTick getuid geteuid getgid getegid getgroups send connected disconnect title release features config').split(' '));
// crypto also exposes a native engine loader. Namespace objects cannot escape
// into enumeration/aliasing and recover it without mentioning its property.
const cryptoLeaves = new Set(('constants createHash createHmac createPrivateKey createPublicKey createSecretKey createSign createVerify createCipheriv createDecipheriv createECDH createDiffieHellman createDiffieHellmanGroup randomUUID randomBytes randomFill randomFillSync randomInt getRandomValues timingSafeEqual sign verify hash webcrypto subtle generateKey generateKeySync generateKeyPair generateKeyPairSync hkdf hkdfSync pbkdf2 pbkdf2Sync scrypt scryptSync getHashes getCiphers getCurves getCipherInfo getDiffieHellman diffieHellman checkPrime checkPrimeSync generatePrime generatePrimeSync secureHeapUsed getFips setFips publicEncrypt publicDecrypt privateEncrypt privateDecrypt Certificate X509Certificate').split(' '));

// No speculative lexer branch can be discarded. Slash contexts that require a
// statement/expression parse (notably after ) or }) refuse. Template expressions
// are recursively tokenized so a loader inside interpolation remains visible.
function lex(source) {
  const tokens = []; let i = 0, nesting = 0;
  const add = (value, type, offset = i) => {
    if (tokens.length >= 100000) unsupported('token limit');
    tokens.push({ value, type, offset });
  };
  const lineEnd = () => {
    const offset = source.slice(i).search(/[\r\n\u2028\u2029]/);
    i = offset < 0 ? source.length : i + offset;
  };
  const quoted = (quote, open = true) => {
    let text = ''; if (open) i++;
    while (i < source.length) {
      let c = source[i++];
      if (c === quote) return { text, more: false };
      if (quote === '`' && c === '$' && source[i] === '{') { i++; return { text, more: true }; }
      if (c !== '\\') { if (quote !== '`' && /[\r\n\u2028\u2029]/.test(c)) unsupported('multiline string'); text += c; continue; }
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
    unsupported('unterminated string/template');
  };
  const scan = (template = false) => {
    if (++nesting > 64) unsupported('template nesting limit');
    let braces = 0;
    while (i < source.length) {
      const c = source[i], offset = i;
      if (/\s/.test(c)) { i++; continue; }
      if (i === 0 && source.startsWith('#!')) { lineEnd(); continue; }
      if (source.startsWith('//', i)) { lineEnd(); continue; }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2); if (end < 0) unsupported('unterminated comment'); i = end + 2; continue;
      }
      if (c === '"' || c === "'") { add(quoted(c).text, 'string', offset); continue; }
      if (c === '`') {
        let part = quoted('`');
        if (!part.more) { add(part.text, 'string', offset); continue; }
        add(part.text, 'template', offset);
        while (part.more) {
          add('(', 'punctuation'); scan(true); add(')', 'punctuation');
          part = quoted('`', false); add(part.text, 'template');
        }
        continue;
      }
      if (template && c === '}' && braces === 0) { i++; nesting--; return; }
      if (c === '/') {
        const previous = tokens.at(-1), before = v(tokens.at(-2)), member = ['.', '?.', '#'].includes(before);
        if (!member && [')', '}', 'of'].includes(v(previous))) unsupported('ambiguous regex/division syntax');
        if (previous?.type === 'identifier' && ['break', 'continue'].includes(before)) unsupported('ambiguous slash after a jump label');
        if (!previous || !member && previous.type !== 'string' && regexPrefix.has(v(previous))) {
          i++; let bracket = false, closed = false;
          while (i < source.length && !/[\r\n\u2028\u2029]/.test(source[i])) {
            const r = source[i++];
            if (r === '\\') { i++; continue; }
            if (r === '[') { if (bracket) unsupported('nested regular-expression character class'); bracket = true; }
            if (r === ']') bracket = false;
            if (r === '/' && !bracket) { closed = true; break; }
          }
          if (!closed) unsupported('unterminated regular expression');
          const flags = i;
          while (/[a-z]/i.test(source[i] ?? '') && i < source.length) i++;
          if (source.slice(flags, i).includes('v')) unsupported('unicode-sets regular expression');
          add('regexp', 'regexp', offset); continue;
        }
        const operator = source[i + 1] === '=' ? '/=' : '/'; add(operator, 'punctuation'); i += operator.length; continue;
      }
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
      if (word) { add(word[0], 'identifier'); i += word[0].length; continue; }
      const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)(?:n)?/.exec(source.slice(i));
      if (number) { add(number[0], 'number'); i += number[0].length; continue; }
      if (c === '{') braces++;
      if (c === '}') braces--;
      const operator = /^(?:>>>=|===|!==|\*\*=|<<=|>>=|&&=|\|\|=|\?\?=|>>>|=>|\?\.|\.\.\.|==|!=|<=|>=|<<|>>|\*\*|&&|\|\||\?\?|\+\+|--|[+*%&|^\-]=)/.exec(source.slice(i));
      if (operator) { add(operator[0], 'punctuation'); i += operator[0].length; continue; }
      if ('{}[](),;:=.*-+?!~<>&|^%#'.includes(c)) { add(c, 'punctuation'); i++; continue; }
      unsupported('lexical token/escaped or non-ASCII identifier');
    }
    if (template) unsupported('unterminated template expression');
    nesting--;
  };
  try { scan(); return { tokens }; }
  catch (error) { return { tokens, error, offset: i }; }
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
  const fail = (error, index = at) => {
    if (unknown.length < 32) { const offset = ts[index]?.offset ?? scanned.offset ?? source.length;
      unknown.push({ file, line: source.slice(0, offset).split('\n').length, reason: error.message }); }
  };
  const bindings = new Map(), declarations = new Set(), constants = new Map(), uses = new Set(), trusted = new Set();
  let at = 0, depth = 0, collecting = false;
  if (scanned.error) fail(scanned.error, ts.length);
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
    if (typeof spec !== 'string') unsupported('nonliteral module');
    if (leafModules.has(spec.replace(/^node:/, ''))) return;
    if (!spec.startsWith('.')) unsupported(`unsupported module: ${spec}`);
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
        const index = at, id = name(), binding = bindings.get(id);
        if (binding?.kind === 'fileURLToPath') {
          take('('); result = value(); take(')');
          if (result.kind !== 'url') unsupported('fileURLToPath argument'); result = { ...result, kind: 'path' };
        } else if (!collecting && binding?.kind === 'constant') { result = binding.value; uses.add(index); trusted.add(id); }
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
    const start = at; take('import');
    if (ts[at]?.type === 'string') { moduleTarget(text()); if (peek() === ';') take(';'); return; }
    const specifiers = [];
    if (peek() !== '{' && peek() !== '*') {
      specifiers.push({ imported: 'default', local: name() });
      if (peek() !== 'from') take(',');
    }
    if (peek() === '{') specifiers.push(...named());
    else if (peek() === '*') { take('*'); take('as'); specifiers.push({ imported: '*', local: name() }); }
    take('from'); const spec = text(); if (peek() === ';') take(';');
    const native = ['child_process', 'node:child_process'].includes(spec), url = ['url', 'node:url'].includes(spec);
    if (!native) moduleTarget(spec);
    if (native && !specifiers.length) unsupported('empty child_process import');
    for (const part of specifiers) {
      if (reserved.has(part.local) && !(url && part.local === 'URL' && part.imported === 'URL')) unsupported('reserved import binding');
      if (reflection.has(part.imported)) unsupported(`imported loader/reflection capability: ${part.imported}`);
      if (native && !launchers.has(part.imported)) unsupported('unrecognized child_process import');
      if (native || url && part.imported === 'fileURLToPath') bind(part.local, native ? { kind: 'launcher', method: part.imported } : { kind: 'fileURLToPath' });
      else if (['crypto', 'node:crypto'].includes(spec) && ['default', '*'].includes(part.imported)) bind(part.local, { kind: 'crypto' });
    }
    for (let i = start; i < at; i++) declarations.add(i);
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
  // Module declarations and closed constant bindings are collected before uses.
  // Other declarations/expressions remain ordinary code, not inferred values.
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i], key = syntax(token);
    if (key === 'import' && !['(', '.'].includes(syntax(ts[i + 1])) && !['.', '?.'].includes(syntax(ts[i - 1]))) {
      at = i;
      try { declaration(); i = at - 1; } catch (error) { fail(error, i); }
    }
  }
  for (let i = 0; i < ts.length; i++) if (syntax(ts[i]) === 'const' && ts[i + 1]?.type === 'identifier' && syntax(ts[i + 2]) === '=') {
    at = i + 1; collecting = true;
    try {
      const id = name(); take('='); const item = value();
      if (![';', ','].includes(peek())) unsupported('open constant expression');
      if (bindings.has(id) && bindings.get(id).kind !== 'constant') fail(Error(`shadowed execution capability: ${id}`), i + 1);
      else if (constants.has(id) || bindings.has(id)) { bindings.delete(id); constants.set(id, -1); }
      else { constants.set(id, i + 1); bind(id, { kind: 'constant', value: item }); }
    } catch { /* Ordinary expressions are not closed launcher values. */ }
    finally { collecting = false; }
  }
  const closing = new Map(), stack = [];
  for (let i = 0; i < ts.length; i++) if (ts[i].type === 'punctuation') {
    const key = v(ts[i]);
    if (['(', '[', '{'].includes(key)) { stack.push(i); if (stack.length > 128) { fail(Error('group nesting limit'), i); break; } }
    if ([')', ']', '}'].includes(key)) {
      const start = stack.pop();
      if ({'(': ')', '[': ']', '{': '}'}[v(ts[start])] !== key) fail(Error('unbalanced expression'), i);
      else closing.set(start, i);
    }
  }
  if (stack.length) fail(Error('unbalanced expression'), stack.at(-1));
  const endsValue = token => ['string', 'number', 'regexp', 'template'].includes(token?.type) ||
    token?.type === 'identifier' && !regexPrefix.has(v(token)) && !['const', 'let', 'var'].includes(v(token)) || [')', ']', '}'].includes(syntax(token));
  for (let i = 0; i < ts.length; i++) {
    if (declarations.has(i)) continue;
    const token = ts[i], key = syntax(token), previous = syntax(ts[i - 1]), next = syntax(ts[i + 1]);
    try {
      const constructorMethod = key === 'constructor' && ['{', ';', '}'].includes(previous) && next === '(';
      if (token.type === 'identifier' && reflection.has(key) && !constructorMethod) unsupported(`unresolved loader/reflection capability: ${key}`);
      if (key === '[' && (endsValue(ts[i - 1]) || previous === '?.' || [':', '('].includes(syntax(ts[(closing.get(i) ?? i) + 1])))) {
        const end = closing.get(i);
        const numeric = end === i + 2 && ts[i + 1]?.type === 'number' ||
          end === i + 3 && ['-', '+'].includes(syntax(ts[i + 1])) && ts[i + 2]?.type === 'number';
        if (!numeric) unsupported('computed member/key access');
      }
      if (key === 'process' && !['.', '?.'].includes(previous) && next !== '.') unsupported('escaped/shadowed process binding');
      if (key === 'process' && next === '.' && !processLeaves.has(syntax(ts[i + 2]))) unsupported(`unrecognized process capability: ${syntax(ts[i + 2])}`);
      if (key === 'URL' && previous !== 'new' && !['.', '?.'].includes(previous)) unsupported('escaped/shadowed URL binding');
      if (key === 'execPath' && previous === '.' && !['(', ')', ',', ';', ']', '}'].includes(next) && next !== undefined) unsupported('mutable executable binding');
      if (key === 'import' && next === '(' && !['.', '?.'].includes(previous)) {
        at = i + 1; take('('); moduleTarget(text()); take(')');
      }
      if (key === 'export' && ['{', '*'].includes(next)) {
        at = i + 1;
        if (next === '{') named(); else { take('*'); if (peek() === 'as') { take('as'); name(); } }
        if (peek() === 'from') { take('from'); moduleTarget(text()); }
      }
      const binding = bindings.get(key);
      if (binding?.kind === 'launcher') {
        if (previous === '.' || previous === '?.' || previous === 'new' || next !== '(') unsupported(`escaped/shadowed process launcher: ${key}`);
        at = i; launch(binding);
      }
      if (binding?.kind === 'fileURLToPath' && next !== '(') unsupported('escaped/shadowed fileURLToPath binding');
      if (binding?.kind === 'crypto' && (next !== '.' || !cryptoLeaves.has(syntax(ts[i + 2])))) unsupported('unrecognized/escaped crypto namespace capability');
    } catch (error) { fail(error, i); }
  }
  // A target constant is trusted only if every occurrence is its declaration or
  // an understood launcher argument. Aliases, mutation and parameter shadowing
  // cannot borrow the value of a convenient outer binding.
  for (const id of trusted) for (let i = 0; i < ts.length; i++) {
    if (ts[i].type === 'identifier' && v(ts[i]) === id && i !== constants.get(id) && !uses.has(i)) fail(Error(`escaped/shadowed launcher target: ${id}`), i);
  }
  return { dependencies: [...dependencies].sort(), unknown };
}

export function executionClosure(tree, entries) {
  const paths = new Set(), unknown = [], queue = [...entries];
  const fail = (file, reason, line) => { if (unknown.length < 128) unknown.push({ file, ...(line ? { line } : {}), reason }); };
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
      for (const edge of reach.unknown) fail(file, edge.reason, edge.line);
      queue.push(...reach.dependencies);
    } catch (error) { fail(file, error.message); }
  }
  return { paths: [...paths].sort(), unknown };
}
