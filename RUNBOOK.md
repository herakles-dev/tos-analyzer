# FinePrint Operations Runbook

> One-page on-call reference for **fine-print.org** (port 8101). For setup details see [README.md](README.md) and [CLAUDE.md](CLAUDE.md).

## Quick orientation

| Thing | Value |
|---|---|
| Live URL | https://fine-print.org |
| Container | `tos-analyzer-tos-analyzer-1` (port 8101 → 127.0.0.1) |
| Stack | Next.js 14 → Postgres 15 + Redis 7 (Docker compose) |
| Reverse proxy | nginx — `/etc/nginx/sites-available/fine-print-org.conf` |
| Health | `curl https://fine-print.org/api/health` (returns `{ok, status, checks}`) |
| Logs | `docker compose logs -f tos-analyzer` (capped 10m × 3 files) |
| Working dir for ops | `cd /home/hercules/tos-analyzer && source ~/.secrets/hercules.env` |

## Top incidents

### 1. App down / 5xx at fine-print.org

```bash
docker compose ps                                  # is the container healthy?
docker compose logs --tail=200 tos-analyzer        # last errors
curl -s http://localhost:8101/api/health | jq      # which check failed?
docker stats --no-stream tos-analyzer-tos-analyzer-1   # OOM near 1g limit?
```

- If `database: false` → see #3.
- If `redis: false` → see #2.
- If `gemini: false` → see #4.
- If unhealthy with no clear cause → `docker compose restart tos-analyzer` and watch logs.

### 2. Redis down or slow

```bash
docker compose logs --tail=100 redis
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" PING       # expect PONG
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" INFO memory | head -20
```

- App fails *closed* on budget reservation when Redis is down (analyses reject) but fails *open* on content lock. Either restart Redis or accept temporary outage.
- Recovery: `docker compose restart redis`. AOF on `redis_data` volume preserves state.

### 3. DB connection storm / Postgres pegged

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT pid, query_start, state, left(query,80) FROM pg_stat_activity
      WHERE state = 'active' ORDER BY query_start;"
```

- Kill a stuck query: `SELECT pg_cancel_backend(<pid>);` then `pg_terminate_backend(<pid>);` if needed.
- App restart drains its connection pool: `docker compose restart tos-analyzer`.

### 4. Gemini quota / API errors

- Symptom: 502/500 from `/api/analyze`, app log shows `Gemini API error` or token-budget rejection.
- Check daily token spend: `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" GET budget:tokens:$(date +%Y-%m-%d)`
- Default ceiling is `DAILY_TOKEN_BUDGET=5000000`. Raise temporarily by editing `.env` and `docker compose up -d` (no rebuild needed).
- Per-minute global cap: `MINUTE_TOKEN_BUDGET` (default 1M). Tune the same way.
- If Google-side outage, no recovery available; the health check will report `gemini: false` and Cloudflare/users see 503 from the app.

### 5. Certificate expiry

- Cert path: `/etc/letsencrypt/live/fine-print.org/`. Renews via system certbot timer.
- Check: `sudo certbot certificates | grep -A2 fine-print`
- Force renew: `sudo certbot renew --cert-name fine-print.org && sudo systemctl reload nginx`

### 6. Disk fill

- Container logs are capped (`max-size: 10m, max-file: 3` in `docker-compose.yml`).
- Postgres volume growth: `du -sh /var/lib/docker/volumes/tos-analyzer_postgres_data`. Run `./scripts/cleanup-expired.sh` to purge expired private analyses (already weekly cron).
- Backups directory: `./backups/` retains 30 days; older auto-deleted by `backup-db.sh`.
- Host-wide cleanup: `~/scripts/cron-disk-prune.sh` runs Sunday 04:15.

## Restoring from backup

### Logical pg_dump (preferred for table-level mistakes)

```bash
cd /home/hercules/tos-analyzer
LATEST=$(ls -t backups/tos-analyzer_*.sql.gz | head -1)
gunzip -c "$LATEST" | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

### Volume restore via restic (full disaster recovery)

```bash
~/scripts/restic/restic-restore.sh tos-analyzer_postgres_data /tmp/restore-target
docker compose down
sudo rsync -a --delete /tmp/restore-target/ /var/lib/docker/volumes/tos-analyzer_postgres_data/
docker compose up -d
```

See `~/scripts/restic/DISASTER_RECOVERY.md` for full runbook.

## Deployments and rollback

### Deploy

```bash
cd /home/hercules/tos-analyzer
source ~/.secrets/hercules.env
git pull
docker tag tos-analyzer-tos-analyzer:latest tos-analyzer-tos-analyzer:previous   # snapshot for rollback
docker compose up -d --build
docker compose logs -f --tail=50 tos-analyzer
```

### Migrations

The Dockerfile does NOT run `prisma migrate deploy` automatically. After pulling a commit that adds a migration:

```bash
docker compose exec tos-analyzer npx prisma migrate deploy
docker compose restart tos-analyzer
```

### Rollback

```bash
docker tag tos-analyzer-tos-analyzer:previous tos-analyzer-tos-analyzer:latest
docker compose up -d   # no --build; uses tagged image
```

If a migration was the culprit, revert it with a manual SQL fix-forward — Prisma does not have automatic down migrations.

## Scheduled jobs

| When | Job | Effect |
|---|---|---|
| `0 2 * * *` | `./scripts/backup-db.sh` | gzipped pg_dump → `./backups/`, 30-day retention |
| `0 3 * * 0` | `./scripts/cleanup-expired.sh` | DELETE expired private analyses (public preserved) |
| `0 3 * * *` | host-wide restic | Snapshots both Docker volumes off-host |
| nginx | system certbot timer | LetsEncrypt renewal |

## Escalation

- Owner: `hello@herakles.dev`
- Privacy / takedown requests: same address
- Anthropic / Gemini API status: https://status.anthropic.com / https://status.cloud.google.com
