# FinePrint — Library Seeder

Scrapes Terms of Service pages from the curated top-50 US technology services
(2026) and submits them to FinePrint's `/api/analyze` endpoint to populate the
public library.

## Architecture

```
seed.ts                  Orchestrator: iterates targets, paces, persists state
  ├─ lib/scraper.ts      Tier 1: curl via Proton proxy
  │                      Tier 2: headless Chrome (also via proxy) on JS challenge
  ├─ lib/proxy.ts        curl wrapper + UA rotation + Redis-driven IP cycling
  ├─ lib/extract.ts      jsdom heuristics — strips chrome, picks the TOS body
  ├─ lib/submit.ts       POST to FinePrint /api/analyze (add_to_library=true)
  └─ state.json          Per-company status; resume-safe
```

Anti-detection:
- Proton VPN proxy at `http://127.0.0.1:1080`
- Real Chrome 128–130 user-agent strings rotated per request
- Browser-realistic headers (`Sec-Fetch-*`, `Accept-Language`, …)
- 30s per-domain cooldown
- 60s between FinePrint submissions (well under 10/min rate limit)
- On 403/429: cycles proxy IP via Redis `proxy:cycle_request`, retries

Submission goes to the **local** FinePrint API (`http://127.0.0.1:8101`), not
through the proxy — submission is internal and shouldn't be disguised.

## Usage

```bash
# Smoke test: 5 targets, no submission
tsx cli/seed-library/seed.ts --limit 5 --dry-run

# Smoke test: 5 targets, live
tsx cli/seed-library/seed.ts --limit 5

# Specific targets
tsx cli/seed-library/seed.ts --only Google,Slack,Discord

# Full run (all 50)
tsx cli/seed-library/seed.ts

# Resume after interruption (skips already-successful entries automatically)
tsx cli/seed-library/seed.ts

# Reset state
tsx cli/seed-library/seed.ts --reset
```

## Pacing & runtime

- 50 companies × ~90s per company ≈ 75 minutes for a full run
- Uses ~300K Gemini tokens total (cap is 5M/day)
- Idempotent: re-running re-analyzes new/failed entries; existing successes are
  skipped unless `--reset` is passed

## State file

`state.json` records per-company:
- `status`: `pending | success | failed | skipped`
- `finePrintId`, `creator_token` (for republishing if needed)
- `tier`: 1 (curl) or 2 (puppeteer)
- `charCount`, `reason`: extraction metrics
- `error`: failure detail

## Adding targets

Edit `targets/top-50-us-2026.json`. Each entry needs:
- `company`: display name
- `tosUrl`: full URL of the Terms of Service page
- `category`: free-form tag

## Known limits

- Pages behind a login wall, paywall, or aggressive Cloudflare turnstile
  cannot be scraped reliably; they record as `failed` with the reason in
  `state.json` for manual triage.
- Some sites' TOS pages are JS-rendered — Tier 2 (puppeteer) handles these
  but adds ~30s per attempt.
- Re-analyzing existing companies creates a new analysis row; the older one
  auto-marks as **Superseded** in the library (handled by the version map in
  `/api/library`).
