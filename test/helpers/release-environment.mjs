// Installation tests must never inherit an operator's machine destinations or
// switches. Each fixture supplies its own home, binaries and release controls.
export function releaseEnvironment(parent, owned) {
  const env = Object.fromEntries(Object.entries(parent).filter(([name]) =>
    !/^(HERDR_MONITOR_|RELEASE_|MONITOR_INSTALL_)/u.test(name) && name !== 'HERDR_BIN_PATH'));
  return { ...env, ...owned };
}
