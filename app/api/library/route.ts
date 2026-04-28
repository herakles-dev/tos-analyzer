/**
 * Public TOS Library Endpoint
 * GET /api/library
 *
 * Retrieves public TOS analyses for the community library
 * Features:
 * - Search by company name
 * - Sort by popularity, recency, risk level
 * - Filter by category and risk level
 * - Pagination with offset
 * - Per-analysis version metadata (isSuperseded + latestId)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { checkReadRateLimit } from '@/lib/redis';
import { formatError, getClientIP, rateLimitKey, normalizeCompanyName, calculateRiskScore, logErrorSafely } from '@/lib/utils';

// Don't let stale failures get pinned in browser caches.
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
} as const;

const LibraryQuerySchema = z.object({
  search: z.string().max(100).optional(),
  sort: z.enum(['popular', 'recent', 'risk-high', 'risk-low']).optional().default('popular'),
  category: z.string().max(100).optional(),
  filter: z.enum(['all', 'high-risk', 'medium-risk', 'low-risk']).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const RISK_SCORES: Record<string, number> = { high: 3, medium: 2, low: 1 };

interface AnalysisData {
  summary?: {
    overall_risk?: string;
    total_clauses?: number;
    red_count?: number;
    yellow_count?: number;
    green_count?: number;
  };
  categories?: Array<{ name: string; clauses: Array<any> }>;
  document_validation?: {
    is_legal_document?: boolean;
    is_complete_document?: boolean;
    content_issues?: string[];
  };
  [key: string]: any;
}

// Safety filter: even if a low-quality entry is_public=true (legacy data, edge case),
// hide it from the library. Belt-and-suspenders alongside the publish gate.
function isLibraryEligible(analysisData: any): boolean {
  const data = analysisData as AnalysisData;
  if (data?.document_validation?.is_complete_document === false) return false;
  const totalClauses = data?.summary?.total_clauses ?? 0;
  if (totalClauses < 3) return false;
  return true;
}

function parseAnalysisData(analysisData: any): {
  overallRisk: string;
  categories: string[];
  clauseCount: number;
  score: number;
} {
  const data = analysisData as AnalysisData;
  const redCount = data.summary?.red_count || 0;
  const yellowCount = data.summary?.yellow_count || 0;
  const greenCount = data.summary?.green_count || 0;
  const score = calculateRiskScore(redCount, yellowCount, greenCount);
  return {
    overallRisk: data.summary?.overall_risk || 'unknown',
    categories: data.categories?.map(c => c.name) || [],
    clauseCount: data.summary?.total_clauses || 0,
    score,
  };
}

function getRiskScore(risk: string): number {
  return RISK_SCORES[risk] || 0;
}

export async function GET(request: NextRequest) {
  try {
    const clientIP = getClientIP(request.headers);
    if (await checkReadRateLimit(rateLimitKey(clientIP))) {
      return NextResponse.json(
        formatError('Rate limit exceeded. Please try again later.', 'RATE_LIMIT_EXCEEDED'),
        { status: 429, headers: NO_STORE_HEADERS }
      );
    }

    const { searchParams } = new URL(request.url);
    const queryParams = {
      search: searchParams.get('search') || undefined,
      sort: searchParams.get('sort') || 'popular',
      category: searchParams.get('category') || undefined,
      filter: searchParams.get('filter') || 'all',
      limit: searchParams.get('limit') || '50',
      offset: searchParams.get('offset') || '0',
    };

    const validationResult = LibraryQuerySchema.safeParse(queryParams);
    if (!validationResult.success) {
      return NextResponse.json(
        formatError(validationResult.error.errors[0].message, 'VALIDATION_ERROR'),
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    const { search, sort, category, filter, limit, offset } = validationResult.data;

    const where: any = { isPublic: true };
    if (search) {
      where.companyName = { contains: search, mode: 'insensitive' };
    }

    const needsInMemoryFilter = !!category || filter !== 'all';
    const needsInMemorySort = sort === 'risk-high' || sort === 'risk-low';
    const useDbPagination = !needsInMemoryFilter && !needsInMemorySort;

    const orderBy: any = (() => {
      switch (sort) {
        case 'popular': return { popularityScore: 'desc' as const };
        case 'recent':  return { createdAt: 'desc' as const };
        default:        return { popularityScore: 'desc' as const };
      }
    })();

    // Build version map (latest analysis per normalized company) BEFORE filtering.
    // Older versions are hidden from library view — only the freshest analysis
    // per company surfaces. Items without a normalizable company name have no
    // version peers and are always shown.
    const versionRows = await prisma.analysis.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, companyName: true, createdAt: true },
    });

    const latestByCompany = new Map<string, { id: string; createdAt: Date }>();
    const visibleIds = new Set<string>();
    for (const row of versionRows) {
      const key = normalizeCompanyName(row.companyName);
      if (!key) {
        visibleIds.add(row.id);
        continue;
      }
      const existing = latestByCompany.get(key);
      if (!existing || row.createdAt > existing.createdAt) {
        latestByCompany.set(key, { id: row.id, createdAt: row.createdAt });
      }
    }
    latestByCompany.forEach(v => visibleIds.add(v.id));

    const visibleWhere = { ...where, id: { in: Array.from(visibleIds) } };

    let analyses;
    let dbTotalCount: number | null = null;

    if (useDbPagination) {
      const [rows, count] = await Promise.all([
        prisma.analysis.findMany({
          where: visibleWhere,
          orderBy,
          skip: offset,
          take: limit,
          include: {
            shares: { select: { viewCount: true } },
            _count: { select: { shares: true } },
          },
        }),
        prisma.analysis.count({ where: visibleWhere }),
      ]);
      analyses = rows;
      dbTotalCount = count;
    } else {
      // For in-memory filter/sort we fetch a capped working set then paginate
      analyses = await prisma.analysis.findMany({
        where: visibleWhere,
        orderBy,
        take: 500,
        include: {
          shares: { select: { viewCount: true } },
          _count: { select: { shares: true } },
        },
      });
    }

    const parsedAnalyses = analyses
      .filter(analysis => isLibraryEligible(analysis.analysisData))
      .map(analysis => {
        const parsed = parseAnalysisData(analysis.analysisData);
        const totalViews = analysis.shares.reduce((sum, share) => sum + share.viewCount, 0);
        const key = normalizeCompanyName(analysis.companyName);
        const latest = key ? latestByCompany.get(key) : undefined;
        const isSuperseded = !!(latest && latest.id !== analysis.id);

        return {
          id: analysis.id,
          companyName: analysis.companyName || 'Unknown',
          popularityScore: analysis.popularityScore,
          overallRisk: parsed.overallRisk,
          clauseCount: parsed.clauseCount,
          viewCount: totalViews,
          shareCount: analysis._count.shares,
          createdAt: analysis.createdAt,
          categories: parsed.categories,
          score: parsed.score,
          isSuperseded,
          latestId: isSuperseded ? latest!.id : null,
        };
      });

    let workingSet = parsedAnalyses;

    if (category) {
      workingSet = workingSet.filter(a =>
        a.categories.some(cat => cat.toLowerCase().includes(category.toLowerCase()))
      );
    }

    if (filter !== 'all') {
      const riskLevel = filter.replace('-risk', '');
      workingSet = workingSet.filter(a => a.overallRisk.toLowerCase() === riskLevel);
    }

    if (needsInMemorySort) {
      workingSet.sort((a, b) => {
        if (sort === 'risk-high') return getRiskScore(b.overallRisk) - getRiskScore(a.overallRisk);
        if (sort === 'risk-low')  return getRiskScore(a.overallRisk) - getRiskScore(b.overallRisk);
        return 0;
      });
    }

    let pageRows;
    let total;
    if (useDbPagination) {
      pageRows = workingSet;
      total = dbTotalCount ?? visibleIds.size;
    } else {
      pageRows = workingSet.slice(offset, offset + limit);
      total = workingSet.length;
    }

    // Unique company count across the filtered DB-wide set (not just this page)
    const uniqueCompanyCount = latestByCompany.size;

    return NextResponse.json(
      {
        success: true,
        data: {
          analyses: pageRows,
          total,
          uniqueCompanyCount,
          limit,
          offset,
          hasMore: offset + pageRows.length < total,
        },
      },
      { headers: NO_STORE_HEADERS }
    );

  } catch (error) {
    logErrorSafely('library.GET', error);
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
