import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from '../src/classify.js';
import { renderMarkdown, renderJson, verdictLine } from '../src/report.js';

const TRACKERS = {
  domains: {
    'google-analytics.com': { company: 'Google', service: 'Google Analytics', category: 'analytics' },
    'googletagmanager.com': { company: 'Google', service: 'Google Tag Manager', category: 'tag-manager' },
    'facebook.net': { company: 'Meta', service: 'Meta Pixel', category: 'advertising' },
    'facebook.com': { company: 'Meta', service: 'Facebook', category: 'social' },
    'cookielaw.org': { company: 'OneTrust', service: 'OneTrust CMP', category: 'consent-management' },
  },
  cookies: [
    { pattern: '^_ga(_.+)?$', company: 'Google', service: 'Google Analytics', category: 'analytics' },
    { pattern: '^_fbp$', company: 'Meta', service: 'Meta Pixel', category: 'advertising' },
  ],
};

const raw = () => JSON.parse(readFileSync(new URL('./fixtures/raw.json', import.meta.url)));
const result = (mutate = () => {}) => {
  const r = raw();
  mutate(r);
  return classify(r, TRACKERS);
};
const lines = (md) => md.split('\n').filter((l) => l.trim() !== '');
const section = (md, heading) => {
  const start = md.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `missing section ${heading}`);
  const next = md.indexOf('\n## ', start + 3);
  return md.slice(start, next < 0 ? undefined : next);
};

test('title and verdict lead the report', () => {
  const md = renderMarkdown(result());
  const [title, verdict] = lines(md);
  assert.equal(title, '# Consent scan: www.example.com');
  assert.equal(verdict, '**Before any consent was given, this page contacted 4 outside companies and set 3 tracking cookies.**');
});

test('verdictLine is the plain-text verdict for stdout', () => {
  assert.equal(verdictLine(result()), 'Before any consent was given, this page contacted 4 outside companies and set 3 tracking cookies.');
});

test('verdict handles singulars and zero cookies', () => {
  const r = result((x) => {
    x.requests = x.requests.filter((q) => !/facebook|google|cookielaw/.test(q.url));
    x.cookies = [];
  });
  assert.equal(verdictLine(r), 'Before any consent was given, this page contacted 1 outside company.');
});

test('verdict handles tracking cookies with no outside contact', () => {
  const r = result((x) => {
    x.requests = x.requests.slice(0, 2);
    x.cookies = x.cookies.filter((c) => c.name === '_ga');
  });
  assert.equal(verdictLine(r), 'Before any consent was given, this page set 1 tracking cookie.');
});

test('no-findings verdict', () => {
  const r = result((x) => {
    x.requests = x.requests.filter((q) => /example\.com|cookielaw/.test(q.url));
    x.cookies = x.cookies.filter((c) => !c.name.startsWith('_'));
  });
  assert.equal(r.summary.hasFindings, false);
  const md = renderMarkdown(r);
  assert.equal(lines(md)[1], '**No third-party trackers or tracking cookies were detected before consent.**');
});

test('blocked verdict replaces the normal verdict and suggests another VPN server', () => {
  const r = result((x) => { x.title = 'Just a moment...'; });
  assert.equal(verdictLine(r), 'This scan is unreliable: the site showed a bot check instead of the real page.');
  const md = renderMarkdown(r);
  assert.equal(lines(md)[1], '**This scan is unreliable: the site showed a bot check instead of the real page.**');
  assert.match(md, /different VPN server/);
});

test('scan context sentence', () => {
  const md = renderMarkdown(result());
  assert.ok(md.includes('Scanned https://www.example.com/ on 6 Oct 2026, 21:30 UTC, from the Netherlands (browser set to en-GB, Europe/Amsterdam).'), md);
  assert.ok(md.includes("We loaded the page in a fresh browser, didn't click anything, and recorded activity for 10 seconds after the page finished loading."));
});

test('scan context names countries without "the" where appropriate', () => {
  const md = renderMarkdown(result((x) => { x.environment.exitCountry = 'DE'; }));
  assert.ok(md.includes('UTC, from Germany (browser set to'));
});

test('no EU warning for a verified EU scan', () => {
  assert.ok(!renderMarkdown(result()).includes('⚠️'));
});

test('a scan from outside the EU puts the warning right after the verdict', () => {
  const r = result((x) => {
    x.environment.exitCountry = 'US';
    x.environment.exitIp = '8.8.8.8';
  });
  const md = renderMarkdown(r);
  assert.equal(lines(md)[2], '⚠️ This scan did not come from an EU location, so it may not reflect what EU visitors see.');
  assert.ok(md.includes('from the United States'));
});

test('a failed location lookup also warns and says the location is unknown', () => {
  const r = result((x) => {
    x.environment.exitCountry = null;
    x.environment.exitIp = null;
  });
  const md = renderMarkdown(r);
  assert.equal(lines(md)[2], '⚠️ This scan did not come from an EU location, so it may not reflect what EU visitors see.');
  assert.ok(md.includes('from an unknown location'));
});

test('banner section: visible banner', () => {
  const s = section(renderMarkdown(result()), 'Consent banner');
  assert.ok(s.includes('A OneTrust consent banner was found and was visible. Everything below happened while it was still waiting for an answer.'));
});

test('banner section: hidden, global-only, and missing banners', () => {
  const hidden = section(renderMarkdown(result((x) => { x.banner.visible = false; })), 'Consent banner');
  assert.match(hidden, /OneTrust consent banner was found, but it wasn't visible/);
  const global = section(renderMarkdown(result((x) => { x.banner = { detected: true, cmp: 'Generic IAB TCF CMP', visible: null }; })), 'Consent banner');
  assert.match(global, /^A Generic IAB TCF CMP consent tool was detected/m);
  const none = section(renderMarkdown(result((x) => { x.banner = { detected: false, cmp: null, visible: null }; })), 'Consent banner');
  assert.match(none, /didn't recognize a consent banner/);
});

test('who was contacted table', () => {
  const s = section(renderMarkdown(result()), 'Who was contacted');
  assert.ok(s.includes('| Company | What it does | Requests | Scripts loaded | Cookies set |'));
  assert.ok(s.includes('| Google | Analytics, tag management | 2 | 1 | `_ga`, `_ga_ABC123` |'), s);
  assert.ok(s.includes('| Meta | Advertising, social media | 2 | 1 | `_fbp` |'), s);
  assert.ok(s.includes('| OneTrust | Consent management | 1 | 1 | — |'), s);
  assert.ok(s.includes('| Unrecognized third party | — | 1 | 0 | — |'), s);
  assert.match(s, /request/i);
  assert.match(s, /script/i);
});

test('who was contacted with no third parties', () => {
  const s = section(renderMarkdown(result((x) => { x.requests = x.requests.slice(0, 2); })), 'Who was contacted');
  assert.ok(!s.includes('| Company |'));
  assert.match(s, /didn't contact any outside companies/);
});

test('cookies section lists tracking cookies in plain language, then a count of the rest', () => {
  const s = section(renderMarkdown(result()), 'Cookies');
  assert.match(s, /small files/i, 'cookie jargon explained');
  assert.match(s, /`_ga` — Google Analytics, .*lasts 2 years/);
  assert.match(s, /`_fbp` — Meta Pixel, .*lasts 3 months/);
  assert.match(s, /2 other cookies were also set/);
  assert.ok(s.indexOf('_ga') < s.indexOf('other cookies'));
});

test('cookies section: session cookies and no cookies', () => {
  const session = section(renderMarkdown(result((x) => { x.cookies = [{ ...x.cookies[0], expires: -1 }]; })), 'Cookies');
  assert.match(session, /deleted when you close the browser/);
  const none = section(renderMarkdown(result((x) => { x.cookies = []; })), 'Cookies');
  assert.match(none, /No cookies were set/);
});

test('what this means: fixed wording with the caveat', () => {
  for (const r of [result(), result((x) => { x.requests = x.requests.slice(0, 2); x.cookies = []; })]) {
    const s = section(renderMarkdown(r), 'What this means');
    assert.match(s, /strictly necessary/);
    assert.match(s, /not legal advice/);
  }
});

test('limitations include warnings', () => {
  const s = section(renderMarkdown(result((x) => { x.warnings = ["The page didn't finish loading within 30 seconds."]; })), 'Limitations');
  assert.match(s, /One page, one visit, no scrolling or clicking/);
  assert.match(s, /VPN server's location/);
  assert.match(s, /- The page didn't finish loading within 30 seconds\./);
});

test('appendix groups third-party requests by domain with type, status and truncated URL', () => {
  const longUrl = `https://px.mystery-tracker.io/p.gif?${'x'.repeat(200)}`;
  const md = renderMarkdown(result((x) => { x.requests.at(-1).url = longUrl; }));
  const s = section(md, 'Appendix: all third-party requests');
  assert.match(s, /### google-analytics\.com/);
  assert.match(s, /### mystery-tracker\.io/);
  assert.ok(s.includes('fetch, 204'));
  assert.ok(s.includes('image, failed'));
  assert.ok(s.includes(longUrl.slice(0, 119) + '…'));
  assert.ok(!s.includes(longUrl.slice(0, 121)));
  assert.ok(!s.includes('static.example.com'), 'first-party requests are not in the appendix');
});

test('raw tracker URLs appear only in the appendix', () => {
  const md = renderMarkdown(result());
  const appendix = md.indexOf('## Appendix');
  assert.ok(md.indexOf('google-analytics.com/g/collect') > appendix);
  assert.ok(md.indexOf('connect.facebook.net') > appendix);
});

test('report never contains cookie values', () => {
  const md = renderMarkdown(result());
  assert.ok(!md.includes('GA1.1.123.456'));
  assert.ok(!md.includes('secret-session'));
});

test('renderJson is pretty JSON of the result', () => {
  const r = result();
  const json = renderJson(r);
  assert.ok(json.endsWith('\n'));
  assert.deepEqual(JSON.parse(json), r);
});
