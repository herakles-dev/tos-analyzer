import { JSDOM } from 'jsdom';

const STRIP_TAGS = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'iframe', 'noscript', 'form', 'svg', 'button'];
const TOS_HINT_REGEX = /\b(terms|tos|legal|policy|policies|agreement|conditions|use|service)\b/i;

export interface ExtractResult {
  text: string;
  title: string | null;
  reason: 'main' | 'article' | 'best-block' | 'body-fallback';
  charCount: number;
  wordCount: number;
}

/**
 * Extract clean TOS text from raw HTML using DOM heuristics.
 * Strategy:
 *   1. Strip nav/footer/script/style/etc.
 *   2. Prefer <main>, <article>, or the largest content block whose ancestor
 *      hints at TOS/legal content (id/class match).
 *   3. Fall back to the largest remaining text block.
 */
export function extractTosText(html: string, sourceUrl: string): ExtractResult {
  const dom = new JSDOM(html, { url: sourceUrl });
  const doc = dom.window.document;
  const title = doc.querySelector('title')?.textContent?.trim() || null;

  // Remove unwanted tags entirely
  for (const tag of STRIP_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  }

  // Try in priority order
  const candidates: { el: Element; weight: number; reason: ExtractResult['reason'] }[] = [];

  const main = doc.querySelector('main');
  if (main) candidates.push({ el: main, weight: textLen(main) * 1.5, reason: 'main' });

  doc.querySelectorAll('article').forEach((el) => {
    candidates.push({ el, weight: textLen(el) * 1.3, reason: 'article' });
  });

  // Hinted blocks (id/class containing terms-like words)
  doc.querySelectorAll('[id], [class]').forEach((el) => {
    const idClass = `${el.id || ''} ${el.className || ''}`.toLowerCase();
    if (!TOS_HINT_REGEX.test(idClass)) return;
    const len = textLen(el);
    if (len < 1000) return;
    candidates.push({ el, weight: len * 1.2, reason: 'best-block' });
  });

  // Largest text block fallback
  doc.querySelectorAll('div, section').forEach((el) => {
    const len = textLen(el);
    if (len < 2000) return;
    candidates.push({ el, weight: len, reason: 'best-block' });
  });

  candidates.sort((a, b) => b.weight - a.weight);
  const best = candidates[0];
  const chosen = best?.el ?? doc.body;
  const reason = best?.reason ?? 'body-fallback';
  const text = cleanText(chosen.textContent || '');

  return {
    text,
    title,
    reason,
    charCount: text.length,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

function textLen(el: Element): number {
  return (el.textContent || '').replace(/\s+/g, ' ').trim().length;
}

function cleanText(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/ /g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
