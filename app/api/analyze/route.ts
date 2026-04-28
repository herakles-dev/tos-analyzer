/**
 * TOS Analysis Endpoint
 * POST /api/analyze
 * 
 * Analyzes Terms of Service text using Gemini AI
 * Features:
 * - Input validation
 * - Rate limiting
 * - Caching (deduplication)
 * - Analytics tracking
 */

export const maxDuration = 300; // 5 minutes for long TOS documents
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  checkRateLimit,
  getRateLimitInfo,
  reserveDailyBudget,
  refundDailyBudget,
  refundMinuteBucket,
  commitTokenUsage,
  checkGlobalTokenBucket,
  acquireContentLock,
  releaseContentLock,
} from '@/lib/redis';
import { geminiAnalyzer } from '@/lib/services/gemini-analyzer';
import crypto from 'crypto';
import {
  validateTOSText,
  hashContent,
  countWords,
  countChars,
  calculateExpiryDate,
  getClientIP,
  rateLimitKey,
  formatError,
  generateSessionHash,
  sanitizeCompanyName,
  logErrorSafely,
} from '@/lib/utils';

// Request validation schema. Char limit lowered from 500k → 200k (Wave 3
// cost amplification cap). validateTOSText() also enforces 30k words.
const AnalyzeRequestSchema = z.object({
  text: z.string().min(50).max(200000),
  source_type: z.enum(['paste', 'upload', 'url']),
  source_url: z.string().url().optional(),
  skip_cache: z.boolean().optional().default(false),
  company_name: z.string().max(200).optional(),
  add_to_library: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  try {
    // Rate limiting — keyed on rateLimitKey() so IPv6 attackers can't rotate
    // within their /64 prefix to bypass per-IP caps.
    const clientIP = getClientIP(request.headers);
    const rlKey = rateLimitKey(clientIP);
    const rateLimit = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '10');
    const rateLimitExceeded = await checkRateLimit(rlKey, rateLimit);
    const rateLimitInfo = await getRateLimitInfo(rlKey, rateLimit);
    const rateLimitHeaders = {
      'X-RateLimit-Limit': rateLimitInfo.limit.toString(),
      'X-RateLimit-Remaining': rateLimitInfo.remaining.toString(),
      'X-RateLimit-Reset': rateLimitInfo.reset.toString(),
    };

    if (rateLimitExceeded) {
      return NextResponse.json(
        formatError('Rate limit exceeded. Please try again later.', 'RATE_LIMIT_EXCEEDED'),
        { status: 429, headers: rateLimitHeaders }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const validationResult = AnalyzeRequestSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        formatError(validationResult.error.errors[0].message, 'VALIDATION_ERROR'),
        { status: 400 }
      );
    }

    const { text, source_type, source_url, company_name, add_to_library } = validationResult.data;
    // skip_cache is always false for anonymous users — prevents API cost abuse
    const skip_cache = false;

    // Additional text validation
    const textError = validateTOSText(text);
    if (textError) {
      return NextResponse.json(
        formatError(textError, 'INVALID_TEXT'),
        { status: 400 }
      );
    }

    // Generate content hash for deduplication
    const contentHash = hashContent(text);
    const wordCount = countWords(text);
    const charCount = countChars(text);

    // Generate creator token for ownership verification on publish
    const creatorToken = crypto.randomBytes(32).toString('hex');
    const creatorTokenHash = crypto
      .createHmac('sha256', process.env.SESSION_SALT || 'tos-analyzer-salt')
      .update(creatorToken)
      .digest('hex');

    // Check if analysis already exists in database
    let existingAnalysis = await prisma.analysis.findUnique({
      where: { contentHash },
    });

    // If exists and not expired, return it
    if (existingAnalysis && new Date(existingAnalysis.expiresAt) > new Date() && !skip_cache) {
      console.log('Returning existing analysis from database');

      // Track analytics event
      const userAgent = request.headers.get('user-agent') || 'unknown';
      const sessionHash = generateSessionHash(clientIP, userAgent);

      // Recompute content warning from the cached analysis so the UI behaves consistently
      const cachedData = existingAnalysis.analysisData as any;
      const cachedIsComplete = cachedData?.document_validation?.is_complete_document !== false;
      const cachedTotalClauses = cachedData?.summary?.total_clauses ?? 0;
      const cachedHasWarning = !cachedIsComplete || cachedTotalClauses < 3;
      const cachedIssues: string[] = [...(cachedData?.document_validation?.content_issues || [])];
      if (cachedTotalClauses < 3 && !cachedIssues.includes('too_short')) {
        cachedIssues.push('too_short');
      }

      await prisma.analyticsEvent.create({
        data: {
          analysisId: existingAnalysis.id,
          eventType: 'analysis_viewed',
          sessionHash,
          metadata: {
            cached: true,
            source_type,
            company_detected: cachedData?.detected_company?.name || null,
            company_confidence: cachedData?.detected_company?.confidence || null,
            document_type: cachedData?.document_validation?.document_type || null,
            content_warning: cachedHasWarning,
          },
        },
      });

      return NextResponse.json({
        success: true,
        data: {
          id: existingAnalysis.id,
          analysis: existingAnalysis.analysisData,
          cached: true,
          created_at: existingAnalysis.createdAt,
          expires_at: existingAnalysis.expiresAt,
          is_public: existingAnalysis.isPublic,
          company_name: existingAnalysis.companyName,
          library_url: existingAnalysis.isPublic ? '/library' : null,
          detected_company: cachedData?.detected_company || null,
          document_type: cachedData?.document_validation?.document_type || null,
          content_warning: cachedHasWarning ? {
            message: !cachedIsComplete
              ? (cachedData?.document_validation?.rejection_reason
                  || "This appears to be an introductory or stub page rather than the full Terms of Service. For best results, paste the complete legal document.")
              : `Only ${cachedTotalClauses} substantive clause${cachedTotalClauses === 1 ? '' : 's'} found. The document may be incomplete.`,
            is_complete_document: cachedIsComplete,
            issues: cachedIssues,
            publish_blocked: false,
          } : null,
        },
      }, { headers: rateLimitHeaders });
    }

    // Estimate tokens before calling Gemini, so we can pre-reserve budget
    // atomically. Formula: input ≈ word_count * 1.5 + system prompt;
    // output ≤ maxOutputTokens (8192). Multiply by chunk count for large docs.
    const chunks = Math.max(1, Math.ceil(wordCount / 40000));
    const estimatedTokens = Math.max(2000, Math.ceil(wordCount * 1.5) + 8192) * chunks;

    // Atomic daily-budget reserve — closes the surge-overshoot race.
    const reserve = await reserveDailyBudget(estimatedTokens);
    if (!reserve.ok) {
      return NextResponse.json(
        formatError('Daily analysis limit reached. Please try again tomorrow.', 'BUDGET_EXCEEDED'),
        { status: 503, headers: rateLimitHeaders }
      );
    }

    // Per-minute global bucket — second line of defense vs distributed/IPv6
    // attackers that bypass per-IP rate limits.
    const minute = await checkGlobalTokenBucket(estimatedTokens);
    if (!minute.ok) {
      // Refund the daily reserve since we're not actually going to call Gemini.
      // Minute bucket already failed-without-incrementing, no minute refund needed.
      await refundDailyBudget(estimatedTokens);
      return NextResponse.json(
        formatError('Service is busy. Please try again in a moment.', 'RATE_LIMIT_GLOBAL'),
        { status: 503, headers: rateLimitHeaders }
      );
    }

    // TOCTOU lock keyed on contentHash. Without this, 50 simultaneous identical
    // requests can all miss the cache and all call Gemini — burning 50x the
    // tokens for the same logical work. The lock briefly serializes identical
    // content so the second-through-Nth caller hits the populated cache.
    // Lock TTL is the shared CONTENT_LOCK_TTL_SECONDS constant, sized to
    // exceed the route's maxDuration (300s).
    const lockToken = await acquireContentLock(contentHash);
    if (!lockToken) {
      // Another request is already analyzing this exact content. Refund and
      // ask the client to retry — the cache will be warm by then.
      await Promise.all([
        refundDailyBudget(estimatedTokens),
        refundMinuteBucket(estimatedTokens),
      ]);
      return NextResponse.json(
        formatError(
          'This document is currently being analyzed. Wait 10–15 seconds and retry — the result will be cached.',
          'CONCURRENT_ANALYSIS'
        ),
        { status: 409, headers: { ...rateLimitHeaders, 'Retry-After': '10' } }
      );
    }

    // Analyze with Gemini. From here until we either commit or refund, the
    // reservation is "in flight" — every exit path MUST reconcile both buckets.
    // committed flag flips true once we've reconciled, so the outer catch
    // doesn't double-refund.
    let cached: boolean = false;
    let result: Awaited<ReturnType<typeof geminiAnalyzer.analyze>>['result'];
    let tokensUsed: number | undefined;
    let reservationCommitted = false;
    try {
      try {
        const out = await geminiAnalyzer.analyze(text, skip_cache);
        result = out.result;
        cached = out.cached;
        tokensUsed = out.tokensUsed;
      } catch (err) {
        // Gemini call failed — return the FULL reservation on both buckets so
        // the failure doesn't permanently consume budget or starve the per-minute
        // window for all users.
        await Promise.all([
          refundDailyBudget(estimatedTokens),
          refundMinuteBucket(estimatedTokens),
        ]);
        reservationCommitted = true;
        throw err;
      }

      // Reconcile reservation. Cache hit at the Gemini layer means no API call;
      // refund both buckets fully. Otherwise true-up daily; minute bucket is
      // an admission-control rate, not a usage meter, so it's NOT trued up.
      if (cached || !tokensUsed) {
        await Promise.all([
          refundDailyBudget(estimatedTokens),
          refundMinuteBucket(estimatedTokens),
        ]);
      } else {
        await commitTokenUsage(estimatedTokens, tokensUsed);
        // Don't refund minute bucket on success — the call did happen and
        // counts against this minute's admission rate.
      }
      reservationCommitted = true;
    } catch (err) {
      // Bubble out for outer catch. Reservation was already refunded above
      // unless commitTokenUsage itself threw, which is fail-soft (Redis errors
      // are caught inside commitTokenUsage). Belt-and-suspenders refund:
      if (!reservationCommitted) {
        await Promise.all([
          refundDailyBudget(estimatedTokens),
          refundMinuteBucket(estimatedTokens),
        ]).catch(() => undefined);
      }
      throw err;
    } finally {
      // Always release the content lock so the next identical request finds
      // a populated cache instead of a held lock waiting for TTL.
      await releaseContentLock(contentHash, lockToken).catch(() => undefined);
    }

    // Validate document is actually a legal document
    if (!result.document_validation.is_legal_document) {
      return NextResponse.json({
        error: `This doesn't appear to be a Terms of Service document. ${result.document_validation.rejection_reason || 'Please upload a legal document (TOS, Privacy Policy, EULA, etc.)'}`,
        code: 'INVALID_DOCUMENT_TYPE',
        metadata: {
          detected_type: result.document_validation.document_type,
          confidence: result.document_validation.confidence,
        }
      }, { status: 400 });
    }

    // Quality gate: detect intro pages, stubs, or documents missing substantive legal content.
    // We still surface the partial analysis to the user, but block library publishing so the
    // public library only contains complete, substantive TOS/policy documents.
    const isCompleteDocument = result.document_validation.is_complete_document !== false;
    const totalClauses = result.summary?.total_clauses ?? 0;
    const isSubstantive = totalClauses >= 3;
    const hasContentWarning = !isCompleteDocument || !isSubstantive;

    const contentIssues: string[] = [...(result.document_validation.content_issues || [])];
    if (!isSubstantive && !contentIssues.includes('too_short')) {
      contentIssues.push('too_short');
    }

    // Force library publishing OFF when content quality is insufficient.
    const allowLibraryPublish = add_to_library && !hasContentWarning;

    // Store or update in database
    const expiresAt = calculateExpiryDate(30);

    const safeName = sanitizeCompanyName(
      company_name || result.detected_company.name || 'Unknown Company'
    );

    if (existingAnalysis) {
      // Update existing
      existingAnalysis = await prisma.analysis.update({
        where: { id: existingAnalysis.id },
        data: {
          analysisData: result as any,
          expiresAt,
          wordCount,
          charCount,
          companyName: safeName,
          isPublic: allowLibraryPublish,
        },
      });
    } else {
      // Create new
      existingAnalysis = await prisma.analysis.create({
        data: {
          contentHash,
          sourceType: source_type,
          sourceUrl: source_url || null,
          analysisData: result as any,
          wordCount,
          charCount,
          expiresAt,
          companyName: safeName,
          isPublic: allowLibraryPublish,
          popularityScore: 0,
          creatorTokenHash,
        },
      });
    }

    // Track analytics event
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const sessionHash = generateSessionHash(clientIP, userAgent);

    await prisma.analyticsEvent.create({
      data: {
        analysisId: existingAnalysis.id,
        eventType: 'analysis_created',
        sessionHash,
        metadata: {
          cached,
          tokens_used: tokensUsed,
          source_type,
          word_count: wordCount,
          company_detected: result.detected_company.name,
          company_confidence: result.detected_company.confidence,
          document_type: result.document_validation.document_type,
          content_warning: hasContentWarning,
          content_issues: contentIssues,
          publish_blocked: add_to_library && !allowLibraryPublish,
        },
      },
    });

    // User-facing message when content quality blocks library publish
    let contentWarningMessage: string | null = null;
    if (hasContentWarning) {
      if (!isCompleteDocument) {
        contentWarningMessage =
          result.document_validation.rejection_reason ||
          "This appears to be an introductory or stub page rather than the full Terms of Service. We've analyzed what's here, but library publishing is disabled. For best results, paste the complete legal document.";
      } else if (!isSubstantive) {
        contentWarningMessage =
          `Only ${totalClauses} substantive clause${totalClauses === 1 ? '' : 's'} found. The document may be incomplete or too short for a meaningful analysis. Library publishing is disabled.`;
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        id: existingAnalysis.id,
        analysis: result,
        cached,
        creator_token: creatorToken,
        created_at: existingAnalysis.createdAt,
        expires_at: existingAnalysis.expiresAt,
        is_public: existingAnalysis.isPublic,
        company_name: existingAnalysis.companyName,
        library_url: existingAnalysis.isPublic ? '/library' : null,
        detected_company: {
          name: result.detected_company.name,
          confidence: result.detected_company.confidence,
          source: result.detected_company.source,
        },
        document_type: result.document_validation.document_type,
        content_warning: hasContentWarning ? {
          message: contentWarningMessage,
          is_complete_document: isCompleteDocument,
          issues: contentIssues,
          publish_blocked: add_to_library && !allowLibraryPublish,
        } : null,
      },
    }, { headers: rateLimitHeaders });

  } catch (error) {
    logErrorSafely('analyze.POST', error, { endpoint: '/api/analyze' });

    // Track error event — store only error class, never the raw message
    // (Prisma/Gemini errors can echo back fragments of the user's input).
    try {
      const clientIP = getClientIP(request.headers);
      const userAgent = request.headers.get('user-agent') || 'unknown';
      const sessionHash = generateSessionHash(clientIP, userAgent);

      await prisma.analyticsEvent.create({
        data: {
          eventType: 'error_occurred',
          sessionHash,
          metadata: {
            error_class: error instanceof Error ? error.constructor.name : 'UnknownError',
            endpoint: '/api/analyze',
          },
        },
      });
    } catch (analyticsError) {
      logErrorSafely('analyze.POST.analytics', analyticsError);
    }

    // Default-deny: only show internals when NODE_ENV is explicitly 'development'.
    // Misconfigured/unset NODE_ENV must not leak stack traces.
    const isDev = process.env.NODE_ENV === 'development';
    return NextResponse.json(
      formatError(
        isDev && error instanceof Error ? error.message : 'Internal server error',
        'ANALYSIS_ERROR'
      ),
      { status: 500 }
    );
  }
}
