export interface SubmitResult {
  ok: boolean;
  id?: string;
  creator_token?: string;
  cached?: boolean;
  error?: string;
  status?: number;
}

const API_BASE = process.env.FINEPRINT_API_BASE || 'http://127.0.0.1:8101';
const SUBMIT_TIMEOUT_MS = 180_000;
const MAX_TEXT_CHARS = 499_000;  // FinePrint API caps at 500,000 — leave 1K headroom
const MAX_WORDS = 49_000;        // Server-side validateTOSText caps at 50,000 words

/**
 * Submit a scraped TOS to FinePrint's /api/analyze endpoint.
 * Adds isPublic=true so it lands in the library, with companyName and sourceUrl.
 * Note: this hits the LOCAL app endpoint (not via fine-print.org through the
 * proxy) so we use the host network, not Proton. That's intentional —
 * submission is not the part we want to disguise.
 */
export async function submitToFinePrint(args: {
  text: string;
  companyName: string;
  sourceUrl: string;
}): Promise<SubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

  let text = args.text.length > MAX_TEXT_CHARS
    ? args.text.slice(0, MAX_TEXT_CHARS)
    : args.text;

  const words = text.split(/\s+/);
  if (words.length > MAX_WORDS) {
    text = words.slice(0, MAX_WORDS).join(' ');
  }

  try {
    const resp = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'fineprint-seed-library/1.0',
      },
      body: JSON.stringify({
        text,
        company_name: args.companyName,
        source_url: args.sourceUrl,
        source_type: 'url',
        add_to_library: true,
      }),
      signal: controller.signal,
    });

    const json: any = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: json?.error || `HTTP ${resp.status}`,
      };
    }

    return {
      ok: true,
      id: json?.data?.id,
      creator_token: json?.data?.creator_token,
      cached: json?.data?.cached,
      status: resp.status,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}
