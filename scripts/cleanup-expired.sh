#!/usr/bin/env bash
# Cleanup expired private analyses from FinePrint database.
# Public (library) analyses are NEVER deleted regardless of expires_at.
# Usage: ./scripts/cleanup-expired.sh
# Crontab: 0 3 * * 0 ./scripts/cleanup-expired.sh

set -euo pipefail

CONTAINER="${DB_CONTAINER:-$(docker compose ps -q postgres)}"

# Load environment
if [ -f "${ENV_FILE:-.env}" ]; then
  source "${ENV_FILE:-.env}"
fi

PSQL_USER="${POSTGRES_USER:-postgres}"
PSQL_DB="${POSTGRES_DB:-fineprint}"

echo "[$(date)] Starting expired data cleanup (public analyses excluded)..."

# Delete analytics events tied to expired *private* analyses
docker exec "$CONTAINER" psql -U "$PSQL_USER" -d "$PSQL_DB" -c "
  DELETE FROM analytics_events
  WHERE analysis_id IN (
    SELECT id FROM analyses
    WHERE expires_at < NOW() AND is_public = false
  );
"

# Delete shares tied to expired *private* analyses
docker exec "$CONTAINER" psql -U "$PSQL_USER" -d "$PSQL_DB" -c "
  DELETE FROM shares
  WHERE analysis_id IN (
    SELECT id FROM analyses
    WHERE expires_at < NOW() AND is_public = false
  );
"

# Delete the expired private analyses themselves
ANALYSES_DELETED=$(docker exec "$CONTAINER" psql -U "$PSQL_USER" -d "$PSQL_DB" -t -A -c "
  WITH deleted AS (
    DELETE FROM analyses
    WHERE expires_at < NOW() AND is_public = false
    RETURNING id
  )
  SELECT count(*) FROM deleted;
")

echo "[$(date)] Cleanup complete: ${ANALYSES_DELETED:-0} expired private analyses removed"
echo "[$(date)] Public library analyses preserved"
