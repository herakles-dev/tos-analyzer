#!/usr/bin/env -S node --require ts-node/register --experimental-specifier-resolution=node
/**
 * FinePrint library seeder.
 *
 * Reads targets/top-50-us-2026.json, scrapes each TOS via Proton proxy
 * (curl + Puppeteer fallback), submits to /api/analyze, persists state.
 *
 * Usage:
 *   tsx cli/seed-library/seed.ts                  # full run, all targets
 *   tsx cli/seed-library/seed.ts --limit 5        # smoke test
 *   tsx cli/seed-library/seed.ts --only Google,Slack
 *   tsx cli/seed-library/seed.ts --reset          # clear state, start fresh
 *   tsx cli/seed-library/seed.ts --dry-run        # scrape but don't submit
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scrape } from './lib/scraper';
import { submitToFinePrint } from './lib/submit';
import { currentProxyIp } from './lib/proxy';

const ROOT = __dirname;
const DEFAULT_TARGETS = 'top-100-us-2026.json';
const STATE_PATH = path.join(ROOT, 'state.json');
const LOGS_DIR = path.join(ROOT, 'logs');

const DELAY_BETWEEN_SUBMISSIONS_MS = 60_000;   // respect 10/min global rate limit
const PER_DOMAIN_DELAY_MS = 30_000;
const MIN_TEXT_FOR_SUBMIT = 1500;

type Status = 'pending' | 'success' | 'failed' | 'skipped';

interface TargetEntry {
  company: string;
  tosUrl: string;
  category: string;
}

interface StateEntry {
  company: string;
  tosUrl: string;
  status: Status;
  finePrintId?: string;
  creator_token?: string;
  cached?: boolean;
  tier?: number;
  charCount?: number;
  reason?: string;
  finalUrl?: string;
  error?: string;
  scrapedAt?: string;
  submittedAt?: string;
}

interface State {
  startedAt: string;
  updatedAt: string;
  entries: Record<string, StateEntry>;
}

function parseArgs(argv: string[]) {
  const args: { limit?: number; only?: string[]; reset?: boolean; dryRun?: boolean; targets?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--only') args.only = argv[++i].split(',').map(s => s.trim());
    else if (a === '--reset') args.reset = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--targets') args.targets = argv[++i];
  }
  return args;
}

function loadTargets(filename: string): TargetEntry[] {
  const targetsPath = path.join(ROOT, 'targets', filename);
  const raw = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
  return raw.targets;
}

function loadState(): State {
  if (!fs.existsSync(STATE_PATH)) {
    return { startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: {} };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state: State) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function processTarget(target: TargetEntry, dryRun: boolean): Promise<StateEntry> {
  const entry: StateEntry = {
    company: target.company,
    tosUrl: target.tosUrl,
    status: 'pending',
    scrapedAt: new Date().toISOString(),
  };

  try {
    console.log(`\n→ ${target.company}  (${new URL(target.tosUrl).hostname})`);
    const result = await scrape(target.tosUrl);
    entry.tier = result.tier;
    entry.charCount = result.extract.charCount;
    entry.reason = result.extract.reason;
    entry.finalUrl = result.finalUrl;

    console.log(`  tier=${result.tier} status=${result.status} chars=${result.extract.charCount} extract=${result.extract.reason}`);

    if (result.blocked || result.extract.charCount < MIN_TEXT_FOR_SUBMIT) {
      entry.status = 'failed';
      entry.error = `Insufficient TOS text (${result.extract.charCount} chars)`;
      console.log(`  ✗ blocked / insufficient text: ${result.extract.charCount} chars`);
      return entry;
    }

    if (dryRun) {
      entry.status = 'skipped';
      entry.error = 'dry-run';
      return entry;
    }

    const submission = await submitToFinePrint({
      text: result.extract.text,
      companyName: target.company,
      sourceUrl: result.finalUrl,
    });

    entry.submittedAt = new Date().toISOString();

    if (!submission.ok) {
      entry.status = 'failed';
      entry.error = submission.error || 'submit failed';
      console.log(`  ✗ submit failed: ${entry.error}`);
      return entry;
    }

    entry.status = 'success';
    entry.finePrintId = submission.id;
    entry.creator_token = submission.creator_token;
    entry.cached = submission.cached;
    console.log(`  ✓ analyzed (${submission.cached ? 'cached' : 'fresh'}) → /analysis/${submission.id}`);
    return entry;
  } catch (err: any) {
    entry.status = 'failed';
    entry.error = err?.message || String(err);
    console.log(`  ✗ ${entry.error}`);
    return entry;
  }
}

async function main() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const args = parseArgs(process.argv);
  const targetsFile = args.targets || DEFAULT_TARGETS;
  const targets = loadTargets(targetsFile);
  console.log(`[seed] Targets: ${targetsFile} (${targets.length} entries)`);
  let state = loadState();

  if (args.reset) {
    state = { startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: {} };
    saveState(state);
    console.log('[seed] State reset.');
  }

  let workQueue = targets;
  if (args.only) {
    const want = new Set(args.only.map(s => s.toLowerCase()));
    workQueue = workQueue.filter(t => want.has(t.company.toLowerCase()));
  }
  if (args.limit) workQueue = workQueue.slice(0, args.limit);

  // Skip already-successful entries unless reset
  workQueue = workQueue.filter(t => state.entries[t.company]?.status !== 'success');

  console.log(`[seed] ${workQueue.length} targets to process (skipping already-successful).`);
  console.log(`[seed] Mode: ${args.dryRun ? 'DRY-RUN (no submission)' : 'live'}`);

  const ip = await currentProxyIp();
  console.log(`[seed] Proton proxy IP: ${ip ?? 'UNAVAILABLE'}`);
  if (!ip) {
    console.error('[seed] Proxy unreachable — check hercules-proxy-proton container');
    process.exit(2);
  }

  const lastDomainHit: Record<string, number> = {};

  for (let i = 0; i < workQueue.length; i++) {
    const target = workQueue[i];
    const host = new URL(target.tosUrl).hostname.replace(/^www\./, '');
    const last = lastDomainHit[host] || 0;
    const wait = Math.max(0, last + PER_DOMAIN_DELAY_MS - Date.now());
    if (wait > 0) {
      console.log(`[seed] domain cooldown ${host}: waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }

    const entry = await processTarget(target, !!args.dryRun);
    state.entries[target.company] = entry;
    saveState(state);
    lastDomainHit[host] = Date.now();

    if (i < workQueue.length - 1 && entry.status === 'success' && !args.dryRun) {
      console.log(`[seed] cooling down ${DELAY_BETWEEN_SUBMISSIONS_MS / 1000}s before next submission…`);
      await sleep(DELAY_BETWEEN_SUBMISSIONS_MS);
    }
  }

  const summary = Object.values(state.entries).reduce<Record<Status, number>>(
    (acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + 1 }),
    { pending: 0, success: 0, failed: 0, skipped: 0 }
  );
  console.log('\n[seed] Run complete.');
  console.log(`  success: ${summary.success}`);
  console.log(`  failed:  ${summary.failed}`);
  console.log(`  skipped: ${summary.skipped}`);
  console.log(`  state:   ${STATE_PATH}`);
}

main().catch((err) => {
  console.error('[seed] FATAL', err);
  process.exit(1);
});
