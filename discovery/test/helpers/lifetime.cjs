// Offline stand-ins still execute the real lifetime bootstrap under a kernel
// marker. They never stand in for filesystem/network denial assertions.
const {spawnSync}=require('node:child_process');
module.exports=function(argv, command=null) {
  const enter=argv.indexOf('--enter');
  if(process.platform==='darwin' && enter>=1) {
    const owner=argv[enter-1], allowed=argv[enter+1], denied=argv[enter+2];
    const args=command??argv.slice(enter+3);
    const profile=`(version 1)(allow default)(deny file-read* (literal ${JSON.stringify(denied)}))`;
    return spawnSync('/usr/bin/sandbox-exec',['-p',profile,owner,'--enter',allowed,denied,...args],{stdio:['inherit','inherit','inherit',3],timeout:10000}).status??1;
  }
  if(command) return spawnSync(command[0],command.slice(1),{stdio:'inherit',timeout:10000}).status??1;
  const split=argv.indexOf('--');
  return spawnSync(argv[split+1],argv.slice(split+2),{stdio:'inherit',timeout:10000}).status??1;
};
