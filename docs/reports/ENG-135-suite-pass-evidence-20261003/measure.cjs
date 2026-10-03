const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const log=process.env.SUITE_MEASURE_LOG,root=process.env.SUITE_MEASURE_ROOT;
if(log&&root){
 let file=process.env.SUITE_MEASURE_FILE||null;
 const entry=process.argv[1]&&path.resolve(process.argv[1]);
 if(!file&&entry&&entry.startsWith(root+'/')&&(entry.endsWith('.test.mjs')||entry.includes('/fixtures/')))file=path.relative(root,entry);
 const write=row=>fs.appendFileSync(log,JSON.stringify({at:Date.now(),pid:process.pid,file,...row})+'\n');
 if(file&&entry===path.join(root,file)){write({kind:'file-start'});process.once('exit',code=>write({kind:'file-end',code}));}
 const env=options=>({...options,env:{...(options?.env||process.env),SUITE_MEASURE_LOG:log,SUITE_MEASURE_ROOT:root,...(file?{SUITE_MEASURE_FILE:file}:{})}});
 for(const name of ['spawnSync','execFileSync','execSync']){
  const original=cp[name];cp[name]=function(...args){
   const index=name==='execSync'?1:Array.isArray(args[1])?2:1;args[index]=env(args[index]);
   const start=Date.now();let result;
   try{result=original.apply(this,args);return result;}finally{write({kind:'spawn',api:name,command:args[0],args:Array.isArray(args[1])?args[1]:[],cwd:args[index]?.cwd||process.cwd(),child:result?.pid||null,wallMs:Date.now()-start});}
  };
 }
 const original=cp.ChildProcess.prototype.spawn;
 cp.ChildProcess.prototype.spawn=function(options){
  const pairs=Object.fromEntries(options.envPairs.map(pair=>{const i=pair.indexOf('=');return [pair.slice(0,i),pair.slice(i+1)];}));
  options.envPairs=Object.entries(env({env:pairs}).env).map(([k,v])=>k+'='+v);
  const result=original.call(this,options);write({kind:'spawn',api:'spawn',command:options.file,args:options.args.slice(1),cwd:options.cwd||process.cwd(),child:this.pid||null});return result;
 };
 require('node:module').syncBuiltinESMExports();
}
