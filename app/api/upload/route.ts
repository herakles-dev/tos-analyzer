/**
 * PDF Upload Endpoint
 * POST /api/upload
 * 
 * Handles PDF file uploads and extracts text content
 * Features:
 * - File validation (magic bytes, size limits)
 * - PDF text extraction
 * - Returns extracted text for analysis
 */

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Worker } from 'worker_threads';
import { formatError, sanitizeFilename, getClientIP, rateLimitKey, logErrorSafely } from '@/lib/utils';
import { checkUploadRateLimit, getRateLimitInfo, CACHE_KEYS } from '@/lib/redis';

// Aligned with nginx client_max_body_size (5MB). Was 10MB → cosmetic mismatch
// with nginx; nginx 413s first anyway, but keep the app honest.
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['application/pdf'];

// Hard caps for pdf-parse. A bombed PDF can stall the parser for minutes
// or claim millions of pages; bound both axes.
const MAX_PDF_PAGES = 500;
const PDF_PARSE_TIMEOUT_MS = 30_000;

// Worker source: parses the PDF in an isolated thread so a CPU-bound or
// memory-leaky pdf-parse run can't block the main event loop or OOM the
// whole process. On timeout the parent calls worker.terminate(), which is
// a hard kill regardless of what the worker is doing internally.
//
// Embedded as `eval: true` rather than a separate file so Next.js standalone
// bundling stays simple — the worker still resolves pdf-parse via the
// runtime node_modules tree.
const PDF_WORKER_SOURCE = `
  const { parentPort, workerData } = require('worker_threads');
  const pdf = require('pdf-parse');
  (async () => {
    try {
      const data = await pdf(workerData.buffer, { max: workerData.max });
      parentPort.postMessage({ ok: true, text: data.text, numpages: data.numpages });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: (err && err.message) ? err.message : String(err) });
    }
  })();
`;

interface PdfParseResult {
  text: string;
  numpages: number;
}

function parsePdfInWorker(buffer: Buffer, max: number, timeoutMs: number): Promise<PdfParseResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PDF_WORKER_SOURCE, {
      eval: true,
      workerData: { buffer, max },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {}).finally(fn);
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('PDF parse timed out — file may be malformed or oversized')));
    }, timeoutMs);

    worker.on('message', (msg: { ok: boolean; text?: string; numpages?: number; error?: string }) => {
      clearTimeout(timer);
      if (msg.ok && typeof msg.text === 'string' && typeof msg.numpages === 'number') {
        finish(() => resolve({ text: msg.text!, numpages: msg.numpages! }));
      } else {
        finish(() => reject(new Error(msg.error || 'PDF parse failed in worker')));
      }
    });
    worker.on('error', (err) => {
      clearTimeout(timer);
      finish(() => reject(err));
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        clearTimeout(timer);
        finish(() => reject(new Error(`PDF parse worker exited with code ${code}`)));
      }
    });
  });
}

export async function POST(request: NextRequest) {
  let tempFilePath: string | null = null;

  try {
    // Rate limiting — keyed on rateLimitKey() so IPv6 attackers can't rotate
    // within their /64 prefix to bypass per-IP caps. Cap is 3/min to match
    // nginx. Uses its OWN Redis key namespace so 3 uploads don't eat into
    // the user's 10/min analyze quota.
    const clientIP = getClientIP(request.headers);
    const rlKey = rateLimitKey(clientIP);
    const rateLimitExceeded = await checkUploadRateLimit(rlKey, 3);
    const rateLimitInfo = await getRateLimitInfo(rlKey, 3, CACHE_KEYS.RATE_LIMIT_UPLOAD);
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

    // Get form data
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        formatError('No file provided', 'NO_FILE'),
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        formatError(
          `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
          'FILE_TOO_LARGE'
        ),
        { status: 400 }
      );
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json(
        formatError('Invalid file type. Only PDF files are allowed.', 'INVALID_FILE_TYPE'),
        { status: 400 }
      );
    }

    // Read file buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Validate PDF magic bytes (PDF files start with %PDF)
    const magicBytes = buffer.slice(0, 4).toString();
    if (!magicBytes.startsWith('%PDF')) {
      return NextResponse.json(
        formatError('Invalid PDF file. File does not appear to be a valid PDF.', 'INVALID_PDF'),
        { status: 400 }
      );
    }

    // Save to temporary file
    const sanitized = sanitizeFilename(file.name);
    const timestamp = Date.now();
    const filename = `${timestamp}-${sanitized}`;
    tempFilePath = join(tmpdir(), filename);

    await writeFile(tempFilePath, buffer);

    // Extract text in an isolated worker thread. Page cap + wall-clock timeout
    // both enforced; on timeout the worker is hard-terminated so a CPU-bound
    // pdf-parse loop can't pin the main event loop.
    const data = await parsePdfInWorker(buffer, MAX_PDF_PAGES, PDF_PARSE_TIMEOUT_MS);

    if (data.numpages > MAX_PDF_PAGES) {
      return NextResponse.json(
        formatError(
          `PDF has too many pages (${data.numpages}). Maximum ${MAX_PDF_PAGES} pages.`,
          'PDF_TOO_MANY_PAGES'
        ),
        { status: 400, headers: rateLimitHeaders }
      );
    }

    const extractedText = data.text;

    // Clean up temporary file
    await unlink(tempFilePath);
    tempFilePath = null;

    // Validate extracted text
    if (!extractedText || extractedText.trim().length < 50) {
      return NextResponse.json(
        formatError(
          'Could not extract sufficient text from PDF. The file may be empty or contain only images.',
          'EXTRACTION_FAILED'
        ),
        { status: 400 }
      );
    }

    // Don't echo back the user-supplied filename — use the sanitized form,
    // since file.name can contain control chars / unicode tricks.
    return NextResponse.json({
      success: true,
      data: {
        text: extractedText,
        filename: sanitized,
        size: file.size,
        pages: data.numpages,
        word_count: extractedText.trim().split(/\s+/).length,
      },
    }, { headers: rateLimitHeaders });

  } catch (error) {
    logErrorSafely('upload.POST', error, { endpoint: '/api/upload' });

    // Clean up temporary file if it exists
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (unlinkError) {
        logErrorSafely('upload.POST.cleanup', unlinkError);
      }
    }

    const isDev = process.env.NODE_ENV === 'development';
    return NextResponse.json(
      formatError(
        isDev && error instanceof Error ? error.message : 'Internal server error',
        'UPLOAD_ERROR'
      ),
      { status: 500 }
    );
  }
}
