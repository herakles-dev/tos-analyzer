import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Redis from 'ioredis';

const execFileP = promisify(execFile);

export const PROXY_URL = process.env.PROTON_PROXY_URL || 'http://127.0.0.1:1080';
const REDIS_URL = process.env.PROXY_REDIS_URL || 'redis://127.0.0.1:6380';
const CYCLE_KEY = 'proxy:cycle_request';

// Real Chrome user agents (rotated per request).
export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
];

export function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export interface FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  finalUrl: string;
}

/**
 * HTTP GET via Proton proxy using curl. Browser-realistic headers + UA rotation.
 * Throws on network failure; returns status code on HTTP errors.
 */
export async function fetchViaProxy(url: string, opts?: { timeoutMs?: number }): Promise<FetchResult> {
  const ua = pickUserAgent();
  const args = [
    '--silent',
    '--show-error',
    '--location',                 // follow redirects
    '--max-redirs', '8',
    '--max-time', String(Math.floor((opts?.timeoutMs ?? 30000) / 1000)),
    '--proxy', PROXY_URL,
    '--compressed',
    '--user-agent', ua,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.9',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', 'Sec-Fetch-Dest: document',
    '-H', 'Sec-Fetch-Mode: navigate',
    '-H', 'Sec-Fetch-Site: none',
    '-H', 'Sec-Fetch-User: ?1',
    '-H', 'Upgrade-Insecure-Requests: 1',
    '-H', 'Cache-Control: max-age=0',
    '-H', 'Connection: keep-alive',
    '-w', '\n__META__\n%{http_code}\n%{url_effective}\n',
    url,
  ];

  const { stdout } = await execFileP('curl', args, { maxBuffer: 50 * 1024 * 1024 });
  const metaIdx = stdout.lastIndexOf('\n__META__\n');
  if (metaIdx < 0) {
    return { status: 0, body: stdout, headers: {}, finalUrl: url };
  }
  const body = stdout.slice(0, metaIdx);
  const metaLines = stdout.slice(metaIdx + '\n__META__\n'.length).trim().split('\n');
  const status = parseInt(metaLines[0] || '0', 10);
  const finalUrl = (metaLines[1] || url).trim();
  return { status, body, headers: {}, finalUrl };
}

/**
 * Request a proxy IP cycle via Redis. The host watcher
 * (proxy-cycle-watcher.sh) sees the key and restarts the proxy container.
 * Returns true if the watcher acknowledged within `timeoutMs`.
 */
export async function cycleProxy(timeoutMs: number = 90_000): Promise<boolean> {
  let redis: Redis | null = null;
  try {
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.set(CYCLE_KEY, '1', 'EX', 300);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const exists = await redis.exists(CYCLE_KEY);
      if (exists === 0) return true;  // watcher cleared the key = ack
    }
    return false;
  } catch (err) {
    console.warn('[proxy] cycle failed:', (err as Error).message);
    return false;
  } finally {
    if (redis) await redis.quit().catch(() => {});
  }
}

export async function currentProxyIp(): Promise<string | null> {
  try {
    const { status, body } = await fetchViaProxy('https://api.ipify.org', { timeoutMs: 8000 });
    if (status !== 200) return null;
    return body.trim();
  } catch {
    return null;
  }
}
