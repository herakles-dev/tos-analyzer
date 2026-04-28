import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchViaProxy, cycleProxy, pickUserAgent, PROXY_URL } from './proxy';
import { extractTosText, ExtractResult } from './extract';

const execFileP = promisify(execFile);

const MIN_TOS_CHARS = 1500;       // Below this looks like a JS challenge / blocked page
const HARD_TIMEOUT_MS = 45_000;
const HEADLESS_TIMEOUT_MS = 60_000;

export interface ScrapeResult {
  tier: 1 | 2;
  status: number;
  finalUrl: string;
  extract: ExtractResult;
  blocked: boolean;
}

/**
 * Best-effort scrape of a TOS URL. Tier 1 = curl through Proton proxy.
 * Tier 2 = headless Chromium (also via proxy) — only enabled when
 * SEED_USE_TIER2=1, since Chrome's background traffic floods the gluetun DNS
 * resolver under sustained use.
 */
export async function scrape(url: string): Promise<ScrapeResult> {
  // --- Tier 1: curl ---
  let res = await fetchViaProxy(url, { timeoutMs: HARD_TIMEOUT_MS });

  if (res.status === 403 || res.status === 429) {
    console.log(`  → ${res.status} from ${hostOf(url)}; cycling proxy`);
    const acked = await cycleProxy();
    if (acked) {
      res = await fetchViaProxy(url, { timeoutMs: HARD_TIMEOUT_MS });
    }
  }

  if (res.status >= 200 && res.status < 400) {
    const extract = extractTosText(res.body, res.finalUrl);
    if (extract.charCount >= MIN_TOS_CHARS) {
      return { tier: 1, status: res.status, finalUrl: res.finalUrl, extract, blocked: false };
    }
    if (process.env.SEED_USE_TIER2 !== '1') {
      console.log(`  → Tier 1 returned ${extract.charCount} chars; Tier 2 disabled, marking blocked`);
      return { tier: 1, status: res.status, finalUrl: res.finalUrl, extract, blocked: true };
    }
    console.log(`  → Tier 1 returned ${extract.charCount} chars (likely JS challenge); falling to Tier 2`);
  } else {
    if (process.env.SEED_USE_TIER2 !== '1') {
      console.log(`  → Tier 1 status ${res.status}; Tier 2 disabled, marking blocked`);
      return { tier: 1, status: res.status, finalUrl: res.finalUrl, extract: { text: '', title: null, reason: 'body-fallback', charCount: 0, wordCount: 0 }, blocked: true };
    }
    console.log(`  → Tier 1 status ${res.status}; falling to Tier 2`);
  }

  // --- Tier 2: headless Chromium ---
  return scrapeWithChromium(url);
}

async function scrapeWithChromium(url: string): Promise<ScrapeResult> {
  const ua = pickUserAgent();
  const proxyHost = PROXY_URL.replace(/^https?:\/\//, '');

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    // Suppress Chrome's chatty background traffic that floods the proxy:
    '--disable-extensions',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-component-extensions-with-background-pages',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--disable-sync',
    '--disable-background-networking',
    '--no-default-browser-check',
    '--no-first-run',
    '--metrics-recording-only',
    `--proxy-server=${proxyHost}`,
    `--user-agent=${ua}`,
    '--virtual-time-budget=15000',
    '--run-all-compositor-stages-before-draw',
    '--dump-dom',
    '--window-size=1366,900',
    url,
  ];

  try {
    const { stdout } = await execFileP('google-chrome', args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: HEADLESS_TIMEOUT_MS,
    });
    const html = stdout;
    const extract = extractTosText(html, url);
    const blocked = extract.charCount < MIN_TOS_CHARS;
    return {
      tier: 2,
      status: blocked ? 0 : 200,
      finalUrl: url,
      extract,
      blocked,
    };
  } catch (err: any) {
    return {
      tier: 2,
      status: 0,
      finalUrl: url,
      extract: { text: '', title: null, reason: 'body-fallback', charCount: 0, wordCount: 0 },
      blocked: true,
    };
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
