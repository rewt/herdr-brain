// Reload under the one journal lock. Preserve object identities held by the
// suspended effect, including its entry, while inheriting other passes' writes.
export function refreshJournal(target,source){
  for(const key of Object.keys(target))if(!Object.hasOwn(source,key))delete target[key];
  for(const [key,value]of Object.entries(source)){
    if(value&&typeof value==='object'&&!Array.isArray(value)&&target[key]&&typeof target[key]==='object'&&!Array.isArray(target[key]))refreshJournal(target[key],value);
    else target[key]=value;
  }
}
export function effectSubject(key,state){
  const id=key.split(':').find(part=>/^[A-Z]+-\d+$/.test(part));
  return state?.runs.get(id)?.item??id??key;
}
