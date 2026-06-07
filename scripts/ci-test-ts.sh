#!/usr/bin/env bash
set -euo pipefail

export GITHUB_ACTIONS=0

packages=(
  packages/system-context-reminder-plugin
  packages/hashline
  packages/natives
  packages/utils
  packages/ai
  packages/tui
  packages/agent
  packages/mnemopi
  packages/context-gc-plugin
  packages/coding-agent
  packages/typescript-edit-benchmark
)

for pkg in "${packages[@]}"; do
  echo "[test:ts] $pkg"
  bun --cwd="$pkg" run test
done
