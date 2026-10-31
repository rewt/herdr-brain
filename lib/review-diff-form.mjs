// Describe the existing capture predicate without changing saved target bytes.
export function reviewDiffForm(target) {
  const diff = 'SHA256 of git diff --no-ext-diff --no-textconv BASE HEAD stdout decoded as UTF-8, then JavaScript String.trim(), then encoded as UTF-8 (no final newline).';
  return target?.scope?.ranges || target?.diff_kind === 'producer-ranges/v1'
    ? `Diff SHA256 form: SHA256 of UTF-8 JSON.stringify(scope.ranges), with no indentation or final newline. Each range diff SHA256 form: ${diff}`
    : `Diff SHA256 form: ${diff}`;
}
