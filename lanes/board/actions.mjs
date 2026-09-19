function identical(left, right) {
  return typeof left === "string" && typeof right === "string" && left === right;
}

export function verifyCanonicalSession(session, { repoId, repoRoot, samePath = identical } = {}) {
  if (session?.repo_id === undefined || session?.repo === undefined) {
    throw new Error("board row is not a canonical registered session; this action is unsupported");
  }
  if (!samePath(session.repo_id, repoId) || !samePath(session.repo, repoRoot)) {
    throw new Error("foreign session metadata does not match this canonical repository");
  }
  return session;
}

export function verifyFocusSelection({
  session,
  snapshot,
  repoId,
  repoRoot,
  checkout,
  samePath = identical,
}) {
  verifyCanonicalSession(session, { repoId, repoRoot, samePath });
  for (const field of ["workspace", "pane", "server"]) {
    if (typeof session[field] !== "string" || session[field] === "") {
      throw new Error(`board row has no verified ${field}; focus is unsupported`);
    }
  }

  const workspace = snapshot?.workspaces?.find(
    (candidate) => candidate.workspace_id === session.workspace,
  );
  const worktree = workspace?.worktree;
  if (worktree === undefined ||
      !samePath(worktree.repo_key, repoId) ||
      !samePath(worktree.repo_root, repoRoot) ||
      !samePath(worktree.checkout_path, checkout) ||
      worktree.is_linked_worktree !== true) {
    throw new Error("foreign board selection: current workspace repository identity does not match");
  }

  const agent = snapshot?.agents?.find((candidate) => candidate.pane_id === session.pane);
  if (agent === undefined) {
    throw new Error("stale board selection: selected agent is no longer live");
  }
  if (agent.workspace_id !== session.workspace || !samePath(agent.cwd, checkout)) {
    throw new Error("stale board selection: selected pane no longer hosts the recorded session");
  }
  const recordedName = typeof session.name === "string" && session.name !== "" ? session.name : null;
  const liveName = typeof agent.name === "string" && agent.name !== "" ? agent.name : null;
  if (recordedName !== liveName) {
    throw new Error(`stale board selection: selected pane now hosts a different agent (${liveName ?? "unnamed"})`);
  }

  return {
    target: liveName ?? session.pane,
    name: liveName,
    pane: session.pane,
    server: session.server,
  };
}
