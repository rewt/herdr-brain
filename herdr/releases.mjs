// Local release tooling; never alters native permissions or harness settings.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishConsumerOffer } from '../lib/consumer-offer.mjs';
import { cliHelp } from '../lib/cli-help.mjs';
import { productFiles, createProductCheckout, captureProductCheckout, verifyProductCheckoutIsolation, verifyProductPayload, payloadEntry, payloadDigest, releaseMetadata } from '../lib/product-files.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { durableWrite } from '../lib/durable-json.mjs';
import { PIN_FILE, acceptanceRecord, checkBundle, checkRelease, releaseAcceptance, requireReadyAcceptance,
  releaseProject, releaseHome, runRelease, pinStatus } from '../lib/releases.mjs';
import { requireHomeRelease } from '../lib/releases.mjs';
import { homeProject, policyLocation } from '../lib/config-home.mjs';
import { writeAuditedConfig } from '../lib/config-audit.mjs';
import { withConfigLock } from '../lib/config-command.mjs';
import { validatePolicy } from '../lib/config-policy.mjs';
cliHelp(import.meta.url, 'Usage: node herdr/releases.mjs manifest ROOT [SUMMARY] | install HOME BIN | pin HOME PROJECT TAG | unpin HOME PROJECT | attest HOME TAG SUMMARY | pin-status HOME PROJECT [--json] | exec HOME ENTRY [ARGS...] | run ENTRY [ARGS...]');

const [action, home, target, ...rest] = process.argv.slice(2);
function requireExecRuntime() {
  const root=fileURLToPath(new URL('../',import.meta.url)),version=readPlainFile(path.join(root,'.nvmrc')).trim();
  if(process.version!==`v${version}`)throw Error(`release exec requires Node ${version}; running ${process.version} at ${process.execPath}; prepend the pinned Node directory to PATH before invoking release.sh`);
}
try {
  if (action === 'freeze-validation') {
    const { freezeReleaseValidation } = await import('./validation-admission.mjs');
    freezeReleaseValidation(home, target, rest[0], process.env, { commit: rest[1], mode: rest[2] });
  } else if (action === 'checkout') {
    const identity = createProductCheckout({ source: home, commit: target, destination: rest[0], ownedRoot: path.dirname(rest[1]) });
    const frozen = readPlainFile(rest[2]);
    if (JSON.parse(frozen).payloadCommit !== target) throw Error('frozen payload commit mismatch');
    durableWrite(rest[1], { identity, frozenFile: rest[2], frozenSha256: payloadDigest(frozen) });
    console.log(payloadDigest(readPlainFile(rest[1])));
  } else if (action === 'verify-live-summary') {
    const bytes = readPlainFile(home), summary = JSON.parse(bytes);
    if (summary.liveCoverage?.sha256 !== payloadDigest(readPlainFile(target))) throw Error('live continuation input was not consumed');
    console.log(JSON.stringify(acceptanceRecord(bytes, rest[0])));
  } else if (action === 'coverage') {
    const bytes = readPlainFile(target);
    if (payloadDigest(bytes) !== rest[0]) throw Error('captured identity record changed');
    const record = JSON.parse(bytes), frozen = readPlainFile(record.frozenFile);
    if (payloadDigest(frozen) !== record.frozenSha256) throw Error('frozen declaration changed');
    const { verifyReleaseCoverage } = await import('./validation-admission.mjs');
    await verifyReleaseCoverage(home, { identity: record.identity, frozen: JSON.parse(frozen), canonical: JSON.parse(frozen).canonical });
    fs.copyFileSync(home, path.join(path.dirname(target), 'coverage.json'), fs.constants.COPYFILE_EXCL);
  } else if (action === 'verify-package') {
    const bytes = readPlainFile(target);
    if (payloadDigest(bytes) !== rest[0]) throw Error('captured identity record changed');
    const record = JSON.parse(bytes), { identity } = record, frozen = readPlainFile(record.frozenFile);
    if (payloadDigest(frozen) !== record.frozenSha256 || JSON.stringify(verifyProductCheckoutIsolation(captureProductCheckout(identity.root, identity.commit, { all: true }))) !== JSON.stringify(identity)) throw Error('validated source or declaration changed');
    const coverageFile = path.join(path.dirname(target), 'coverage.json');
    let completed;
    if (JSON.parse(frozen).releaseMode === 'routine') {
      if (fs.existsSync(coverageFile) || fs.existsSync(path.join(path.dirname(target), 'execution.json'))) throw Error('routine release cannot claim full execution or coverage');
      completed = { routine: { fullCoverage: 'UNRUN' } };
    } else if (fs.existsSync(coverageFile)) {
      const { verifyReleaseCoverage } = await import('./validation-admission.mjs');
      completed = { coverage: await verifyReleaseCoverage(coverageFile, { identity, frozen: JSON.parse(frozen), canonical: JSON.parse(frozen).canonical }) };
    } else {
      const execution = JSON.parse(readPlainFile(path.join(path.dirname(target), 'execution.json'))), receipt = readPlainFile(execution.receipt);
      const result = JSON.parse(receipt);
      if (execution.cwd !== identity.root || execution.commit !== identity.commit || payloadDigest(receipt) !== execution.sha256 || result.exit_code !== 0 || result.signal || result.gate_timeout || result.attempts !== 1) throw Error('release execution is not successful');
      completed = { execution: { ...execution, exit_code: result.exit_code, attempts: result.attempts } };
    }
    const inventorySha256 = verifyProductPayload(home, identity, { metadata: releaseMetadata, readOnly: rest[1] === '--read-only' });
    console.log(JSON.stringify({ ...JSON.parse(frozen), validation: { cwd: identity.root, common: identity.common, commit: identity.commit, tree: identity.tree,
      inventorySha256, runtimeSha256: payloadDigest(JSON.stringify(Object.fromEntries(identity.runtime.map(file => [file, identity.files[file]])))),
      ...completed } }));
  } else if (action === 'verify-bundle') {
    checkBundle(home, { verifyFiles: true });
  } else if (action === 'manifest') {
    const commit = fs.readFileSync(path.join(home, '.release-commit'), 'utf8').trim();
    const validationFile = path.join(home, '.release-validation.json');
    const frozen = fs.existsSync(validationFile) ? JSON.parse(readPlainFile(validationFile)) : null;
    const release = frozen ? { kind: frozen.releaseMode === 'routine' ? 'routine' : 'stable',
      fullCoverage: frozen.releaseMode === 'routine' ? 'UNRUN' : 'PASS' } : undefined;
    if (release?.kind === 'routine' && target) throw Error('routine release cannot claim live acceptance or stable adoption');
    let acceptance = { ran: false, ready: false };
    if (target) {
      const bytes = fs.readFileSync(target);
      acceptance = acceptanceRecord(bytes, commit);
      fs.writeFileSync(path.join(home, '.release-acceptance.json'), bytes);
    }
    const inventory = [...productFiles(home), ...(fs.existsSync(path.join(home, '.release-validation.json')) ? ['.release-validation.json'] : [])];
    const entries = inventory.map(file => [file, payloadEntry(path.resolve(home), file)]);
    const files = Object.fromEntries(entries.map(([file, entry]) => [file, entry.sha256])), modes = Object.fromEntries(entries.map(([file, entry]) => [file, entry.mode]));
    // The shared home-aware policy reader was introduced with config-home.
    // Only the archived payload can claim it; newer tooling also builds legacy tags.
    const capability = Object.hasOwn(files, 'lib/config-policy.mjs') ? { config_home: 1 } : {};
    fs.writeFileSync(path.join(home, '.release-manifest.json'), JSON.stringify({ schema: 'herdr-release/v1', protocol: 1, ...capability, commit, files, modes, acceptance,
      ...(release ? { release } : {}) }, null, 2) + '\n');
    const bundle = checkBundle(home, { verifyFiles: true });
    if (target) acceptanceRecord(readPlainFile(path.join(bundle.root, '.release-acceptance.json')), commit);
  } else if (action === 'offer') {
    if (rest.length !== 2) throw Error('usage: offer HOME TAG EVIDENCE CANONICAL');
    const release = checkRelease(home, target, { verifyFiles: true });
    const project = releaseProject(rest[1]), validation = path.join(release.root, '.release-validation.json');
    if (fs.existsSync(validation) && JSON.parse(readPlainFile(validation)).common !== project.identity) throw Error('consumer offer source project mismatch');
    console.log(`release: consumer offer retained at ${publishConsumerOffer({ release, home: fs.realpathSync(home), file: rest[0], canonical: project.canonical })}; each consumer project decides activation`);
  } else if (action === 'install') {
    // Content-address the small router: activation never rewrites an admitted
    // launcher's code, including when rolling current back to a legacy bundle.
    const source = fileURLToPath(new URL('../', import.meta.url));
    // Keep the resolver's complete dependency closure immutable, including its
    // owning-record audit seam. A mutable current bundle cannot supply imports.
    const files = productFiles(source);
    const key = createHash('sha256').update(files.map(file => file + '\0' + fs.readFileSync(path.join(source, file))).join('\n')).digest('hex');
    const directory = path.resolve(home, 'routing', key);
    fs.mkdirSync(directory, { recursive: true });
    for (const file of files) if (!fs.existsSync(path.join(directory, file))) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.copyFileSync(path.join(source, file), path.join(directory, file)); }
    for (const [name, entry] of [['org', 'bin/org.mjs'], ['record', 'bin/org.mjs'], ['lane', 'lanes/lane.mjs']]) {
      const launcher = path.join(directory, `${name}.cjs`);
      if (!fs.existsSync(launcher)) fs.writeFileSync(launcher, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(path.join(directory, 'lib/releases.mjs')).href)}).then(m => { process.exitCode = m.runRelease(${JSON.stringify(entry)}, process.argv.slice(2), { home: ${JSON.stringify(path.resolve(home))} }); }).catch(e => { console.error('release: '+e.message); process.exitCode=1; });\n`, { mode: 0o755 });
      const link = path.join(target, name), temporary = `${link}.${randomUUID()}`;
      fs.symlinkSync(launcher, temporary); fs.renameSync(temporary, link);
    }
  } else if (action === 'pin' || action === 'unpin') {
    const project = releaseProject(target);
    if (project.checkout !== project.canonical) throw Error('set release pins from the canonical checkout');
    const release = action === 'pin' ? requireReadyAcceptance(checkRelease(home, rest[0], { verifyFiles: true }), home).id : null;
    const binding = homeProject(target);
    if (binding) {
      requireHomeRelease(release, binding, home);
      const file = policyLocation(target, 'pin', process.env, { write: true }).file;
      withConfigLock(binding, 'project', () => writeAuditedConfig({ file, value: { release }, kind: 'pin', binding, cwd: target,
        validate: value => validatePolicy('pin', value, file) }));
      console.log(`release: ${file} selects ${release ?? 'global current'}`);
      console.error(`Warning: repo-reading project scripts will not see this change; they still read ${binding.sources.pin.path}.`);
    } else {
    const file = path.join(project.canonical, PIN_FILE);
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw Error('pin configuration must be a regular file');
    const temporary = `${file}.${randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify({ release }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
    console.log(`release: ${file} selects ${release ?? 'global current'}; commit this file in the canonical checkout to accept the change`);
    }
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
  } else if (action === 'exec') {
    requireExecRuntime();
    process.exitCode = runRelease(target, rest, { home });
  }
  else if (action === 'run') {
    requireExecRuntime();
    const root = fileURLToPath(new URL('../', import.meta.url));
    const installedHome = fs.existsSync(path.join(root, '.release-commit')) ? path.dirname(path.dirname(root)) : releaseHome();
    process.exitCode = runRelease(home, target === undefined ? [] : [target, ...rest], { home: installedHome, fallbackRoot: root });
  }
  else throw Error('unknown release tooling command');
} catch (error) { console.error(`release: ${error.message}`); process.exitCode = 1; }
