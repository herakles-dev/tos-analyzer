/**
 * Redis Client for Caching
 * Handles analysis caching, share links, and rate limiting
 */

import '@/lib/env';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Create Redis client
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redis.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redis.on('connect', () => {
  console.log('Redis Client Connected');
});

// Cache key prefixes
export const CACHE_KEYS = {
  ANALYSIS: 'tos:analysis:',
  SHARE: 'tos:share:',
  RATE_LIMIT: 'ratelimit:ip:',                  // analyze + publish writes
  RATE_LIMIT_READ: 'ratelimit:read:ip:',        // library, share, export reads
  RATE_LIMIT_UPLOAD: 'ratelimit:upload:ip:',    // PDF upload — separate namespace
                                                 // so 3 uploads don't eat into
                                                 // the analyze write quota
  SESSION: 'session:',
  DAILY_TOKENS: 'budget:daily_tokens:',
  DAILY_REQUESTS: 'budget:daily_requests:',
  // Per-minute global token bucket: protects against distributed attackers
  // that bypass per-IP rate limits (e.g. botnets, IPv6 prefix rotation).
  // Key suffix is YYYY-MM-DDTHH:MM (UTC).
  MINUTE_TOKENS: 'budget:minute_tokens:',
};

// Cache TTLs (in seconds)
export const CACHE_TTL = {
  ANALYSIS: 7 * 24 * 60 * 60, // 7 days
  SHARE: 30 * 24 * 60 * 60, // 30 days
  RATE_LIMIT: 60, // 1 minute
  SESSION: 24 * 60 * 60, // 24 hours
};

/**
 * Get cached analysis by content hash
 */
export async function getCachedAnalysis(contentHash: string): Promise<any | null> {
  try {
    const key = `${CACHE_KEYS.ANALYSIS}${contentHash}`;
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('Redis get error:', error);
    return null;
  }
}

/**
 * Cache analysis results
 */
export async function cacheAnalysis(contentHash: string, data: any): Promise<void> {
  try {
    const key = `${CACHE_KEYS.ANALYSIS}${contentHash}`;
    await redis.setex(key, CACHE_TTL.ANALYSIS, JSON.stringify(data));
  } catch (error) {
    console.error('Redis set error:', error);
  }
}

/**
 * Get cached share link data
 */
export async function getCachedShare(shareId: string): Promise<any | null> {
  try {
    const key = `${CACHE_KEYS.SHARE}${shareId}`;
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('Redis get error:', error);
    return null;
  }
}

/**
 * Cache share link data
 */
export async function cacheShare(shareId: string, data: any): Promise<void> {
  try {
    const key = `${CACHE_KEYS.SHARE}${shareId}`;
    await redis.setex(key, CACHE_TTL.SHARE, JSON.stringify(data));
  } catch (error) {
    console.error('Redis set error:', error);
  }
}

/**
 * Atomic rate limit using Lua script.
 * INCR and EXPIRE execute as a single atomic operation — no race condition
 * where two concurrent requests both see count=1 and one fails to set TTL.
 */
async function atomicRateLimit(key: string, windowSeconds: number): Promise<number> {
  const script = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;
  const result = await redis.eval(script, 1, key, windowSeconds.toString());
  return result as number;
}

/**
 * Check rate limit for IP address
 * Returns true if rate limit exceeded
 * FAIL-CLOSED: if Redis is down, requests are blocked (not allowed)
 */
export async function checkRateLimit(ip: string, limit: number = 10): Promise<boolean> {
  try {
    const key = `${CACHE_KEYS.RATE_LIMIT}${ip}`;
    const count = await atomicRateLimit(key, CACHE_TTL.RATE_LIMIT);
    return count > limit;
  } catch (error) {
    console.error('Redis rate limit error:', error);
    return true; // FAIL CLOSED — block requests when Redis is down
  }
}

/**
 * Lighter rate limit for read-only endpoints (library, export, view)
 * Higher limit (30/min) but still prevents scraping
 */
export async function checkReadRateLimit(ip: string, limit: number = 30): Promise<boolean> {
  try {
    const key = `${CACHE_KEYS.RATE_LIMIT_READ}${ip}`;
    const count = await atomicRateLimit(key, CACHE_TTL.RATE_LIMIT);
    return count > limit;
  } catch (error) {
    console.error('Redis read rate limit error:', error);
    return true; // FAIL CLOSED
  }
}

/**
 * Dedicated rate limit for the PDF upload endpoint. Uses its own Redis key
 * namespace so a user's upload activity doesn't consume their analyze quota
 * (and vice-versa). Defaults to 3/min to match the nginx-level cap.
 */
export async function checkUploadRateLimit(ip: string, limit: number = 3): Promise<boolean> {
  try {
    const key = `${CACHE_KEYS.RATE_LIMIT_UPLOAD}${ip}`;
    const count = await atomicRateLimit(key, CACHE_TTL.RATE_LIMIT);
    return count > limit;
  } catch (error) {
    console.error('Redis upload rate limit error:', error);
    return true; // FAIL CLOSED
  }
}

/**
 * Daily token budget tracking (legacy — kept for read-only stats endpoints).
 * For the request flow, use reserveDailyBudget() instead, which atomically
 * checks-and-increments and prevents the surge-overshoot race.
 */
export async function checkDailyBudget(tokensToAdd: number = 0): Promise<{ exceeded: boolean; used: number; limit: number }> {
  const limit = parseInt(process.env.DAILY_TOKEN_BUDGET || '5000000');
  const today = new Date().toISOString().split('T')[0];
  const tokenKey = `${CACHE_KEYS.DAILY_TOKENS}${today}`;
  const requestKey = `${CACHE_KEYS.DAILY_REQUESTS}${today}`;

  try {
    let used = 0;
    if (tokensToAdd > 0) {
      used = await redis.incrby(tokenKey, tokensToAdd);
      await redis.incr(requestKey);
      await redis.expire(tokenKey, 48 * 60 * 60);
      await redis.expire(requestKey, 48 * 60 * 60);
    } else {
      const current = await redis.get(tokenKey);
      used = current ? parseInt(current, 10) : 0;
    }
    return { exceeded: used > limit, used, limit };
  } catch (error) {
    console.error('Redis budget check error:', error);
    return { exceeded: true, used: 0, limit };
  }
}

/**
 * Atomically reserve `estimate` tokens against the daily budget.
 *
 * Closes the surge-overshoot race in checkDailyBudget(): the old code did
 * "read used; if used+new <= limit, INCRBY new". Two concurrent requests
 * could both pass the read-side check and both INCRBY, blowing through
 * the cap. This script does the check-and-increment atomically — the budget
 * cap is now mathematically authoritative.
 *
 * Returns:
 *   { ok: true,  used }  — reserved successfully (caller must commit/refund)
 *   { ok: false, used }  — would exceed limit; not reserved
 *
 * Pair every successful reserve with exactly one of:
 *   - commitTokenUsage(estimate, actual)  on success
 *   - refundDailyBudget(estimate)         on failure
 */
export async function reserveDailyBudget(
  estimate: number
): Promise<{ ok: boolean; used: number; limit: number }> {
  const limit = parseInt(process.env.DAILY_TOKEN_BUDGET || '5000000');
  const today = new Date().toISOString().split('T')[0];
  const tokenKey = `${CACHE_KEYS.DAILY_TOKENS}${today}`;
  const requestKey = `${CACHE_KEYS.DAILY_REQUESTS}${today}`;
  const ttl = 48 * 60 * 60;

  if (estimate <= 0) {
    return { ok: true, used: 0, limit };
  }

  const script = `
    local current = tonumber(redis.call('GET', KEYS[1])) or 0
    local cap = tonumber(ARGV[2])
    local add = tonumber(ARGV[1])
    if (current + add) > cap then
      return {0, current}
    end
    local newval = redis.call('INCRBY', KEYS[1], add)
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    redis.call('INCR', KEYS[2])
    redis.call('EXPIRE', KEYS[2], ARGV[3])
    return {1, newval}
  `;

  try {
    const result = (await redis.eval(
      script, 2, tokenKey, requestKey,
      estimate.toString(), limit.toString(), ttl.toString()
    )) as [number, number];
    return { ok: result[0] === 1, used: result[1], limit };
  } catch (error) {
    console.error('Redis budget reserve error:', error);
    // FAIL CLOSED — never let a Redis outage uncap spending.
    return { ok: false, used: 0, limit };
  }
}

/**
 * Refund unused tokens to the daily budget. Clamped at zero. Uses SET KEEPTTL
 * so we don't extend the day-rollover boundary by re-issuing a fresh 48h TTL
 * on every refund.
 */
export async function refundDailyBudget(tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const today = new Date().toISOString().split('T')[0];
  const tokenKey = `${CACHE_KEYS.DAILY_TOKENS}${today}`;
  // SET ... KEEPTTL preserves the existing TTL — Redis 6.0+ (we run 7-alpine).
  // If the key has no TTL (shouldn't happen), SETEX it with the standard TTL.
  const script = `
    local current = tonumber(redis.call('GET', KEYS[1])) or 0
    local refund = tonumber(ARGV[1])
    local newval = current - refund
    if newval < 0 then newval = 0 end
    local ttl = redis.call('TTL', KEYS[1])
    if ttl > 0 then
      redis.call('SET', KEYS[1], newval, 'KEEPTTL')
    else
      redis.call('SET', KEYS[1], newval, 'EX', ARGV[2])
    end
    return newval
  `;
  try {
    await redis.eval(script, 1, tokenKey, tokens.toString(), (48 * 60 * 60).toString());
  } catch (error) {
    console.error('Redis budget refund error:', error);
  }
}

/**
 * Refund tokens to the per-minute global bucket (e.g. on Gemini failure or
 * Redis-cache hit, where the LLM was not actually called).
 * Without this, a single failed analysis exhausts the 90s bucket window
 * for all users system-wide — exploitable as a service-wide DoS.
 */
export async function refundMinuteBucket(tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const minute = new Date().toISOString().slice(0, 16);
  const key = `${CACHE_KEYS.MINUTE_TOKENS}${minute}`;
  const script = `
    local current = tonumber(redis.call('GET', KEYS[1])) or 0
    local refund = tonumber(ARGV[1])
    local newval = current - refund
    if newval < 0 then newval = 0 end
    local ttl = redis.call('TTL', KEYS[1])
    if ttl > 0 then
      redis.call('SET', KEYS[1], newval, 'KEEPTTL')
    else
      redis.call('SET', KEYS[1], newval, 'EX', '90')
    end
    return newval
  `;
  try {
    await redis.eval(script, 1, key, tokens.toString());
  } catch (error) {
    console.error('Redis minute-bucket refund error:', error);
  }
}

/**
 * Commit actual token usage after a successful Gemini call.
 * Reconciles `estimate` (already reserved) with `actual`:
 *   actual > estimate → atomic check-and-INCRBY against limit (matches reserve)
 *   actual < estimate → refund the unused portion
 *
 * The positive-delta path MUST be atomic, otherwise concurrent commits
 * re-open the surge-overshoot race that reserveDailyBudget closed.
 */
export async function commitTokenUsage(estimate: number, actual: number): Promise<void> {
  const delta = actual - estimate;
  if (delta === 0) return;
  if (delta < 0) {
    await refundDailyBudget(-delta);
    return;
  }

  // delta > 0 — actual exceeded estimate. Atomic check-and-increment so we
  // never push past the daily cap even under concurrency.
  const limit = parseInt(process.env.DAILY_TOKEN_BUDGET || '5000000');
  const today = new Date().toISOString().split('T')[0];
  const tokenKey = `${CACHE_KEYS.DAILY_TOKENS}${today}`;
  // Atomic: check current + delta vs cap, INCRBY by min(delta, cap - current).
  // Always commit at least *some* amount even if we're already over (caller
  // already paid for these tokens in real life — not committing them
  // under-reports actual spend).
  const script = `
    local current = tonumber(redis.call('GET', KEYS[1])) or 0
    local cap = tonumber(ARGV[2])
    local add = tonumber(ARGV[1])
    local headroom = cap - current
    local toAdd = add
    if toAdd > headroom then
      if headroom > 0 then toAdd = headroom else toAdd = 0 end
    end
    if toAdd > 0 then
      redis.call('INCRBY', KEYS[1], toAdd)
      redis.call('EXPIRE', KEYS[1], ARGV[3])
    end
    return toAdd
  `;
  try {
    await redis.eval(
      script, 1, tokenKey,
      delta.toString(), limit.toString(), (48 * 60 * 60).toString()
    );
  } catch (error) {
    console.error('Redis commit token usage error:', error);
  }
}

/**
 * Lock TTL must exceed `maxDuration` on the analyze route (300s) plus a
 * small safety margin, otherwise a long Gemini call can let the lock expire
 * mid-flight, allowing a second concurrent request to also call Gemini.
 */
export const CONTENT_LOCK_TTL_SECONDS = 310;

/**
 * Acquire a short-lived lock keyed on contentHash so two concurrent requests
 * with the same input don't both miss the cache and both call Gemini.
 * Returns the lock token on success, null if another request holds it.
 *
 * Pair every successful acquire() with a release() in a finally — otherwise
 * the lock pins the slot for the full TTL.
 */
export async function acquireContentLock(
  contentHash: string,
  ttlSeconds: number = CONTENT_LOCK_TTL_SECONDS
): Promise<string | null> {
  // The token is a per-call random hex so release() can verify it owns the
  // lock and won't release a lock another request renewed.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = `lock:content:${contentHash}`;
  try {
    const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? token : null;
  } catch (error) {
    console.error('Redis lock acquire error:', error);
    // Fail-open on lock acquisition: if Redis is down we don't want to block
    // legitimate requests. Worst case a duplicate Gemini call happens, which
    // is bounded by the budget pre-reservation.
    return token;
  }
}

export async function releaseContentLock(contentHash: string, token: string): Promise<void> {
  if (!token) return;
  const key = `lock:content:${contentHash}`;
  // Only delete if we still own it (token matches). Avoids releasing a lock
  // that was acquired by a later request after our TTL expired.
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;
  try {
    await redis.eval(script, 1, key, token);
  } catch (error) {
    console.error('Redis lock release error:', error);
  }
}

/**
 * Debounce per-(session, target) actions. Returns true if this is the first
 * occurrence within the window, false if it's a duplicate. Used to prevent
 * library-popularity inflation via repeated GETs of /api/analysis/[id].
 */
export async function debounceAction(
  bucket: string, sessionHash: string, targetId: string, ttlSeconds: number = 24 * 60 * 60
): Promise<boolean> {
  if (!sessionHash || !targetId) return true;
  const key = `debounce:${bucket}:${sessionHash}:${targetId}`;
  try {
    // SET NX returns 'OK' on first set, null on duplicate.
    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (error) {
    console.error('Redis debounce error:', error);
    // Fail-open: a Redis hiccup shouldn't suppress legitimate views.
    return true;
  }
}

/**
 * Per-minute global token bucket. Independent of per-IP limits; protects
 * against distributed attacks (botnets, IPv6 prefix rotation) that bypass
 * IP-based rate limits. Default 100k tokens/min.
 *
 * Atomically reserves `estimate` against the current minute's bucket.
 * Returns ok:false without reserving if it would exceed.
 */
export async function checkGlobalTokenBucket(
  estimate: number
): Promise<{ ok: boolean; used: number; limit: number }> {
  // Default 1M tokens/min — sized so legitimate concurrency (~10 simultaneous
  // 5k-word TOS users at ~15k tokens each = 150k/min) leaves headroom while
  // still capping bot/distributed abuse to a sustainable rate. Tune via env
  // once we have measured production traffic.
  const limit = parseInt(process.env.MINUTE_TOKEN_BUDGET || '1000000');
  // Bucket key includes minute granularity (UTC). 90s TTL is a safety margin
  // so a key SET at second :59 doesn't expire before that minute is fully
  // accounted for. Two adjacent minute keys can coexist briefly; requests
  // are partitioned to the current minute so no double-counting occurs.
  const minute = new Date().toISOString().slice(0, 16);
  const key = `${CACHE_KEYS.MINUTE_TOKENS}${minute}`;
  const ttl = 90; // covers the minute + a little overlap

  if (estimate <= 0) {
    return { ok: true, used: 0, limit };
  }

  const script = `
    local current = tonumber(redis.call('GET', KEYS[1])) or 0
    local cap = tonumber(ARGV[2])
    local add = tonumber(ARGV[1])
    if (current + add) > cap then
      return {0, current}
    end
    local newval = redis.call('INCRBY', KEYS[1], add)
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return {1, newval}
  `;
  try {
    const result = (await redis.eval(
      script, 1, key, estimate.toString(), limit.toString(), ttl.toString()
    )) as [number, number];
    return { ok: result[0] === 1, used: result[1], limit };
  } catch (error) {
    console.error('Redis minute bucket error:', error);
    return { ok: false, used: 0, limit };
  }
}

/**
 * Get daily usage stats
 */
export async function getDailyUsageStats(): Promise<{ tokens: number; requests: number; budget: number }> {
  const today = new Date().toISOString().split('T')[0];
  const budget = parseInt(process.env.DAILY_TOKEN_BUDGET || '5000000');
  try {
    const [tokens, requests] = await Promise.all([
      redis.get(`${CACHE_KEYS.DAILY_TOKENS}${today}`),
      redis.get(`${CACHE_KEYS.DAILY_REQUESTS}${today}`),
    ]);
    return {
      tokens: tokens ? parseInt(tokens, 10) : 0,
      requests: requests ? parseInt(requests, 10) : 0,
      budget,
    };
  } catch {
    return { tokens: 0, requests: 0, budget };
  }
}

/**
 * Get current rate limit count for IP
 */
export async function getRateLimitCount(ip: string): Promise<number> {
  try {
    const key = `${CACHE_KEYS.RATE_LIMIT}${ip}`;
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  } catch (error) {
    console.error('Redis rate limit count error:', error);
    return 0;
  }
}

/**
 * Clear rate limit for IP (admin use)
 */
export async function clearRateLimit(ip: string): Promise<void> {
  try {
    const key = `${CACHE_KEYS.RATE_LIMIT}${ip}`;
    await redis.del(key);
  } catch (error) {
    console.error('Redis clear rate limit error:', error);
  }
}

/**
 * Invalidate cache by key or pattern
 * Uses SCAN instead of KEYS to avoid blocking Redis on large datasets
 */
export async function invalidateCache(keyOrPattern: string): Promise<void> {
  try {
    if (keyOrPattern.includes('*')) {
      let deletedCount = 0;
      const stream = redis.scanStream({ match: keyOrPattern, count: 100 });

      await new Promise<void>((resolve, reject) => {
        stream.on('data', async (keys: string[]) => {
          if (keys.length > 0) {
            stream.pause();
            await redis.del(...keys);
            deletedCount += keys.length;
            stream.resume();
          }
        });
        stream.on('end', () => {
          if (deletedCount > 0) {
            console.log(`Invalidated ${deletedCount} cache keys matching ${keyOrPattern}`);
          }
          resolve();
        });
        stream.on('error', reject);
      });
    } else {
      await redis.del(keyOrPattern);
      console.log(`Invalidated cache key: ${keyOrPattern}`);
    }
  } catch (error) {
    console.error('Redis cache invalidation error:', error);
  }
}

/**
 * Get rate limit info for response headers. `keyPrefix` lets each endpoint
 * read its own counter (analyze: RATE_LIMIT, upload: RATE_LIMIT_UPLOAD, etc.).
 */
export async function getRateLimitInfo(
  ip: string,
  limit: number = 10,
  keyPrefix: string = CACHE_KEYS.RATE_LIMIT
): Promise<{ limit: number; remaining: number; reset: number }> {
  try {
    const key = `${keyPrefix}${ip}`;
    const [count, ttl] = await Promise.all([
      redis.get(key),
      redis.ttl(key),
    ]);
    const current = count ? parseInt(count, 10) : 0;
    return {
      limit,
      remaining: Math.max(0, limit - current),
      reset: ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : Math.floor(Date.now() / 1000) + CACHE_TTL.RATE_LIMIT,
    };
  } catch (error) {
    console.error('Redis rate limit info error:', error);
    return { limit, remaining: limit, reset: Math.floor(Date.now() / 1000) + CACHE_TTL.RATE_LIMIT };
  }
}

/**
 * Health check - verify Redis connection
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error('Redis health check failed:', error);
    return false;
  }
}

export default redis;
