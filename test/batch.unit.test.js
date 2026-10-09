import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from '../src/classify.js';
import { normalizeUrl, parseUrlList, InputError, MAX_BATCH_URLS } from '../src/urls.js';
import { mapWithConcurrency, batchOutcome, BATCH_CONCURRENCY } from '../src/batch.js';
import { renderBatchMarkdown, batchVerdict } from '../src/report.js';

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
const clean = () => result((x) => {
  x.input = { url: 'https://clean.example/', finalUrl: 'https://clean.example/', waitSeconds: 10 };
  x.requests = [{ ...x.requests[0], url: 'https://clean.example/', frameUrl: 'https://clean.example/' }];
  x.cookies = [];
});
const blocked = () => result((x) => {
  x.input = { url: 'https://blocked.example/', finalUrl: 'https://blocked.example/', waitSeconds: 10 };
  x.title = 'Just a moment...';
});

const ok = (r, base) => ({ url: r.input.url, result: r, error: null, files: { json: `${base}.json`, html: `${base}.html` } });
const failed = (url, error) => ({ url, result: null, error, files: null });
const batch = (entries, extra = {}) => ({
  startedAt: '2026-10-08T14:00:00.000Z',
  waitSeconds: 10,
  locale: 'en-GB',
  timezone: 'Europe/Amsterdam',
  exitCountry: 'NL',
  entries,
  ...extra,
});
const section = (md, heading) => {
  const start = md.indexOf(heading);
  assert.ok(start >= 0, `missing ${heading}`);
  const next = md.indexOf('\n## ', start + 3);
  return md.slice(start, next < 0 ? undefined : next);
};

describe('normalizeUrl', () => {
  test('adds https:// when the scheme is missing', () => {
    assert.equal(normalizeUrl('example.com'), 'https://example.com/');
    assert.equal(normalizeUrl('http://example.com/a'), 'http://example.com/a');
  });

  test('rejects invalid and non-http URLs with an InputError', () => {
    assert.throws(() => normalizeUrl('http://exa mple.com'), InputError);
    assert.throws(() => normalizeUrl('ftp://example.com/'), (err) => err instanceof InputError && /http and https/.test(err.message));
  });
});

describe('parseUrlList', () => {
  test('one URL per line, skipping blank lines and # comments', () => {
    const text = '﻿# shops\r\nexample.com\r\n\r\n  https://shop.example/cart  \n# done\n';
    assert.deepEqual(parseUrlList(text), ['https://example.com/', 'https://shop.example/cart']);
  });

  test('drops duplicates after normalizing', () => {
    assert.deepEqual(parseUrlList('example.com\nhttps://example.com/\nexample.com/a'), ['https://example.com/', 'https://example.com/a']);
  });

  test('an invalid line is rejected with its line number', () => {
    assert.throws(() => parseUrlList('# list\nexample.com\nftp://x.example/'), (err) => err instanceof InputError && /^Line 3: /.test(err.message));
  });

  test('a list with no URLs is rejected', () => {
    assert.throws(() => parseUrlList('# nothing here\n\n'), (err) => err instanceof InputError && /no URLs/.test(err.message));
  });

  test(`accepts up to ${MAX_BATCH_URLS} URLs and rejects more`, () => {
    assert.equal(MAX_BATCH_URLS, 10);
    const urls = (n) => Array.from({ length: n }, (_, i) => `site${i}.example`).join('\n');
    assert.equal(parseUrlList(urls(10)).length, 10);
    assert.throws(() => parseUrlList(urls(11)), (err) => err instanceof InputError && /11 URLs/.test(err.message) && /limit is 10/.test(err.message));
  });
});

describe('mapWithConcurrency', () => {
  test('the batch concurrency is 3', () => {
    assert.equal(BATCH_CONCURRENCY, 3);
  });

  test('keeps input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const delays = [30, 5, 20, 1, 15, 5, 10];
    const out = await mapWithConcurrency(delays, 3, async (ms, i) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running -= 1;
      return `${i}:${ms}`;
    });
    assert.deepEqual(out, delays.map((ms, i) => `${i}:${ms}`));
    assert.equal(peak, 3);
  });

  test('handles fewer items than the limit, and none', async () => {
    assert.deepEqual(await mapWithConcurrency([1, 2], 3, async (x) => x * 2), [2, 4]);
    assert.deepEqual(await mapWithConcurrency([], 3, async (x) => x), []);
  });
});

describe('batchOutcome', () => {
  test('error beats blocked beats findings beats clean', () => {
    const f = ok(result(), 'a');
    const c = ok(clean(), 'b');
    const b = ok(blocked(), 'c');
    const e = failed('https://down.example/', "Couldn't load https://down.example/: net::ERR_NAME_NOT_RESOLVED");
    assert.equal(batchOutcome([c, c]), 'clean');
    assert.equal(batchOutcome([c, f]), 'findings');
    assert.equal(batchOutcome([f, b, c]), 'blocked');
    assert.equal(batchOutcome([f, b, e]), 'error');
  });
});

describe('batchVerdict', () => {
  test('counts pages with findings, blocked pages and failed scans', () => {
    assert.equal(batchVerdict([ok(clean(), 'a'), ok(clean(), 'b')]), 'No third-party trackers or tracking cookies were detected before consent on any of the 2 pages.');
    assert.equal(batchVerdict([ok(result(), 'a'), ok(clean(), 'b')]), 'Before any consent was given, 1 of 2 pages contacted outside companies or set tracking cookies.');
    assert.equal(
      batchVerdict([ok(result(), 'a'), ok(result(), 'b'), ok(blocked(), 'c'), failed('https://down.example/', 'nope')]),
      'Before any consent was given, 2 of 4 pages contacted outside companies or set tracking cookies. 1 page showed a bot check instead of the real page. 1 page couldn\'t be scanned.',
    );
  });
});

describe('renderBatchMarkdown', () => {
  const entries = () => [
    ok(result(), 'example.com-20261008-140001'),
    ok(clean(), 'clean.example-20261008-140002'),
    ok(blocked(), 'blocked.example-20261008-140003'),
    failed('https://down.example/', "Couldn't load https://down.example/: net::ERR_NAME_NOT_RESOLVED"),
  ];

  test('title, verdict and scan context lead the report', () => {
    const lines = renderBatchMarkdown(batch(entries())).split('\n').filter((l) => l.trim());
    assert.equal(lines[0], '# Consent scan batch: 4 pages');
    assert.equal(lines[1], `**${batchVerdict(entries())}**`);
    assert.match(lines[2], /^Scanned on 8 Oct 2026, 14:00 UTC, from the Netherlands \(browser set to en-GB, Europe\/Amsterdam\)\./);
    assert.match(lines[2], /10 seconds/);
  });

  test('summary table has one row per URL in input order', () => {
    const s = section(renderBatchMarkdown(batch(entries())), '## Summary');
    const rows = s.split('\n').filter((l) => l.startsWith('|'));
    assert.deepEqual(rows, [
      '| URL | Result | Third parties | Cookies | Scripts before consent |',
      '|---|---|---|---|---|',
      '| `https://example.com/` | Findings | 4 | 5 (3 tracking) | 3 |',
      '| `https://clean.example/` | No findings | 0 | 0 | 0 |',
      // On blocked.example the fixture's example.com requests count as one more third party with a script.
      '| `https://blocked.example/` | Blocked by a bot check | 5 | 5 (3 tracking) | 4 |',
      '| `https://down.example/` | Scan failed | n/a | n/a | n/a |',
    ]);
  });

  test('each URL gets a numbered section with its details and file links', () => {
    const md = renderBatchMarkdown(batch(entries()));
    const first = section(md, '## 1. www.example.com');
    assert.ok(first.includes('`https://example.com/`'), first);
    assert.ok(first.includes('**Before any consent was given, this page contacted 4 outside companies and set 3 tracking cookies.**'));
    assert.ok(first.includes('[example.com-20261008-140001.json](example.com-20261008-140001.json)'));
    assert.ok(first.includes('[example.com-20261008-140001.html](example.com-20261008-140001.html)'));
    assert.match(first, /^### Consent banner$/m);
    assert.match(first, /^### Who was contacted$/m);
    assert.ok(first.includes('| Google | Analytics, tag management | 2 | 1 | `_ga`, `_ga_ABC123` |'));
    assert.match(first, /^### Cookies$/m);
    assert.match(first, /`_ga` — Google Analytics/);
    assert.ok(!first.includes('## Appendix'), 'per-request detail stays in the JSON');
    assert.ok(!first.includes('appendix'), 'no pointer to an appendix the batch report does not have');
    assert.match(first, /\(1 domain, listed in the JSON file\)/);

    assert.match(section(md, '## 2. clean.example'), /No third-party trackers or tracking cookies were detected before consent/);
    const blockedSection = section(md, '## 3. blocked.example');
    assert.match(blockedSection, /This scan is unreliable/);
    assert.match(blockedSection, /looks like a bot check/);
  });

  test('a failed scan gets a section with the error in a code span', () => {
    const s = section(renderBatchMarkdown(batch(entries())), '## 4. down.example');
    assert.ok(s.includes("**This page couldn't be scanned.**"), s);
    assert.ok(s.includes("`Couldn't load https://down.example/: net::ERR_NAME_NOT_RESOLVED`"), s);
    assert.ok(!s.includes('.json]'));
  });

  test('with --save-html, a page whose HTML could not be saved says so', () => {
    const e = ok(result(), 'x');
    e.files.html = null;
    const s = section(renderBatchMarkdown({ ...batch([e]), saveHtml: true }), '## 1. www.example.com');
    assert.match(s, /rendered HTML couldn't be saved/);
  });

  test('without --save-html, a page section links only its JSON and says nothing about HTML', () => {
    const e = ok(result(), 'x');
    e.files.html = null;
    const s = section(renderBatchMarkdown(batch([e])), '## 1. www.example.com');
    assert.ok(s.includes('Full data: [x.json](x.json).'), s);
    assert.doesNotMatch(s, /HTML/);
  });

  test('page warnings are listed in that page\'s section', () => {
    const e = ok(result((x) => { x.warnings = ['The page stopped responding.']; }), 'x');
    const s = section(renderBatchMarkdown(batch([e])), '## 1. www.example.com');
    assert.match(s, /^### Warnings$/m);
    assert.match(s, /^- The page stopped responding\.$/m);
  });

  test('closes with the caveat and limitations, once', () => {
    const md = renderBatchMarkdown(batch(entries()));
    assert.equal(md.split('## What this means').length, 2);
    assert.match(section(md, '## What this means'), /not legal advice/);
    assert.match(section(md, '## Limitations'), /no scrolling or clicking/);
  });

  test('the EU warning appears once, right after the verdict, for a non-EU scan', () => {
    assert.ok(!renderBatchMarkdown(batch(entries())).includes('⚠️'));
    const md = renderBatchMarkdown(batch(entries(), { exitCountry: 'US' }));
    const lines = md.split('\n').filter((l) => l.trim());
    assert.equal(lines[2], '⚠️ This scan did not come from an EU location, so it may not reflect what EU visitors see.');
    assert.equal(md.split('⚠️').length, 2);
  });

  test('a hostile URL cannot break the table or inject a link', () => {
    const url = 'https://a.example/?q=|`[x](https://evil.example/)';
    const md = renderBatchMarkdown(batch([failed(url, 'nope')]));
    const row = md.split('\n').find((l) => l.startsWith('| `https://a.example/'));
    assert.ok(row, md);
    assert.equal(row.split(/(?<!\\)\|/).length - 2, 5, `row should have 5 cells: ${row}`);
    assert.ok(!md.includes('`[x]'), 'backtick in URL escaped');
    assert.ok(!/(^|[^`])\[x\]\(https:\/\/evil/.test(md.replaceAll(/`[^`]*`/g, '')), 'link outside a code span');
  });
});
