import fs from 'node:fs';import os from 'node:os';import {spawn} from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
const label=process.argv[2],tiers=process.argv.slice(3),root=process.cwd();
const evidence=path.join(root,'docs/reports/ENG-135-suite-pass-evidence-20261003');
const results=[];
for(const tier of tiers){
 const metrics=path.join(evidence,`${label}-${tier}.jsonl`),log=path.join(evidence,`${label}-${tier}.log`);fs.writeFileSync(metrics,'');
 const fd=fs.openSync(log,'w'),started=Date.now(),load=os.loadavg();
 const child=spawn('npm',['run',`test:${tier}`],{stdio:['ignore',fd,fd],env:{...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --require=${JSON.stringify(fileURLToPath(new URL('./measure.cjs',import.meta.url)))}`,SUITE_MEASURE_LOG:metrics,SUITE_MEASURE_ROOT:root}});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});fs.closeSync(fd);
 const result={tier,started:new Date(started).toISOString(),wallMs:Date.now()-started,loadBefore:load,loadAfter:os.loadavg(),code};results.push(result);console.log(JSON.stringify(result));
 fs.writeFileSync(path.join(evidence,`${label}-tiers.json`),JSON.stringify({node:process.version,cpus:os.availableParallelism(),results},null,2)+'\n');
}
