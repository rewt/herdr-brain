#!/usr/bin/env bash
# Dependency-free release build check. Activation manages only CLI launchers.
set -euo pipefail
command -v node >/dev/null || { echo "install: put Node.js 20+ on PATH" >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'
