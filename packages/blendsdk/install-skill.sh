#!/usr/bin/env bash
#
# Install or update the BlendSDK Agent Skill.
#
# Usage:
#   curl -fsSL https://cdn.jsdelivr.net/npm/blendsdk@latest/install-skill.sh | bash
#   curl -fsSL https://cdn.jsdelivr.net/npm/blendsdk@latest/install-skill.sh | bash -s -- --target ~/.claude/skills
#
# This script is a thin wrapper around `npx blendsdk skill install`. When a
# terminal is available it reattaches stdin so the interactive selection works
# even though the script itself is piped; otherwise it installs into every
# detected client.

set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx is required. Install Node.js (>= 22) and try again." >&2
  exit 1
fi

if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  exec npx -y blendsdk@latest skill install "$@" </dev/tty
fi

exec npx -y blendsdk@latest skill install --all "$@"
