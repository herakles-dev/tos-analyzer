import { CACHE_KEYS, CACHE_TTL } from '@/lib/redis';

// Mock ioredis before importing the module
jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  return jest.fn().mockImplementation(() => ({
    get: jest.fn(async (key: string) => store.get(key) || null),
    setex: jest.fn(async (key: string, ttl: number, value: string) => {
      store.set(key, value);
      ttls.set(key, ttl);
    }),
    del: jest.fn(async (...keys: string[]) => {
      keys.forEach(k => { store.delete(k); ttls.delete(k); });
    }),
    incr: jest.fn(async (key: string) => {
      const val = parseInt(store.get(key) || '0') + 1;
      store.set(key, String(val));
      return val;
    }),
    incrby: jest.fn(async (key: string, amount: number) => {
      const val = parseInt(store.get(key) || '0') + amount;
      store.set(key, String(val));
      return val;
    }),
    expire: jest.fn(async () => 1),
    ttl: jest.fn(async () => 60),
    eval: jest.fn(async (_script: string, _numkeys: number, key: string) => {
      const val = parseInt(store.get(key) || '0') + 1;
      store.set(key, String(val));
      return val;
    }),
    ping: jest.fn(async () => 'PONG'),
    scanStream: jest.fn(() => ({
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'end') cb();
      }),
      pause: jest.fn(),
      resume: jest.fn(),
    })),
    on: jest.fn(),
    _store: store,
    _clear: () => { store.clear(); ttls.clear(); },
  }));
});

// Must import after mock
const redis = require('@/lib/redis');

describe('CACHE_KEYS', () => {
  it('has all required prefixes', () => {
    expect(CACHE_KEYS.ANALYSIS).toBe('tos:analysis:');
    expect(CACHE_KEYS.SHARE).toBe('tos:share:');
    expect(CACHE_KEYS.RATE_LIMIT).toBe('ratelimit:ip:');
    expect(CACHE_KEYS.SESSION).toBe('session:');
    expect(CACHE_KEYS.DAILY_TOKENS).toBe('budget:daily_tokens:');
  });
});

describe('CACHE_TTL', () => {
  it('has correct TTL values', () => {
    expect(CACHE_TTL.ANALYSIS).toBe(7 * 24 * 60 * 60);
    expect(CACHE_TTL.SHARE).toBe(30 * 24 * 60 * 60);
    expect(CACHE_TTL.RATE_LIMIT).toBe(60);
    expect(CACHE_TTL.SESSION).toBe(24 * 60 * 60);
  });
});

describe('getCachedAnalysis', () => {
  it('returns null for cache miss', async () => {
    const result = await redis.getCachedAnalysis('nonexistent');
    expect(result).toBeNull();
  });
});

describe('cacheAnalysis', () => {
  it('stores and retrieves analysis', async () => {
    const data = { summary: { overall_risk: 'low' } };
    await redis.cacheAnalysis('test-hash', data);
    const result = await redis.getCachedAnalysis('test-hash');
    expect(result).toEqual(data);
  });
});

describe('checkRedisHealth', () => {
  it('returns true when redis is connected', async () => {
    const result = await redis.checkRedisHealth();
    expect(result).toBe(true);
  });
});
