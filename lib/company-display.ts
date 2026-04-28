// Shared company name → domain mapping and display helpers.
// Used by components/TOSCard.tsx and app/analysis/[id]/page.tsx.
// Behavior chosen: strict startsWith (avoids "Pineapple" → "apple" misses).

export const KNOWN_DOMAINS: Record<string, string> = {
  'google': 'google.com',
  'facebook': 'facebook.com',
  'meta': 'meta.com',
  'amazon': 'amazon.com',
  'apple': 'apple.com',
  'microsoft': 'microsoft.com',
  'netflix': 'netflix.com',
  'spotify': 'spotify.com',
  'twitter': 'twitter.com',
  'x': 'x.com',
  'linkedin': 'linkedin.com',
  'instagram': 'instagram.com',
  'whatsapp': 'whatsapp.com',
  'tiktok': 'tiktok.com',
  'snapchat': 'snapchat.com',
  'discord': 'discord.com',
  'slack': 'slack.com',
  'zoom': 'zoom.com',
  'zoom communications': 'zoom.com',
  'dropbox': 'dropbox.com',
  'adobe': 'adobe.com',
  'salesforce': 'salesforce.com',
  'shopify': 'shopify.com',
  'stripe': 'stripe.com',
  'paypal': 'paypal.com',
  'uber': 'uber.com',
  'airbnb': 'airbnb.com',
  'reddit': 'reddit.com',
  'pinterest': 'pinterest.com',
  'twitch': 'twitch.tv',
  'github': 'github.com',
  'gitlab': 'gitlab.com',
  'atlassian': 'atlassian.com',
  'jira': 'atlassian.com',
  'notion': 'notion.so',
  'figma': 'figma.com',
  'canva': 'canva.com',
  'openai': 'openai.com',
  'anthropic': 'anthropic.com',
  'oracle': 'oracle.com',
  'ibm': 'ibm.com',
  'samsung': 'samsung.com',
  'sony': 'sony.com',
  'nintendo': 'nintendo.com',
  'steam': 'steampowered.com',
  'valve': 'valvesoftware.com',
  'epic': 'epicgames.com',
  'walmart': 'walmart.com',
  'target': 'target.com',
  'ebay': 'ebay.com',
  'etsy': 'etsy.com',
  'doordash': 'doordash.com',
  'grubhub': 'grubhub.com',
  'lyft': 'lyft.com',
  'jibe': 'jibe.com',
  'jibe mobile': 'jibe.com',
};

export function getCompanyDomain(name: string | null | undefined): string | null {
  if (!name) return null;

  const normalized = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (!normalized) return null;
  const firstWord = normalized.split(/\s+/)[0] ?? '';

  if (KNOWN_DOMAINS[normalized]) return KNOWN_DOMAINS[normalized];
  if (firstWord && KNOWN_DOMAINS[firstWord]) return KNOWN_DOMAINS[firstWord];

  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    if (normalized.startsWith(key) || key === firstWord) return domain;
  }

  if (firstWord.length > 2) return `${firstWord}.com`;
  return null;
}

export function getInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
