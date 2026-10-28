// Complete, scratch-owned identities for native notice recipients. Supervisors
// need not have a worker run; worker fixtures must use their recorded tuple.
export function recipientAgent(name, cwd, overrides = {}) {
  return {
    name, agent: 'claude', agent_status: 'idle',
    pane_id: `fake:${name}`, workspace_id: `fake:${name}:workspace`, cwd,
    terminal_id: `${cwd}:${name}:terminal`,
    agent_session: { value: `${cwd}:${name}:session` },
    ...overrides,
  };
}
