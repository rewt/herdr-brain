// Local release tooling; never alters native permissions or harness settings.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliHelp } from '../lib/cli-help.mjs';
import { productFiles } from '../lib/product-files.mjs';
import { PIN_FILE, acceptanceRecord, checkBundle, checkRelease, releaseAcceptance, requireReadyAcceptance,
  releaseProject, releaseHome, runRelease, pinStatus } from '../lib/releases.mjs';
cliHelp(import.meta.url, 'Usage: node herdr/releases.mjs manifest ROOT [SUMMARY] | install HOME BIN | pin HOME PROJECT TAG | unpin HOME PROJECT | attest HOME TAG SUMMARY | pin-status HOME PROJECT [--json] | exec HOME ENTRY [ARGS...] | run ENTRY [ARGS...]');

const [action, home, target, ...rest] = process.argv.slice(2);
try {
  if (action === 'manifest') {
    const commit = fs.readFileSync(path.join(home, '.release-commit'), 'utf8').trim();
    let acceptance = { ran: false, ready: false };
    if (target) {
      const bytes = fs.readFileSync(target);
      acceptance = acceptanceRecord(bytes, commit);
      fs.writeFileSync(path.join(home, '.release-acceptance.json'), bytes);
    }
    const files = Object.fromEntries(productFiles(home).map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(home, file))).digest('hex')]));
    fs.writeFileSync(path.join(home, '.release-manifest.json'), JSON.stringify({ schema: 'herdr-release/v1', protocol: 1, commit, files, acceptance }, null, 2) + '\n');
    const bundle = checkBundle(home, { verifyFiles: true });
    if (target && !releaseAcceptance(bundle).ready) throw Error('acceptance-invalid: manifest does not retain its READY summary');
  } else if (action === 'install') {
    // Content-address the small router: activation never rewrites an admitted
    // launcher's code, including when rolling current back to a legacy bundle.
    const source = fileURLToPath(new URL('../lib/', import.meta.url));
    const files = ['releases.mjs', 'project.mjs'];
    const key = createHash('sha256').update(files.map(file => fs.readFileSync(path.join(source, file))).join('\n')).digest('hex');
    const directory = path.resolve(home, 'routing', key);
    fs.mkdirSync(directory, { recursive: true });
    for (const file of files) if (!fs.existsSync(path.join(directory, file))) fs.copyFileSync(path.join(source, file), path.join(directory, file));
    for (const [name, entry] of [['org', 'bin/org.mjs'], ['record', 'bin/org.mjs'], ['lane', 'lanes/lane.mjs']]) {
      const launcher = path.join(directory, `${name}.cjs`);
      if (!fs.existsSync(launcher)) fs.writeFileSync(launcher, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(path.join(directory, 'releases.mjs')).href)}).then(m => { process.exitCode = m.runRelease(${JSON.stringify(entry)}, process.argv.slice(2), { home: ${JSON.stringify(path.resolve(home))} }); }).catch(e => { console.error('release: '+e.message); process.exitCode=1; });\n`, { mode: 0o755 });
      const link = path.join(target, name), temporary = `${link}.${randomUUID()}`;
      fs.symlinkSync(launcher, temporary); fs.renameSync(temporary, link);
    }
  } else if (action === 'pin' || action === 'unpin') {
    const project = releaseProject(target);
    if (project.checkout !== project.canonical) throw Error('set release pins from the canonical checkout');
    const release = action === 'pin' ? requireReadyAcceptance(checkRelease(home, rest[0], { verifyFiles: true }), home).id : null;
    const file = path.join(project.canonical, PIN_FILE);
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw Error('pin configuration must be a regular file');
    const temporary = `${file}.${randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify({ release }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
    console.log(`release: ${file} selects ${release ?? 'global current'}; commit this file in the canonical checkout to accept the change`);
  } else if (action === 'attest') {
    if (rest.length !== 1) throw Error('usage: attest HOME TAG SUMMARY');
    const release = checkRelease(home, target, { verifyFiles: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(release.root, '.release-manifest.json'), 'utf8'));
    if (Object.hasOwn(manifest, 'acceptance')) throw Error('acceptance-not-legacy: only protocol-1 bundles without an acceptance record may be attested');
    const acceptance = acceptanceRecord(fs.readFileSync(rest[0]), release.commit);
    const directory = path.resolve(home, 'acceptance'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${release.id}.json`), temporary = `${file}.${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schema: 'herdr-release-acceptance/v1', release: release.id,
        commit: release.commit, acceptance }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
      try { fs.linkSync(temporary, file); } // Atomic, write-once publication; never opens the bundle for writing.
      catch (error) { if (error.code === 'EEXIST') throw Error(`acceptance-already-attested: ${release.id}`); throw error; }
    } finally { fs.rmSync(temporary, { force: true }); }
    console.log(`release: attested ${release.id} READY (${acceptance.summarySha256}) at ${file}`);
  } else if (action === 'pin-status') {
    if (rest.some(arg => arg !== '--json') || rest.length > 1) throw Error('usage: pin-status HOME PROJECT [--json]');
    const status = pinStatus(target, home);
    if (rest.includes('--json')) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`canonical: ${status.project?.canonical ?? 'none'}`);
      const pin = status.committed && Object.hasOwn(status.committed, 'release') ? status.committed.release ?? 'global current' : status.admissionError ? 'invalid' : 'global current';
      console.log(`committed pin: ${pin} at ${status.committed?.commit ?? 'no HEAD'}`);
      if (status.admissionError && status.committed?.bytes !== undefined) console.log(`committed pin bytes: ${JSON.stringify(status.committed.bytes)}`);
      if (status.prepared) console.log(`working-tree pin: ${JSON.stringify(status.prepared.config ?? status.prepared)} (prepared, not accepted)`);
      console.log(`resolved bundle: ${status.resolved?.root ?? 'unavailable'} (manifest commit ${status.resolved?.manifestCommit ?? 'none'})`);
      const acceptance = status.resolved?.acceptance;
      console.log(`acceptance: ${acceptance?.ready ? `READY from ${acceptance.source}; summary sha256 ${acceptance.summarySha256}` : acceptance?.reason ?? 'unavailable'}`);
      if (status.admissionError) console.log(`admission refused: ${status.admissionError}`);
      console.log(`current: ${status.current ?? 'none'}`);
    }
  } else if (action === 'exec') process.exitCode = runRelease(target, rest, { home });
  else if (action === 'run') {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const installedHome = fs.existsSync(path.join(root, '.release-commit')) ? path.dirname(path.dirname(root)) : releaseHome();
    process.exitCode = runRelease(home, target === undefined ? [] : [target, ...rest], { home: installedHome, fallbackRoot: root });
  }
  else throw Error('unknown release tooling command');
} catch (error) { console.error(`release: ${error.message}`); process.exitCode = 1; }
