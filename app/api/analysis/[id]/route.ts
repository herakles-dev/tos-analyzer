/**
 * Shareable Analysis Endpoint
 * GET /api/analysis/[id]
 * 
 * Retrieves analysis by ID (for shareable links)
 * Tracks view count and analytics
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCachedShare, cacheShare, checkReadRateLimit, debounceAction } from '@/lib/redis';
import { formatError, generateSessionHash, getClientIP, rateLimitKey, calculatePopularityScore, logErrorSafely } from '@/lib/utils';

// Force browsers + intermediaries to never cache this endpoint. A transient
// 429/5xx must not get pinned to a URL the user later revisits — that's the
// "works in another browser, fails in mine" failure mode.
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
} as const;

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return NextResponse.json(
        formatError('Invalid analysis ID format', 'INVALID_ID'),
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // Rate limit read endpoints (60/min per IP) — checked AFTER cache lookup
    // so a cached HIT is free and casual library browsing doesn't trip the limit.
    const clientIP = getClientIP(request.headers);

    // Check cache first
    const cached = await getCachedShare(id);
    if (cached) {
      return NextResponse.json(
        { success: true, data: cached, cached: true },
        { headers: NO_STORE_HEADERS }
      );
    }

    if (await checkReadRateLimit(rateLimitKey(clientIP), 60)) {
      return NextResponse.json(
        formatError('Rate limit exceeded. Please try again later.', 'RATE_LIMIT_EXCEEDED'),
        { status: 429, headers: NO_STORE_HEADERS }
      );
    }

    // Fetch from database
    const analysis = await prisma.analysis.findUnique({
      where: { id },
      include: {
        shares: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!analysis) {
      return NextResponse.json(
        formatError('Analysis not found', 'NOT_FOUND'),
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    // Public (library) analyses never expire — they remain viewable with age warnings.
    // Private analyses expire after 30 days for privacy/storage hygiene.
    if (!analysis.isPublic && new Date(analysis.expiresAt) < new Date()) {
      return NextResponse.json(
        formatError('Analysis has expired', 'EXPIRED'),
        { status: 410, headers: NO_STORE_HEADERS }
      );
    }

    // Debounce view counts: only one count per (sessionHash, analysisId) per
    // 24h. Without this, an attacker could refresh /api/analysis/[id] in a loop
    // to inflate viewCount + popularityScore and game the library "Popular"
    // sort. checkReadRateLimit (30/min) limits the burst rate, but doesn't
    // stop a slow-roll over hours.
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const sessionHash = generateSessionHash(clientIP, userAgent);
    const isFirstViewToday = await debounceAction('view', sessionHash, id, 24 * 60 * 60);

    let share = analysis.shares[0];
    if (!share) {
      // Create new share record (always — first ever view from this session)
      share = await prisma.share.create({
        data: {
          analysisId: id,
          sessionHash,
          expiresAt: analysis.expiresAt,
          viewCount: 1,
        },
      });
    } else if (isFirstViewToday) {
      share = await prisma.share.update({
        where: { id: share.id },
        data: { viewCount: { increment: 1 } },
      });
    }
    // else: same session viewed within 24h — skip the increment.

    // Track analytics event (always — analytics are independent of viewCount)
    await prisma.analyticsEvent.create({
      data: {
        analysisId: id,
        eventType: 'share_viewed',
        sessionHash,
        metadata: {
          view_count: share.viewCount,
          debounced: !isFirstViewToday,
        },
      },
    });

    // Update popularity score for public analyses — only when viewCount changed
    if (analysis.isPublic && isFirstViewToday) {
      const totalShareCount = await prisma.share.count({
        where: { analysisId: id },
      });
      const newPopularityScore = calculatePopularityScore(share.viewCount, totalShareCount);

      await prisma.analysis.update({
        where: { id },
        data: { popularityScore: newPopularityScore },
      });
    }

    // Prepare response data
    const responseData = {
      id: analysis.id,
      analysis: analysis.analysisData,
      source_type: analysis.sourceType,
      source_url: analysis.sourceUrl,
      word_count: analysis.wordCount,
      created_at: analysis.createdAt,
      expires_at: analysis.expiresAt,
      view_count: share.viewCount,
      company_name: analysis.companyName,
      is_public: analysis.isPublic,
    };

    // Cache the result
    await cacheShare(id, responseData);

    return NextResponse.json(
      { success: true, data: responseData, cached: false },
      { headers: NO_STORE_HEADERS }
    );

  } catch (error) {
    logErrorSafely('analysis.GET', error, { endpoint: '/api/analysis/[id]' });

    const isDev = process.env.NODE_ENV === 'development';
    return NextResponse.json(
      formatError(
        isDev && error instanceof Error ? error.message : 'Internal server error',
        'RETRIEVAL_ERROR'
      ),
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
