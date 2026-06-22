#!/usr/bin/env bash
# Register the Universal Paywall sidecar as an Owncast webhook subscriber.
# Verified route: POST /api/admin/webhooks/create (HTTP Basic auth).
# Scaffold: confirm the request body shape against your Owncast version before use.
set -euo pipefail

OWNCAST_URL="${OWNCAST_URL:-http://localhost:8080}"
OWNCAST_ADMIN_USER="${OWNCAST_ADMIN_USER:-admin}"
OWNCAST_ADMIN_PASS="${OWNCAST_ADMIN_PASS:-abc123}"
SIDECAR_WEBHOOK_URL="${SIDECAR_WEBHOOK_URL:-http://up-sidecar:8410/owncast}"

curl -fsS -u "${OWNCAST_ADMIN_USER}:${OWNCAST_ADMIN_PASS}" \
  -H 'content-type: application/json' \
  -X POST "${OWNCAST_URL}/api/admin/webhooks/create" \
  -d "{\"url\":\"${SIDECAR_WEBHOOK_URL}\",\"events\":[\"USER_JOINED\",\"USER_PARTED\"]}"

echo
echo "Registered ${SIDECAR_WEBHOOK_URL} for USER_JOINED / USER_PARTED."
</content>
