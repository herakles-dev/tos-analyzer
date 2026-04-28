/**
 * Utility Functions
 * Text normalization, hashing, validation, etc.
 */

import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind class name utility
 * Merges Tailwind classes safely
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Control + bidi + zero-width characters that are invisible to humans but can
// be used for cache-bypass, visual spoofing, or prompt-injection smuggling.
// Stripped from both hash inputs and AI output. Exported so other modules
// share the same definition (DRY + tamper-resistant).
//
// Ranges (using Unicode escape sequences for legibility):
//   U+0000–U+001F  C0 control codes (NUL, BEL, BS, ESC, ...)
//   U+007F–U+009F  DEL + C1 control codes
//   U+200B–U+200F  zero-width space, ZWNJ, ZWJ, LRM, RLM
//   U+202A–U+202E  bidi overrides (LRE, RLE, PDF, LRO, RLO) — visual spoofing
//   U+2066–U+2069  bidi isolates (LRI, RLI, FSI, PDI)
//   U+FEFF         byte-order mark / ZWNBSP
export const INVISIBLE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Normalize text content for display dedup (NOT cache hashing).
 * Aggressive: collapses digit runs and strips most special chars.
 *
 * SEMANTIC NOTE: collapsing digits means "minimum age 13" and "minimum age 21"
 * normalize to the same string. Use normalizeForHash() for cache keys instead,
 * which preserves digits and gives stronger semantic uniqueness.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')                              // canonicalize compatibility forms
    .replace(INVISIBLE_CHARS_RE, '')                // strip control / bidi / zero-width
    .toLowerCase()
    .replace(/\s+/g, ' ')                           // collapse whitespace runs
    .replace(/\d+/g, '0')                           // collapse digit runs (defeats numeric padding)
    .replace(/[^\w\s.,!?;:()\-]/g, '')              // drop remaining special chars
    .trim();
}

/**
 * Canonical form for content hashing (cache key).
 * Strong enough to defeat whitespace/case/bidi/Unicode-form padding attacks
 * but PRESERVES DIGITS so semantically distinct documents hash differently.
 * (TOS frequently contain meaningful numerics: ages, dates, fees, etc.)
 */
export function normalizeForHash(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_CHARS_RE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.,!?;:()\-]/g, '')
    .trim();
}

/**
 * Sanitize an AI-generated free-text string before storing or rendering.
 * Strips invisible/bidi/control chars (visual spoofing defense), normalizes
 * Unicode, and length-caps. Use on all AI free-text fields that flow to users:
 * explanations, takeaways, rejection reasons, etc.
 */
export function sanitizeAIText(value: unknown, maxLength = 2000): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_CHARS_RE, '')
    .slice(0, maxLength)
    .trim();
}

/**
 * Log an error without leaking user content. Only the error class name,
 * a length-capped sanitized message, and an optional context dict are
 * recorded. Stack traces are kept only in development.
 *
 * Pasted TOS text gets included in error.message by some libraries
 * (Prisma echoes input on constraint violations, Zod includes the bad
 * value, Gemini API errors quote the prompt). We never want any of that
 * showing up in Loki.
 */
export function logErrorSafely(
  scope: string,
  error: unknown,
  context: Record<string, string | number | boolean | null | undefined> = {}
): void {
  const isDev = process.env.NODE_ENV === 'development';
  const name = error instanceof Error ? error.constructor.name : 'UnknownError';
  // Cap and strip control chars from the message so a multi-MB stack-as-message
  // doesn't flood logs. We never include the raw .stack in production.
  const rawMsg = error instanceof Error ? error.message : String(error);
  const safeMsg = rawMsg
    .replace(INVISIBLE_CHARS_RE, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 200);
  const payload = { scope, name, msg: safeMsg, ...context };
  if (isDev && error instanceof Error && error.stack) {
    console.error('[error]', JSON.stringify(payload), '\n', error.stack.split('\n').slice(0, 5).join('\n'));
  } else {
    console.error('[error]', JSON.stringify(payload));
  }
}

/**
 * Generate SHA-256 hash of normalized content for cache keys / duplicate
 * detection. Uses normalizeForHash() (preserves digits) so semantically
 * distinct documents produce distinct hashes.
 */
export function hashContent(text: string): string {
  const normalized = normalizeForHash(text);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate session hash (anonymized user identifier)
 * Combines IP + User-Agent + Salt for privacy
 */
export function generateSessionHash(ip: string, userAgent: string): string {
  const salt = process.env.SESSION_SALT;
  if (!salt) {
    throw new Error('SESSION_SALT environment variable is required');
  }
  const combined = `${ip}:${userAgent}:${salt}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Count characters in text (excluding whitespace)
 */
export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

/**
 * Validate TOS text input
 * Returns error message if invalid, null if valid
 */
export function validateTOSText(text: string): string | null {
  if (!text || typeof text !== 'string') {
    return 'Text is required';
  }

  const trimmed = text.trim();

  if (trimmed.length < 50) {
    return 'Text is too short (minimum 50 characters)';
  }

  // Lowered from 500k → 200k chars and 50k → 30k words to cap cost amplification.
  // A 30k-word doc still requires 0–1 chunk (chunk threshold is 40k words).
  // Anything above this is almost certainly an attempted abuse vector or a
  // real document that should be summarized to its TOS section before pasting.
  if (trimmed.length > 200000) {
    return 'Text is too long (maximum 200,000 characters)';
  }

  const wordCount = countWords(trimmed);
  if (wordCount < 10) {
    return 'Text is too short (minimum 10 words)';
  }

  if (wordCount > 30000) {
    return 'Text is too long (maximum 30,000 words). Please trim to the relevant TOS section.';
  }

  return null;
}

/**
 * Validate URL format
 */
export function validateURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Format date for display
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Calculate expiry date (30 days from now)
 */
export function calculateExpiryDate(days: number = 30): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Check if analysis is expired
 */
export function isExpired(expiresAt: Date | string): boolean {
  const expiry = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  return expiry < new Date();
}

/**
 * Sanitize filename for safe storage
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 255);
}

/**
 * Sanitize a company name for safe storage and display.
 * Strips HTML tags, allows only characters legitimate in company names.
 */
export function sanitizeCompanyName(name: string): string {
  return name
    .replace(/<[^>]*>/g, '')                           // Strip HTML tags
    .replace(/[^a-zA-Z0-9\s.,&'()\-+@!]/g, '')       // Allow safe chars only
    .trim()
    .substring(0, 200);
}

/**
 * Normalize company name for de-duplication and version matching.
 * "Pandora Media, LLC" and "Pandora Media Inc" → "pandora media"
 */
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|sa|s\.a|plc|holdings|group|platforms?|media|communications?|technologies|tech|software|systems?)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get client IP from request headers
 * Uses X-Real-IP (set by nginx) as primary — cannot be spoofed by clients.
 * Falls back to LAST entry in X-Forwarded-For (appended by trusted nginx proxy).
 * NEVER use the FIRST X-Forwarded-For entry — it's client-controlled and spoofable.
 */
export function getClientIP(headers: Headers): string {
  // Prefer X-Real-IP — set by nginx from $remote_addr, not spoofable
  const realIP = headers.get('x-real-ip');
  if (realIP) {
    return realIP.trim();
  }

  // Fallback: use LAST X-Forwarded-For entry (added by our trusted nginx)
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map(s => s.trim());
    return parts[parts.length - 1];
  }

  return 'unknown';
}

/**
 * Reduce an IP to the granularity used for rate-limit keying.
 *
 * For IPv4: returns the address unchanged (each /32 is a distinct entity).
 * For IPv6: collapses to the /64 prefix. Residential ISPs typically allocate
 *   a /64 (or larger) to each subscriber, so all 2^64 addresses in that
 *   prefix belong to the same human. Without this collapse, an attacker can
 *   trivially rotate IPv6 addresses within their own prefix to bypass
 *   per-IP rate limits.
 *
 * Returns the original string for unrecognized formats (defensive — we'd
 * rather fail closed at the rate limit than fail open from a parse error).
 */
export function rateLimitKey(ip: string): string {
  if (!ip || ip === 'unknown') return ip || 'unknown';

  // IPv4: a.b.c.d (no colons, no IPv6 prefix)
  if (!ip.includes(':')) return ip;

  // IPv4-mapped IPv6: ::ffff:1.2.3.4 — treat as the underlying IPv4
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) return v4Mapped[1];

  // Standard IPv6: collapse to /64. Be defensive against zone IDs (%) and
  // bracketed forms ([::1]) that nginx generally normalizes out before we
  // see them, but might not.
  let addr = ip.replace(/^\[|\]$/g, '');
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);

  // Expand "::" to the right number of zero groups so we can take the first 4.
  if (addr.includes('::')) {
    const [head, tail] = addr.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return ip; // malformed; fail closed by returning raw
    const zeros = Array(missing).fill('0');
    addr = [...headParts, ...zeros, ...tailParts].join(':');
  }

  const parts = addr.split(':');
  if (parts.length < 4) return ip;
  return parts.slice(0, 4).join(':') + '::/64';
}

/**
 * Format error response
 */
export function formatError(message: string, code: string = 'UNKNOWN_ERROR') {
  return {
    error: message,
    code,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format success response
 */
export function formatSuccess<T>(data: T) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Chunk text into smaller pieces for processing
 * Used when text exceeds Claude's context window
 */
export function chunkText(text: string, maxWords: number = 10000): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  
  return chunks;
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Sleep utility for retries
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff delay calculation
 */
export function calculateBackoff(attempt: number, baseDelay: number = 1000): number {
  return Math.min(baseDelay * Math.pow(2, attempt), 10000);
}

/**
 * Calculate popularity score for library ranking
 * Formula: totalViews + (shareCount * 2)
 * Shares are weighted 2x because they indicate higher engagement
 */
export function calculatePopularityScore(viewCount: number, shareCount: number): number {
  return viewCount + (shareCount * 2);
}

/**
 * Risk score (0-100, lower = friendlier to users).
 * Percent-based so a 5-clause and a 50-clause TOS scale comparably.
 *  - badShare:  red counted 1x, yellow 0.4x  → drives the score up
 *  - goodShare: greens                       → pulls the score down
 *  - criticalPenalty: capped at 4 reds so a single hostile clause can't
 *    sink an otherwise reasonable doc, but stacked criticals still hurt
 *
 * Empty / unrated analyses settle near the midpoint instead of 50-flat.
 */
export function calculateRiskScore(
  redCount: number,
  yellowCount: number,
  greenCount: number
): number {
  const total = redCount + yellowCount + greenCount;
  if (total === 0) return 50;

  const badShare = (redCount + yellowCount * 0.4) / total;
  const goodShare = greenCount / total;
  const criticalPenalty = Math.min(redCount, 4) * 6;

  const raw = 35 + badShare * 70 - goodShare * 25 + criticalPenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Map a risk score (0-100) to a letter grade.
 * Tuned against the live library distribution so good docs can earn A/B
 * without giving hostile docs a free pass.
 */
export function getRiskGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score <= 30) return 'A';
  if (score <= 50) return 'B';
  if (score <= 70) return 'C';
  if (score <= 85) return 'D';
  return 'F';
}
