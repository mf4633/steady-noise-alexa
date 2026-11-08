#!/usr/bin/env bash
# Deploy Steady Noise to Alexa-hosted (development stage only; does NOT submit).
#
# Before the first run:
#   1. Host audio/white.mp3, pink.mp3, brown.mp3 at an HTTPS URL and set
#      AUDIO_BASE_URL in lambda/src/config.js (or the Lambda environment).
#   2. Publish docs/ (privacy, terms, icons) at the URLs in skill-package/skill.json.
#   3. Developer console > Payments: complete the tax and payment interview,
#      or in-skill purchasing cannot be enabled.
#
# Usage:  bash scripts/deploy.sh

set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "Preflight"
if grep -q "REPLACE-ME" lambda/src/config.js && [ -z "${AUDIO_BASE_URL:-}" ]; then
  echo "AUDIO_BASE_URL is still the placeholder in lambda/src/config.js." >&2; exit 1
fi
BASE=$(node -e "console.log(require('./lambda/src/config').AUDIO_BASE_URL)")
for c in white pink brown; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/$c.mp3")
  [ "$code" = 200 ] || { echo "$BASE/$c.mp3 -> HTTP $code" >&2; exit 1; }
  echo "  $c.mp3 OK"
done

step "Tests"
(cd lambda && npm test)

step "ask deploy (skill manifest, interaction model, ISP product, code)"
ask deploy

SKILL_ID=$(python -c "import json,io;print(json.load(io.open('.ask/ask-states.json',encoding='utf-8'))['profiles']['default']['skillId'])")
echo "Skill ID: $SKILL_ID"

step "In-skill products attached to the skill"
ask smapi get-isp-list-for-skill-id --skill-id "$SKILL_ID" --stage development || true
echo
echo "If that list is empty, ask deploy did not pick up skill-package/isps/."
echo "Create and associate the product by hand:"
echo "  ask smapi create-isp-for-vendor --create-in-skill-product-request file:skill-package/isps/subscription/premium.json"
echo "  ask smapi associate-isp-with-skill --product-id <id from above> --skill-id $SKILL_ID"
echo
echo "Then test in the developer console (Test tab > Development) on a real Echo."
