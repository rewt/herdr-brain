const oneLine = (value, limit = 240) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit);

const quoted = (value) => JSON.stringify(oneLine(value));

export function reportNotice({ run, item, outcome, headline, report, check = 'pass' }) {
  return `[org-report] run=${run} item=${item} outcome=${outcome} headline=${quoted(headline)} check=${check} report=${report}`;
}

export function invalidReportNotice({ run, item, agent, report, error }) {
  return `[watch-invalid-report] run=${run} item=${item} worker=${agent} check=fail report=${report} error=${quoted(error)}`;
}

export function noReportNotice({ run, item, agent, state, report }) {
  return `[watch-no-report] run=${run} item=${item} worker=${agent} state=${state} report=${report} stop=unclassified reset=unknown`;
}

export function blockedNotice({ run, item, agent, report }) {
  return `[watch-blocked] run=${run} item=${item} worker=${agent} state=blocked report=${report}`;
}

export function longRunningNotice({ run, item, agent, minutes }) {
  return `[watch-long-running] run=${run} item=${item} worker=${agent} still-running=${minutes}m`;
}

export function unavailableNotice({ run, item, agent, error }) {
  return `[watch-unavailable] run=${run} item=${item} worker=${agent} error=${quoted(error)}`;
}
