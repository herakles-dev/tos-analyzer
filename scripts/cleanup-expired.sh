#!/usr/bin/env bash
# Cleanup expired analyses from FinePrint database
# Usage: ./scripts/cleanup-expired.sh
# Crontab: 0 3 * * 0 ./scripts/cleanup-expired.sh

set -euo pipefail

CONTAINER="${DB_CONTAINER:-$(docker compose ps -q postgres)}"

# Load environment
if [ -f "${ENV_FILE:-.env}" ]; then
  source "${ENV_FILE:-.env}"
fi

echo "[$(date)] Starting expired data cleanup..."

# Delete expired analytics events (related to expired analyses)
ANALYTICS_DELETED=$(docker exec "$CONTAINER" psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-fineprint}" \
  -t -A -c "
    DELETE FROM \"AnalyticsEvent\"
    WHERE \"analysisId\" IN (
      SELECT id FROM \"Analysis\" WHERE \"expiresAt\" < NOW()
    );
    SELECT count(*) FROM (SELECT 1) AS dummy;
  " 2>/dev/null | tail -1)

# Delete expired shares
SHARES_DELETED=$(docker exec "$CONTAINER" psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-fineprint}" \
  -t -A -c "
    DELETE FROM \"Share\"
    WHERE \"analysisId\" IN (
      SELECT id FROM \"Analysis\" WHERE \"expiresAt\" < NOW()
    );
  " 2>/dev/null)

# Delete expired analyses
ANALYSES_DELETED=$(docker exec "$CONTAINER" psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-fineprint}" \
  -t -A -c "
    WITH deleted AS (
      DELETE FROM \"Analysis\" WHERE \"expiresAt\" < NOW() RETURNING id
    )
    SELECT count(*) FROM deleted;
  " 2>/dev/null)

echo "[$(date)] Cleanup complete: ${ANALYSES_DELETED:-0} expired analyses removed"
echo "[$(date)] Related shares and analytics events also cleaned"
