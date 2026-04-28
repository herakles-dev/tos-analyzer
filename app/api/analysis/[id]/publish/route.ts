/**
 * Publish Analysis to Library Endpoint
 * POST /api/analysis/[id]/publish
 *
 * Makes an existing analysis public and adds it to the library.
 * Requires the creator_token returned at analysis creation time.
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { formatError, getClientIP, rateLimitKey, sanitizeCompanyName, logErrorSafely } from '@/lib/utils';
import { invalidateCache, CACHE_KEYS, checkRateLimit } from '@/lib/redis';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Rate limit write endpoints (10/min per IP)
    const clientIP = getClientIP(request.headers);
    if (await checkRateLimit(rateLimitKey(clientIP))) {
      return NextResponse.json(
        formatError('Rate limit exceeded. Please try again later.', 'RATE_LIMIT_EXCEEDED'),
        { status: 429 }
      );
    }

    const { id } = params;
    const body = await request.json();
    const { company_name, add_to_library, creator_token } = body;

    // Validate inputs
    if (!company_name || typeof company_name !== 'string' || company_name.trim().length === 0) {
      return NextResponse.json(
        formatError('Company name is required', 'INVALID_INPUT'),
        { status: 400 }
      );
    }

    if (company_name.trim().length > 200) {
      return NextResponse.json(
        formatError('Company name too long (max 200 characters)', 'INVALID_INPUT'),
        { status: 400 }
      );
    }

    // Require creator token
    if (!creator_token || typeof creator_token !== 'string') {
      return NextResponse.json(
        formatError('creator_token is required to publish an analysis', 'UNAUTHORIZED'),
        { status: 401 }
      );
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return NextResponse.json(
        formatError('Invalid analysis ID format', 'INVALID_ID'),
        { status: 400 }
      );
    }

    // Fetch the analysis
    const analysis = await prisma.analysis.findUnique({
      where: { id },
    });

    if (!analysis) {
      return NextResponse.json(
        formatError('Analysis not found', 'NOT_FOUND'),
        { status: 404 }
      );
    }

    // Check if expired
    if (new Date(analysis.expiresAt) < new Date()) {
      return NextResponse.json(
        formatError('Analysis has expired', 'EXPIRED'),
        { status: 410 }
      );
    }

    // Verify creator token ownership
    if (!(analysis as any).creatorTokenHash) {
      return NextResponse.json(
        formatError('This analysis cannot be published (no ownership token)', 'FORBIDDEN'),
        { status: 403 }
      );
    }

    const submittedHash = crypto
      .createHmac('sha256', process.env.SESSION_SALT || 'tos-analyzer-salt')
      .update(creator_token)
      .digest('hex');

    // Constant-time compare. The token is 256-bit random hex so brute-force
    // is infeasible regardless, but timing-safe is the right primitive here
    // and prevents future-proofing concerns with shorter-token migrations.
    const storedHash = (analysis as any).creatorTokenHash as string;
    const submittedBuf = Buffer.from(submittedHash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (
      submittedBuf.length !== storedBuf.length ||
      !crypto.timingSafeEqual(submittedBuf, storedBuf)
    ) {
      return NextResponse.json(
        formatError('Invalid creator token', 'UNAUTHORIZED'),
        { status: 401 }
      );
    }

    // Quality gate: block library publishing for intro/stub pages or analyses with too few clauses.
    // Users can still keep the analysis private (add_to_library === false) — only public publishing is gated.
    if (add_to_library === true) {
      const data = analysis.analysisData as any;
      const isCompleteDocument = data?.document_validation?.is_complete_document !== false;
      const totalClauses = data?.summary?.total_clauses ?? 0;
      const isSubstantive = totalClauses >= 3;

      if (!isCompleteDocument || !isSubstantive) {
        const reason = !isCompleteDocument
          ? (data?.document_validation?.rejection_reason
              || "This appears to be an introductory or stub page rather than the full Terms of Service.")
          : `Only ${totalClauses} substantive clause${totalClauses === 1 ? '' : 's'} were found. The library accepts only complete documents.`;

        return NextResponse.json(
          {
            error: `Cannot publish to library: ${reason} For best results, paste the complete legal document and re-analyze.`,
            code: 'INCOMPLETE_DOCUMENT',
            metadata: {
              is_complete_document: isCompleteDocument,
              total_clauses: totalClauses,
              issues: data?.document_validation?.content_issues || [],
            },
          },
          { status: 400 }
        );
      }
    }

    // Update analysis to be public
    const updatedAnalysis = await prisma.analysis.update({
      where: { id },
      data: {
        companyName: sanitizeCompanyName(company_name),
        isPublic: add_to_library === true,
      },
    });

    // Invalidate cache
    await invalidateCache(`${CACHE_KEYS.SHARE}${id}`);
    await invalidateCache('tos:library:*');

    // Track analytics event
    await prisma.analyticsEvent.create({
      data: {
        analysisId: id,
        eventType: 'published_to_library',
        sessionHash: 'system',
        metadata: {
          company_name: sanitizeCompanyName(company_name),
          is_public: add_to_library === true,
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        id: updatedAnalysis.id,
        company_name: updatedAnalysis.companyName,
        is_public: updatedAnalysis.isPublic,
      },
    });

  } catch (error) {
    logErrorSafely('publish.POST', error);
    const isDev = process.env.NODE_ENV === 'development';
    return NextResponse.json(
      formatError(
        isDev && error instanceof Error ? error.message : 'Failed to publish analysis',
        'PUBLISH_ERROR'
      ),
      { status: 500 }
    );
  }
}
