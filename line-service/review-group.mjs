// One immutable producer report is one delivered change, including its
// intermediate/final commits. Legacy captured targets stay immutable.
const commit=value=>/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value??'');
export function producerGroupKey(item,run,reportHash){
  return typeof item==='string'&&typeof run==='string'&&/^[a-f0-9]{64}$/.test(reportHash??'')?`${item}:${run}:${reportHash}`:null;
}
export function queueProducerGroup(item){return item?.meta.review_target?.evidence_kind==='canonical-unattributed/v1'?item.meta.review_target.source_group?.key:producerGroupKey(item?.meta.review_source_item,item?.meta.review_source_run,item?.meta.review_target?.reportHash);}
export function sameProducerQueue(item,source,run){return item?.meta.review_source_item===source&&item.meta.review_source_run===run;}
export function capturedReviewCommits(target){return [...new Set((target?.source_group?.owned_commits??target?.scope?.commits??[target?.head]).filter(commit))];}
export function sameCapturedTarget(actual,expected){
  // Compatibility never retargets a saved request. Old one-commit targets may
  // remain usable only when their actual range/diff/evidence covers the group.
  if(actual?.source_provenance&&JSON.stringify(actual.source_provenance)!==JSON.stringify(expected?.source_provenance))return false;
  for(const k of ['head','base','reportHash','evidence','diff_sha256','dispatch'])if(actual?.[k]!==expected?.[k])return false;
  const a=capturedReviewCommits(actual).sort(),b=capturedReviewCommits(expected).sort();
  return JSON.stringify(a)===JSON.stringify(b)&&JSON.stringify(actual?.scope)===JSON.stringify(expected?.scope)&&
    (!actual.source_group||JSON.stringify(actual.source_group)===JSON.stringify(expected.source_group));
}
