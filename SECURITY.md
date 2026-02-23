# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

**Email:** [hello@herakles.dev](mailto:hello@herakles.dev)

Do not open public issues for security vulnerabilities.

## Security Architecture

### Prompt Injection Defense (3 Layers)

1. **Input validation** — Content is validated as legal/TOS text before reaching the LLM. Non-legal content is rejected with a descriptive error.
2. **System prompt hardening** — The Gemini system prompt constrains output format (JSON schema) and explicitly instructs the model to ignore embedded instructions in user content.
3. **Output validation** — LLM responses are parsed against a strict Zod schema. Any response that doesn't match the expected structure is rejected.

### Rate Limiting (Dual Layer)

- **Nginx layer** — IP-based rate limiting at the reverse proxy level
- **Redis layer** — Atomic Lua scripts enforce per-IP rate limits with sliding windows. No race conditions.

### Budget Protection

- Daily Gemini API token budget caps prevent runaway costs
- Configurable via `DAILY_TOKEN_BUDGET` environment variable
- Automatic rejection of requests when budget is exhausted

### Data Handling

- Analysis content is hashed (SHA-256) for deduplication — duplicate TOS documents return cached results
- No user accounts or personal data collected
- Analysis results expire after 30 days (configurable)
- Shared links use non-sequential UUIDs

### Infrastructure

- PostgreSQL with Prisma ORM (parameterized queries, no SQL injection surface)
- Redis connections via `ioredis` with TLS support
- Docker deployment with non-root container user
- HTTPS enforced via Cloudflare + nginx

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (main) | Yes |
