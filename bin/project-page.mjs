#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { collectProjectPage, writeProjectPage } from '../lib/project-page.mjs';

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, usage: 'node bin/project-page.mjs --out NEW_DIRECTORY [--stage ITEM_ID ...]',
    options: { out: { type: 'string' }, stage: { type: 'string', multiple: true, default: [] } }, allowPositionals: false });
  if (!values.out || values.stage.some(ref => !/^[A-Z][A-Z0-9]*-\d+$/.test(ref))) throw Error('--out NEW_DIRECTORY and stable stage item IDs are required');
  const project = gitProject();
  const discovered = findOrgDir({ env: { ...process.env, ORG_DIR: '' } });
  const org = findOrgDir();
  if (!org || !discovered || fs.realpathSync(org) !== fs.realpathSync(discovered)) throw Error('owning record is missing or foreign; no page written');
  const doc = collectProjectPage({ org: fs.realpathSync(org), project, stageRoots: values.stage });
  const result = writeProjectPage(path.resolve(values.out), doc);
  console.log(JSON.stringify(result));
  return ['current at captured cutoff', 'incomplete'].includes(doc.record.status) ? 0 : 1;
}
if (isMain(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`project-page: ${error.message}`); process.exitCode = 1; }
}
