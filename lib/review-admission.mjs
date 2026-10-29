// Project-local selection only; immutable target/native guards still own effects.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const commit=v=>typeof v==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v);
const group=v=>typeof v==='string'&&/^(?:[A-Z]+-[1-9]\d*:R-[1-9]\d*|supplemental-review\/v1):[a-f0-9]{64}$/.test(v);

export function validateReviewAdmission(policy){
  const check=(ok,message)=>{if(!ok)throw Error(`review_admission ${message}`);};
  check(object(policy),'must be an object');
  for(const key of Object.keys(policy))check(['enabled','producer_groups','canonical_commits','hold_ordinary'].includes(key),`unknown field: ${key}`);
  check(typeof policy.enabled==='boolean','enabled must be boolean');
  if(policy.hold_ordinary!==undefined)check(typeof policy.hold_ordinary==='boolean','hold_ordinary must be boolean');
  for(const [key,valid]of [['producer_groups',group],['canonical_commits',commit]]){
    const values=policy[key];
    check(values===undefined&&!policy.enabled||Array.isArray(values)&&values.every(valid)&&new Set(values).size===values.length,`${key} must contain distinct exact ${key==='producer_groups'?'producer group keys':'full commit IDs'} (required when enabled)`);
  }
  return policy;
}

export function reviewAdmissionHold(policy,{kind,selector}={}){
  if(!policy?.enabled)return null;
  if(kind==='ordinary')return policy.hold_ordinary?{code:'REVIEW_ADMISSION_ORDINARY_HELD',reason:'Ordinary selection is held by the project review admission policy.'}:null;
  if(kind==='producer'&&policy.producer_groups.includes(selector)||kind==='canonical'&&policy.canonical_commits.includes(selector))return null;
  return {code:kind==='producer'?'REVIEW_ADMISSION_PRODUCER_NOT_ALLOWED':kind==='canonical'?'REVIEW_ADMISSION_CANONICAL_NOT_ALLOWED':'REVIEW_ADMISSION_BINDING_UNKNOWN',
    reason:kind==='producer'?'Producer group is outside the project review allowlist.':kind==='canonical'?'Canonical commit is outside the project review allowlist.':'Review has no exact producer group or canonical binding; retain it pending.'};
}
