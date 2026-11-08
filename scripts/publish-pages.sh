#!/usr/bin/env bash
# Create the public repo, push, and serve docs/ (site + audio) on GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")/.."
gh repo create mf4633/steady-noise-alexa --public \
  --description "Steady Noise: white, pink, and brown noise for Alexa" --source . --push
gh api -X POST repos/mf4633/steady-noise-alexa/pages \
  -f "source[branch]=master" -f "source[path]=/docs" >/dev/null
echo "Pages enabled. First build takes 1-3 minutes:"
echo "  https://mf4633.github.io/steady-noise-alexa/"
