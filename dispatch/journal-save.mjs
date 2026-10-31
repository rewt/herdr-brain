// Only read-only ownership preparation may retry. Once the journal write starts,
// retain its actual outcome; never replay an effect or refresh the saved claim.
export const sourceConflict = error => ['RECORD_GUARD_CONFLICT', 'RECORD_OBSERVATION_CONFLICT'].includes(error.code) ||
  error.message === 'record changed repeatedly while preparing a consistent read; no mutation attempted';

export function saveDispatchJournal({ reserve, write }) {
  for (let attempt = 0; ; attempt++) {
    let writing = false;
    try { return reserve(() => { writing = true; return write(); }); }
    catch (error) {
      if (writing) error.dispatchJournalEffectStarted = true;
      if (writing || attempt >= 31 || !sourceConflict(error)) throw error;
    }
  }
}
