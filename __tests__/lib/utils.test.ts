import {
  normalizeText,
  hashContent,
  countWords,
  countChars,
  validateTOSText,
  validateURL,
  extractDomain,
  sanitizeFilename,
  sanitizeCompanyName,
  truncate,
  chunkText,
  calculateBackoff,
  calculatePopularityScore,
  formatError,
  formatSuccess,
  getClientIP,
  isExpired,
  calculateExpiryDate,
} from '@/lib/utils';

describe('normalizeText', () => {
  it('lowercases and trims input', () => {
    expect(normalizeText('  Hello World  ')).toBe('hello world');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeText('hello   world')).toBe('hello world');
  });

  it('collapses newlines into spaces', () => {
    expect(normalizeText('hello\n\nworld')).toBe('hello world');
  });

  it('removes special characters but keeps common punctuation', () => {
    expect(normalizeText('hello! @world#')).toBe('hello! world');
  });
});

describe('hashContent', () => {
  it('returns a 64-char hex string', () => {
    const hash = hashContent('test content');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same hash for equivalent text', () => {
    expect(hashContent('Hello World')).toBe(hashContent('  hello   world  '));
  });

  it('produces different hashes for different text', () => {
    expect(hashContent('hello')).not.toBe(hashContent('world'));
  });
});

describe('countWords', () => {
  it('counts words correctly', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('handles extra whitespace', () => {
    expect(countWords('  hello   world  ')).toBe(2);
  });

  it('returns 0 for empty string', () => {
    expect(countWords('')).toBe(0);
  });
});

describe('countChars', () => {
  it('counts non-whitespace characters', () => {
    expect(countChars('a b c')).toBe(3);
  });
});

describe('validateTOSText', () => {
  it('rejects empty text', () => {
    expect(validateTOSText('')).toBe('Text is required');
  });

  it('rejects too-short text', () => {
    expect(validateTOSText('short')).toBe('Text is too short (minimum 50 characters)');
  });

  it('rejects text with too few words', () => {
    // 50+ chars but less than 10 words
    expect(validateTOSText('a'.repeat(60))).toBe('Text is too short (minimum 10 words)');
  });

  it('accepts valid text', () => {
    const valid = 'This is a valid terms of service document that has enough words and characters to pass validation checks easily.';
    expect(validateTOSText(valid)).toBeNull();
  });
});

describe('validateURL', () => {
  it('accepts https URLs', () => {
    expect(validateURL('https://example.com')).toBe(true);
  });

  it('accepts http URLs', () => {
    expect(validateURL('http://example.com')).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(validateURL('not a url')).toBe(false);
  });

  it('rejects non-http protocols', () => {
    expect(validateURL('ftp://example.com')).toBe(false);
  });
});

describe('extractDomain', () => {
  it('extracts hostname from URL', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('www.example.com');
  });

  it('returns null for invalid URL', () => {
    expect(extractDomain('not-a-url')).toBeNull();
  });
});

describe('sanitizeFilename', () => {
  it('replaces special characters with underscores', () => {
    expect(sanitizeFilename('hello world!.pdf')).toBe('hello_world_.pdf');
  });

  it('collapses multiple underscores', () => {
    expect(sanitizeFilename('a@#$b')).toBe('a_b');
  });

  it('truncates to 255 characters', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeFilename(long).length).toBe(255);
  });
});

describe('sanitizeCompanyName', () => {
  it('strips HTML tags', () => {
    expect(sanitizeCompanyName('<b>Google</b>')).toBe('Google');
  });

  it('allows common company name characters', () => {
    expect(sanitizeCompanyName("AT&T Inc.")).toBe("AT&T Inc.");
  });

  it('truncates to 200 characters', () => {
    const long = 'A'.repeat(250);
    expect(sanitizeCompanyName(long).length).toBe(200);
  });
});

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long text with ellipsis', () => {
    expect(truncate('hello world this is long', 10)).toBe('hello w...');
  });
});

describe('chunkText', () => {
  it('splits text into chunks by word count', () => {
    const words = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(words, 10);
    expect(chunks.length).toBe(3);
  });

  it('returns single chunk for short text', () => {
    expect(chunkText('hello world', 100)).toEqual(['hello world']);
  });
});

describe('calculateBackoff', () => {
  it('doubles delay each attempt', () => {
    expect(calculateBackoff(0, 1000)).toBe(1000);
    expect(calculateBackoff(1, 1000)).toBe(2000);
    expect(calculateBackoff(2, 1000)).toBe(4000);
  });

  it('caps at 10000ms', () => {
    expect(calculateBackoff(10, 1000)).toBe(10000);
  });
});

describe('calculatePopularityScore', () => {
  it('weights shares 2x', () => {
    expect(calculatePopularityScore(100, 50)).toBe(200);
  });
});

describe('formatError', () => {
  it('returns structured error object', () => {
    const result = formatError('Something broke', 'ERR_TEST');
    expect(result.error).toBe('Something broke');
    expect(result.code).toBe('ERR_TEST');
    expect(result.timestamp).toBeDefined();
  });
});

describe('formatSuccess', () => {
  it('returns structured success object', () => {
    const result = formatSuccess({ id: 1 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 1 });
    expect(result.timestamp).toBeDefined();
  });
});

describe('getClientIP', () => {
  it('prefers x-real-ip', () => {
    const headers = new Headers({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' });
    expect(getClientIP(headers)).toBe('1.2.3.4');
  });

  it('falls back to last x-forwarded-for entry', () => {
    const headers = new Headers({ 'x-forwarded-for': '10.0.0.1, 192.168.1.1' });
    expect(getClientIP(headers)).toBe('192.168.1.1');
  });

  it('returns unknown when no IP headers', () => {
    const headers = new Headers({});
    expect(getClientIP(headers)).toBe('unknown');
  });
});

describe('isExpired', () => {
  it('returns true for past dates', () => {
    expect(isExpired(new Date('2020-01-01'))).toBe(true);
  });

  it('returns false for future dates', () => {
    expect(isExpired(new Date('2030-01-01'))).toBe(false);
  });
});

describe('calculateExpiryDate', () => {
  it('returns a date in the future', () => {
    const expiry = calculateExpiryDate(30);
    expect(expiry.getTime()).toBeGreaterThan(Date.now());
  });
});
