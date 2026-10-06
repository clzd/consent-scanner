// Signals that the site served a bot challenge instead of the real page.
export const BOT_CHECKS = {
  statuses: [403, 429, 503],
  title: /just a moment|attention required|access denied|checking your browser|verify you are human/i,
  selectors: [
    '#challenge-form',
    '#cf-challenge-running',
    'iframe[src*="challenges.cloudflare.com"]',
    '#px-captcha',
    '#sec-if-cpt-container',
  ],
};
