// Installation tests must never inherit an operator's machine destinations or
// switches. Each fixture supplies its own home, binaries and release controls.
export function releaseEnvironment(parent, owned) {
  const env = Object.fromEntries(Object.entries(parent).filter(([name]) =>
    !/^(HERDR_MONITOR_|RELEASE_|MONITOR_INSTALL_)/u.test(name) && name !== 'HERDR_BIN_PATH'));
  // Native lifecycle hooks belong to this fixture's user account too.
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  return { ...env, ...owned };
}
