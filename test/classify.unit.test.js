import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  registrableDomain, firstPartyDomains, partyOf, matchTrackerDomain, matchTrackerCookie,
  detectBlocked, classify, loadTrackers, CATEGORIES,
} from '../src/classify.js';

const raw = () => JSON.parse(readFileSync(new URL('./fixtures/raw.json', import.meta.url)));

const TRACKERS = {
  domains: {
    'google-analytics.com': { company: 'Google', service: 'Google Analytics', category: 'analytics' },
    'googletagmanager.com': { company: 'Google', service: 'Google Tag Manager', category: 'tag-manager' },
    'facebook.net': { company: 'Meta', service: 'Meta Pixel', category: 'advertising' },
    'facebook.com': { company: 'Meta', service: 'Facebook', category: 'social' },
    'cookielaw.org': { company: 'OneTrust', service: 'OneTrust CMP', category: 'consent-management' },
    'ads.example-cdn.com': { company: 'AdCo', service: 'AdCo Ads', category: 'advertising' },
    'example-cdn.com': { company: 'CdnCo', service: 'CdnCo CDN', category: 'cdn' },
  },
  cookies: [
    { pattern: '^_ga(_.+)?$', company: 'Google', service: 'Google Analytics', category: 'analytics' },
    { pattern: '^_fbp$', company: 'Meta', service: 'Meta Pixel', category: 'advertising' },
    { pattern: '^_g', company: 'Shadowed', service: 'Never wins over _ga', category: 'other' },
  ],
};

// --- party resolution ---

test('registrableDomain uses eTLD+1', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
});

test('registrableDomain handles multi-part TLDs', () => {
  assert.equal(registrableDomain('shop.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('bbc.co.uk'), 'bbc.co.uk');
});

test('registrableDomain falls back to the full host for IPs and localhost', () => {
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('[::1]'), '[::1]');
});

test('firstPartyDomains combines input and final URL, deduplicated', () => {
  assert.deepEqual(firstPartyDomains('https://example.com/', 'https://www.example.com/'), ['example.com']);
  assert.deepEqual(firstPartyDomains('https://old.co.uk/', 'https://www.new.com/x'), ['old.co.uk', 'new.com']);
});

test('partyOf: subdomains of a first-party domain are first-party', () => {
  const fp = ['example.com'];
  assert.equal(partyOf('cdn.static.example.com', fp), 'first');
  assert.equal(partyOf('example.com', fp), 'first');
  assert.equal(partyOf('example.com.evil.net', fp), 'third');
  assert.equal(partyOf('notexample.com', fp), 'third');
});

test('partyOf: sibling domains under a multi-part TLD are third-party', () => {
  assert.equal(partyOf('www.bbc.co.uk', ['bbc.co.uk']), 'first');
  assert.equal(partyOf('www.itv.co.uk', ['bbc.co.uk']), 'third');
});

test('partyOf: localhost vs 127.0.0.1 are different parties', () => {
  assert.equal(partyOf('localhost', ['localhost']), 'first');
  assert.equal(partyOf('127.0.0.1', ['localhost']), 'third');
});

// --- tracker matching ---

test('matchTrackerDomain matches exact keys and subdomains', () => {
  assert.equal(matchTrackerDomain('google-analytics.com', TRACKERS).service, 'Google Analytics');
  assert.equal(matchTrackerDomain('www.google-analytics.com', TRACKERS).service, 'Google Analytics');
});

test('matchTrackerDomain does not match lookalike suffixes', () => {
  assert.equal(matchTrackerDomain('notgoogle-analytics.com', TRACKERS), null);
  assert.equal(matchTrackerDomain('google-analytics.com.evil.net', TRACKERS), null);
});

test('matchTrackerDomain: longest matching key wins', () => {
  assert.equal(matchTrackerDomain('x.ads.example-cdn.com', TRACKERS).company, 'AdCo');
  assert.equal(matchTrackerDomain('img.example-cdn.com', TRACKERS).company, 'CdnCo');
});

test('matchTrackerDomain returns a copy without extra fields', () => {
  assert.deepEqual(matchTrackerDomain('connect.facebook.net', TRACKERS), { company: 'Meta', service: 'Meta Pixel', category: 'advertising' });
});

test('matchTrackerCookie: first matching pattern wins', () => {
  assert.equal(matchTrackerCookie('_ga', TRACKERS).company, 'Google');
  assert.equal(matchTrackerCookie('_ga_ABC123', TRACKERS).company, 'Google');
  assert.equal(matchTrackerCookie('_gid', TRACKERS).company, 'Shadowed');
  assert.equal(matchTrackerCookie('_fbp', TRACKERS).company, 'Meta');
  assert.equal(matchTrackerCookie('sessionid', TRACKERS), null);
});

// --- bot checks ---

test('detectBlocked: blocking status codes', () => {
  for (const s of [403, 429, 503]) {
    const r = detectBlocked({ mainStatus: s, title: 'Shop', presentSelectors: [] });
    assert.equal(r.detected, true);
    assert.match(r.reason, new RegExp(String(s)));
  }
  assert.equal(detectBlocked({ mainStatus: 404, title: 'Shop', presentSelectors: [] }).detected, false);
});

test('detectBlocked: challenge titles', () => {
  for (const t of ['Just a moment...', 'Attention Required! | Cloudflare', 'Access Denied', 'Checking your browser', 'Please verify you are human']) {
    const r = detectBlocked({ mainStatus: 200, title: t, presentSelectors: [] });
    assert.equal(r.detected, true, t);
    assert.match(r.reason, /title/i);
  }
});

test('detectBlocked: the title is quoted as a code span, and a backtick in it cannot close the span', () => {
  const r = detectBlocked({ mainStatus: 200, title: 'Just a moment` [x](https://evil.example/)', presentSelectors: [] });
  assert.equal(r.reason, 'The page title `Just a moment%60 [x](https://evil.example/)` looks like a bot check.');
});

test('detectBlocked: challenge selectors', () => {
  const r = detectBlocked({ mainStatus: 200, title: 'Shop', presentSelectors: ['#px-captcha'] });
  assert.equal(r.detected, true);
  assert.match(r.reason, /#px-captcha/);
});

test('detectBlocked: a normal page is not blocked', () => {
  assert.deepEqual(detectBlocked({ mainStatus: 200, title: 'Example shop', presentSelectors: [] }), { detected: false, reason: null });
});

// --- full classification ---

test('classify: requests get host, domain, party, tracker', () => {
  const r = classify(raw(), TRACKERS);
  const ga = r.requests.find((q) => q.host === 'www.google-analytics.com');
  assert.equal(ga.domain, 'google-analytics.com');
  assert.equal(ga.party, 'third');
  assert.deepEqual(ga.tracker, { company: 'Google', service: 'Google Analytics', category: 'analytics' });
  assert.equal(ga.status, 204);
  assert.equal(ga.msSinceStart, 812);
  const own = r.requests.find((q) => q.host === 'static.example.com');
  assert.equal(own.party, 'first');
  assert.equal(own.tracker, null);
  const mystery = r.requests.find((q) => q.host === 'px.mystery-tracker.io');
  assert.equal(mystery.party, 'third');
  assert.equal(mystery.tracker, null);
});

test('classify: every request is kept, first-party included', () => {
  const r = classify(raw(), TRACKERS);
  assert.equal(r.requests.length, raw().requests.length);
});

test('classify: cookies drop values and resolve party, tracker, expiry', () => {
  const r = classify(raw(), TRACKERS);
  for (const c of r.cookies) assert.ok(!('value' in c), `${c.name} has a value`);
  assert.ok(!JSON.stringify(r).includes('secret-session'));
  const ga = r.cookies.find((c) => c.name === '_ga');
  assert.equal(ga.party, 'first');
  assert.equal(ga.tracker.service, 'Google Analytics');
  assert.equal(ga.expires, new Date(1854394200 * 1000).toISOString());
  const session = r.cookies.find((c) => c.name === 'sessionid');
  assert.equal(session.expires, null);
  assert.equal(session.tracker, null);
});

test('classify: first-party tracking cookies are flagged', () => {
  const r = classify(raw(), TRACKERS);
  assert.deepEqual(r.cookies.filter((c) => c.tracker).map((c) => c.name).sort(), ['_fbp', '_ga', '_ga_ABC123']);
  assert.equal(r.summary.trackingCookies, 3);
  assert.equal(r.summary.cookies, 5);
});

test('classify: companies group third parties only', () => {
  const r = classify(raw(), TRACKERS);
  const names = r.companies.map((c) => c.company);
  assert.ok(!names.includes('example.com'));
  const google = r.companies.find((c) => c.company === 'Google');
  assert.deepEqual(google.services, ['Google Analytics', 'Google Tag Manager']);
  assert.deepEqual(google.categories, ['analytics', 'tag-manager']);
  assert.deepEqual(google.domains, ['google-analytics.com', 'googletagmanager.com']);
  assert.equal(google.requests, 2);
  assert.equal(google.scripts, 1);
  assert.deepEqual(google.cookies, ['_ga', '_ga_ABC123']);
  const meta = r.companies.find((c) => c.company === 'Meta');
  assert.equal(meta.requests, 2);
  assert.deepEqual(meta.cookies, ['_fbp']);
  const unknown = r.companies.find((c) => c.company === 'Unrecognized');
  assert.deepEqual(unknown.domains, ['mystery-tracker.io']);
  assert.deepEqual(unknown.services, []);
  assert.deepEqual(unknown.categories, []);
});

test('classify: companies are sorted by request count, Unrecognized last', () => {
  const r = classify(raw(), TRACKERS);
  assert.equal(r.companies.at(-1).company, 'Unrecognized');
  const counts = r.companies.slice(0, -1).map((c) => c.requests);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('classify: summary counts', () => {
  const r = classify(raw(), TRACKERS);
  assert.deepEqual(r.summary, {
    hasFindings: true,
    thirdPartyRequests: 6,
    thirdPartyDomains: 6,
    companies: 4, // Google, Meta, OneTrust + one unrecognized domain
    thirdPartyScripts: 3,
    cookies: 5,
    trackingCookies: 3,
  });
});

test('classify: carries metadata through in JSON-output shape', () => {
  const r = classify(raw(), TRACKERS);
  assert.deepEqual(r.tool, { name: 'consent-scanner', version: '0.1.0' });
  assert.equal(r.scannedAt, '2026-10-06T21:30:00.000Z');
  assert.deepEqual(r.input, raw().input);
  assert.deepEqual(r.environment, raw().environment);
  assert.deepEqual(r.firstPartyDomains, ['example.com']);
  assert.deepEqual(r.banner, { detected: true, cmp: 'OneTrust', visible: true });
  assert.deepEqual(r.blocked, { detected: false, reason: null });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(Object.keys(r), ['tool', 'scannedAt', 'input', 'environment', 'blocked', 'firstPartyDomains', 'warnings', 'banner', 'summary', 'companies', 'requests', 'cookies']);
});

test('classify: blocked pages are detected from raw signals', () => {
  const x = raw();
  x.title = 'Just a moment...';
  x.presentBotSelectors = ['#challenge-form'];
  const r = classify(x, TRACKERS);
  assert.equal(r.blocked.detected, true);
});

// --- findings rules ---

const minimal = (requests, cookies = []) => ({
  ...raw(),
  requests: [
    { url: 'https://www.example.com/', method: 'GET', resourceType: 'document', frameUrl: 'https://www.example.com/', status: 200, failed: false, msSinceStart: 0 },
    ...requests.map((url) => ({ url, method: 'GET', resourceType: 'script', frameUrl: 'https://www.example.com/', status: 200, failed: false, msSinceStart: 5 })),
  ],
  cookies,
});

test('findings: CMP-only third-party traffic produces no findings', () => {
  const r = classify(minimal(['https://cdn.cookielaw.org/a.js', 'https://geolocation.onetrust.cookielaw.org/b']), TRACKERS);
  assert.equal(r.summary.hasFindings, false);
  assert.equal(r.summary.thirdPartyRequests, 2);
  assert.equal(r.companies.length, 1);
});

test('findings: only first-party traffic produces no findings', () => {
  const r = classify(minimal(['https://www.example.com/app.js']), TRACKERS);
  assert.equal(r.summary.hasFindings, false);
  assert.equal(r.summary.thirdPartyRequests, 0);
});

test('findings: an unrecognized third party counts', () => {
  assert.equal(classify(minimal(['https://unknown.io/x.js']), TRACKERS).summary.hasFindings, true);
});

test('findings: a CDN counts (only consent-management is exempt)', () => {
  assert.equal(classify(minimal(['https://img.example-cdn.com/x.js']), TRACKERS).summary.hasFindings, true);
});

test('findings: a first-party tracking cookie alone counts', () => {
  const r = classify(minimal([], [{ name: '_ga', value: 'v', domain: 'www.example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }]), TRACKERS);
  assert.equal(r.summary.hasFindings, true);
});

test('findings: a non-tracking cookie alone does not count', () => {
  const r = classify(minimal([], [{ name: 'lang', value: 'en', domain: 'www.example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }]), TRACKERS);
  assert.equal(r.summary.hasFindings, false);
});

// --- bundled tracker list ---

test('bundled tracker list is well-formed', () => {
  const t = loadTrackers();
  const entries = Object.entries(t.domains);
  assert.ok(entries.length + t.cookies.length >= 55, `only ${entries.length + t.cookies.length} entries`);
  for (const [key, v] of entries) {
    assert.match(key, /^[a-z0-9.-]+\.[a-z]{2,}$/, key);
    assert.ok(v.company && v.service, key);
    assert.ok(CATEGORIES.includes(v.category), `${key}: ${v.category}`);
  }
  for (const c of t.cookies) {
    assert.doesNotThrow(() => new RegExp(c.pattern), c.pattern);
    assert.ok(CATEGORIES.includes(c.category), c.pattern);
  }
});

test('bundled tracker list covers the spec examples and every listed CMP', () => {
  const t = loadTrackers();
  assert.equal(matchTrackerDomain('www.google-analytics.com', t).company, 'Google');
  assert.equal(matchTrackerDomain('cdn.cookielaw.org', t).category, 'consent-management');
  assert.equal(matchTrackerCookie('_ga', t).service, 'Google Analytics');
  assert.equal(matchTrackerCookie('_fbp', t).company, 'Meta');
  assert.ok(matchTrackerCookie('_gcl_au', t));
  for (const host of ['consent.cookiebot.com', 'sdk.privacy-center.org', 'app.usercentrics.eu', 'consent.trustarc.com', 'cmp.quantcast.com', 'fundingchoicesmessages.google.com']) {
    assert.equal(matchTrackerDomain(host, t)?.category, 'consent-management', host);
  }
});
