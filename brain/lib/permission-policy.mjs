// Approvals require a native read tool and resolved, freshly bound project paths.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from '../../lib/project.mjs';
import { readFleet } from '../../lib/fleet.mjs';
import { within, checkedDirectory } from '../../discovery/paths.mjs';

export const DENIAL_NUDGE = 'Do not work around this denial. Record the question with record ask --category security --recommend no --why "Steward declined the permission request" (under your work item), then continue with other work. Only the operator may authorize a later retry.';

export function permissionProject(cwd, env = process.env) {
  const git = gitProject(cwd), fleet = readFleet(env);
  const match = Object.entries(fleet?.projects ?? {}).find(([, p]) => p.identity === git.identity && p.checkout === git.canonical);
  if (!match) throw Error('permission request has no verified fleet project');
  return { ...match[1], name: match[0], workspace: git.checkout, peers: Object.values(fleet.projects).filter(p => p.identity !== git.identity) };
}

export function permissionDecision(event, { kind, project, runTemp } = {}) {
  const deny = (reason, category = 'security', alert = false) => ({ behavior: 'deny', reason, category, alert, message: `${reason}. ${DENIAL_NUDGE.replace('--category security', `--category ${category}`)}` });
  if (!event || event.hook_event_name !== 'PermissionRequest' || typeof event.tool_name !== 'string' || !event.tool_input || typeof event.tool_input !== 'object' || Array.isArray(event.tool_input)) return deny('Malformed permission request');
  const input = event.tool_input;
  if (event.tool_name !== 'Read') {
    const text = `${event.tool_name} ${JSON.stringify(input)}`;
    // Classify the requested action, never a generated description of its safety.
    if (/(?:\.ssh|\.aws|\.env(?:\b|\.)|credentials?|secrets?|api[_ -]?keys?|private[_ -]?keys?|seed[_ -]?phrases?|keychain|wallet)/i.test(text)) return deny('Credentials request', 'security', true);
    if (/\b(?:payto|paytomany|sendrawtransaction|broadcast|signtransaction|sendtransaction|transfer|funds|chipnet|mainnet)\b/i.test(text)) return deny('Funds or chain request', 'funds-and-chain', true);
    if (/\b(?:publish|deploy|release|push)\b/i.test(text)) return deny('Publishing request', 'publish', true);
    if (/\b(?:chmod|chown|sudo|trust|bypass|unsandboxed)\b|request_permissions|allowUnsandboxedCommands|dangerously|permissions\.(?:allow|defaultMode)|hooks\.json|config\.toml/i.test(text)) return deny('Permission expansion request', 'security', true);
  }
  if (!project) return deny('No verified project');
  // Codex's Bash/apply_patch/MCP requests have no proven native file-read class.
  if (kind !== 'claude' || event.tool_name !== 'Read') return deny('Only a native file read can be approved');
  if (Object.keys(input).some(key => !['file_path', 'offset', 'limit', 'pages'].includes(key)) || typeof input.file_path !== 'string' || !input.file_path || /[\x00-\x1f]/.test(input.file_path)) return deny('Unrecognized read input');
  try {
    const cwd = fs.realpathSync(event.cwd);
    if (gitProject(cwd).identity !== project.identity) return deny('Request cwd belongs to another project');
    const file = fs.realpathSync(path.resolve(cwd, input.file_path));
    if (!fs.statSync(file).isFile()) return deny('Read target is not a regular file');
    // Classify the resolved destination too: a harmless-looking symlink must
    // never conceal a key/credential file inside the project.
    if (/(?:^|\/)(?:\.ssh|\.aws|\.env(?:\.|$)|credentials?|secrets?|wallets?)(?:\/|\.|$)|(?:private[_-]?key|api[_-]?key|seed[_-]?phrases?|keychain)/i.test(file)) return deny('Credentials target', 'security', true);
    for (const peer of project.peers ?? []) for (const root of [peer.checkout, peer.record, peer.worktrees, peer.temp]) {
      if (fs.existsSync(root) && within(fs.realpathSync(root), file)) return deny('Read target belongs to another fleet project');
    }
    const roots = [project.checkout, project.workspace, project.worktrees, project.record, runTemp].filter(Boolean).map(checkedDirectory);
    if (!roots.some(root => within(root, file))) return deny('Read target resolves outside the project');
    return { behavior: 'allow', reason: 'Native read inside the verified project', category: 'security', alert: false, file };
  } catch { return deny('Read target or project could not be resolved'); }
}

export const permissionOutput = decision => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
  behavior: decision.behavior, ...(decision.behavior === 'deny' ? { message: decision.message } : {}),
} } });
