// Permit only lane's generated private source/verify pair, never an arbitrary
// pane command or cleanup target. The acceptance TMPDIR keeps both in scratch.
import fs from 'node:fs';
import path from 'node:path';

const token = String.raw`'(?:[^']|'\\'')*'`;
const decode = value => value.slice(1, -1).replaceAll("'\\''", "'");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function isLaneEnvironmentCommand(command, root) {
  try {
    const match = new RegExp(`^ \\. (${token}) 2>/dev/null; command rm -f -- (${token}) (${token})$`, 'u').exec(command);
    if (!match) return false;
    const [file, removed, verifier] = match.slice(1).map(decode);
    const directory = path.dirname(file);
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(directory));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) ||
        !path.basename(directory).startsWith('herdr-lane-env-') || file !== removed ||
        file !== path.join(directory, 'prepare.sh') || verifier !== path.join(directory, 'verify.sh') ||
        fs.lstatSync(directory).isSymbolicLink() || (fs.statSync(directory).mode & 0o777) !== 0o700) return false;
    for (const entry of [file, verifier]) {
      const stat = fs.lstatSync(entry);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return false;
    }
    const source = fs.readFileSync(file, 'utf8');
    const exports = new RegExp(`^set \\+x\nexport ((${token})(?: ${token})*) \\|\\| return\ncommand /bin/sh (${token})\n$`, 'u').exec(source);
    if (!exports || decode(exports[3]) !== verifier) return false;
    const pairs = [...exports[1].matchAll(new RegExp(token, 'gu'))].map(item => decode(item[0]));
    if (pairs.some(pair => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(pair) || pair.includes('\0'))) return false;
    const effective = new Map(pairs.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    const proof = fs.readFileSync(verifier, 'utf8');
    const nonce = /'lane-env-[a-f0-9]{48}'\n$/u.exec(proof)?.[0].trim();
    if (!nonce) return false;
    const checks = [...effective].map(([key, value]) => `[ "\${${key}+x}" = x ] && [ "$${key}" = ${quote(value)} ]`).join(' && ');
    return proof === `${checks} && printf '\\n%s\\n' ${nonce}\n`;
  } catch { return false; }
}
