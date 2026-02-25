/**
 * Health endpoint tests
 * Tests the GET /api/health route handler
 *
 * @jest-environment node
 */

// Mock next/server before any imports
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: { status?: number }) => ({
      status: init?.status || 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn(),
  },
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn(async () => 'PONG'),
    on: jest.fn(),
    get: jest.fn(async () => null),
    setex: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
  }));
});

import { GET } from '@/app/api/health/route';
import { prisma } from '@/lib/prisma';

describe('GET /api/health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('returns 200 when all services are healthy', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('healthy');
    expect(body.checks.database).toBe(true);
    expect(body.checks.redis).toBe(true);
    expect(body.checks.gemini).toBe(true);
    expect(body.timestamp).toBeDefined();
  });

  it('returns 500 when database is down', async () => {
    (prisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('Connection refused'));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('unhealthy');
    expect(body.checks.database).toBe(false);
  });

  it('reports gemini as false when API key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);

    const response = await GET();
    const body = await response.json();

    expect(body.checks.gemini).toBe(false);
  });
});
