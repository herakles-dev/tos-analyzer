# Contributing to FinePrint

Thanks for your interest in contributing.

## Development Setup

```bash
# Clone
git clone https://github.com/HeraclesBass/tos-analyzer.git
cd tos-analyzer

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials (see below)

# Set up database
npx prisma generate
npx prisma db push

# Run dev server
npm run dev
```

## Environment Variables

You'll need:
- **Gemini API key** — Get one at [ai.google.dev](https://ai.google.dev/)
- **PostgreSQL** — Local instance or use Docker: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:15-alpine`
- **Redis** — Local instance or use Docker: `docker run -d -p 6379:6379 redis:7-alpine`

## Running Tests

```bash
npm test
```

Tests use Jest with a test database. The CI pipeline runs lint, tests, and build checks on every push.

## Pull Request Process

1. Fork the repo and create a feature branch from `main`
2. Make your changes with clear commit messages
3. Ensure `npm run lint` and `npm test` pass
4. Open a PR with a description of what changed and why

## Code Style

- TypeScript strict mode
- Functional components with hooks (React)
- Server Components by default (Next.js App Router)
- Zod for all runtime validation
