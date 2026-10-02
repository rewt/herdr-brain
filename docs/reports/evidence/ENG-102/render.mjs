import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd(), scratch = path.join(root, '.lane/phase4-evidence'), out = path.join(root, 'docs/reports/evidence/ENG-102');
fs.mkdirSync(scratch, { recursive: true }); fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, ORG_ACTOR: 'phase4-evidence', HERDR_ENV: '1', HERDR_BIN_PATH: path.join(scratch, 'herdr') };
fs.writeFileSync(env.HERDR_BIN_PATH, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{agents:[],workspaces:[],tabs:[],panes:[]}}));\n`, {mode:0o755});
const fixture = '/private/tmp/herdr-eng102-r116-fixture';
if (!fs.existsSync(fixture)) {
 fs.mkdirSync(fixture);
 const git = args => execFileSync('git',args,{cwd:fixture});
 git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.test']);
 fs.writeFileSync(path.join(fixture,'README.md'),'Fresh project\n');git(['add','.']);git(['commit','-qm','Fresh project']);
 const org = args => execFileSync(process.execPath,[path.join(root,'bin/org.mjs'),...args],{cwd:fixture,env:{...env,ORG_DIR:path.join(fixture,'.org')},encoding:'utf8'}).trim();
 org(['init']);const goal=org(['add','Make continuity useful','--goal']);org(['note',goal,'Keep the implementation dependency-free.','--decision']);org(['ask','Publish the pilot?','--parent',goal,'--category=publish','--recommend=yes','--why=The operator owns publication.','--wait']);
}
const phase=process.argv[2] ?? 'after';
if (!['before', 'after'].includes(phase)) throw new Error('Use before (intake code only) or after.');
for (const [name,cwd,org] of [['record',root,'/Users/rewt/development/rewt/.org'],['fixture',fixture,path.join(fixture,'.org')]]) {
 const config=path.join(scratch,`${name}.json`);fs.writeFileSync(config,JSON.stringify({projects:[{name:name==='record'?'herdr-brain':'Fresh project',cwd,org}]}));
 const screens={control:'c',routes:'u',desks:'S',help:'?'};
 if(phase==='after') Object.assign(screens,{
  'desk-edit':'S\\n', 'desk-review':'S\\nreview-codex\\n',
  'route-add':'ukkkkk\\n', 'route-add-review':'ukkkkk\\nnew-route\\topaque-tool\\topaque-model\\tmore\\n',
  'pool-edit':'ukkkk\\n', 'pool-review':'ukkkk\\n\\n',
  'defaults-edit':'ukkk\\n', 'defaults-review':'ukkk\\n\\n',
  'task-edit':'ukk\\n', 'task-review':'ukk\\nwriting\\t\\twriter\\n',
  'arguments-edit':'uk\\n', 'arguments-review':'uk\\nopaque-tool\\t\\n'
 });
 for (const [screen,keys] of Object.entries(screens)) for (const size of ['80x30','100x40','140x48']) {
 const printed=execFileSync(process.execPath,[path.join(root,'console/app.mjs'),'--modern','--config',config,'--print',size,'--keys',keys],{cwd,env,encoding:'utf8',timeout:20000});
 fs.writeFileSync(path.join(out,`${phase}-${name}-${screen}-${size}.txt`),printed);
 }
}
