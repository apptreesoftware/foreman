#!/bin/zsh
# Installed by tools/foreman/README.md. __REPO__ is replaced by sed at install time.
set -euo pipefail
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX ANTHROPIC_FOUNDRY_API_KEY ANTHROPIC_AWS_API_KEY
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -f "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 22 >/dev/null; fi
mkdir -p "$HOME/.tone_tonic/logs"
cd "__REPO__"
git pull --ff-only origin main || true
exec pnpm --filter @tone/foreman start
