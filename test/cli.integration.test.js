import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/consent-scanner.js', import.meta.url));
const INPUT_EVENTS = ['click', 'mousedown', 'mouseup', 'mousemove', 'pointerdown', 'keydown', 'keyup', 'wheel', 'scroll', 'touchstart'];

let first; // serves pages on localhost:<port>
let third; // serves scripts and the ipinfo stub on 127.0.0.1:<port2>
let port;
let port2;
let closedPort;
const inputEvents = [];
let slowInFlight = 0;
let slowPeak = 0;

const listen = (server, host) => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));

before(async () => {
  third = http.createServer((req, res) => {
    const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); };
    if (req.url === '/t.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.__t = 1;'); }
    if (req.url === '/pixel.gif') { res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); }
    if (req.url === '/ipinfo') return json('{"country":"DE","timezone":"Europe/Berlin"}');
    if (req.url === '/ipinfo-us') return json('{"ip":"8.8.8.8","country":"US","timezone":"America/Chicago"}');
    if (req.url === '/ipinfo-bad') return json('<html>nope</html>');
    res.writeHead(404); res.end();
  });
  port2 = await listen(third, '127.0.0.1');

  const listeners = `<script>
    for (const t of ${JSON.stringify(INPUT_EVENTS)}) {
      window.addEventListener(t, () => fetch('/input-event?' + t), { capture: true });
    }
  </script>`;
  const pages = {
    '/tracking': `<!doctype html><title>Shop</title>${listeners}
      <script src="http://127.0.0.1:${port2}/t.js"></script>
      <iframe src="/frame"></iframe><p>Hello</p>`,
    '/frame': `<!doctype html><img src="http://127.0.0.1:${port2}/pixel.gif">`,
    '/clean': `<!doctype html><title>Clean</title>${listeners}<p>Nothing to see</p>`,
    '/challenge': '<!doctype html><title>Just a moment...</title><form id="challenge-form"></form>',
    // Freezes its own main thread right after load, so only the post-wait inspection can hang.
    '/hang': '<!doctype html><title>Hang</title><script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 0));</script>',
    // Adds an element after parsing, so only the rendered DOM contains it.
    '/dynamic': `<!doctype html><title>Dynamic</title>${listeners}<script>
      addEventListener('DOMContentLoaded', () => { const p = document.createElement('p'); p.id = 'added'; p.textContent = 'Added by script'; document.body.append(p); });
    </script><p>Static</p>`,
    '/slow': '<!doctype html><title>Slow</title><p>Slow</p>',
    // Shows a Cookiebot banner, then freezes as soon as detection reads navigator.userAgent, its last step,
    // so only the HTML capture that follows can hang.
    '/freeze-late': `<!doctype html><title>Late freeze</title><div id="CybotCookiebotDialog">Cookies?</div><script>
      const ua = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', { get() { setTimeout(() => { for (;;) {} }, 0); return ua; } });
    </script>`,
  };
  first = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/input-event') { inputEvents.push(req.url); res.writeHead(204); return res.end(); }
    if (!pages[path]) { res.writeHead(404); return res.end(); }
    const headers = { 'content-type': 'text/html' };
    if (path === '/tracking') headers['set-cookie'] = '_ga=GA1.1.999.111; Path=/; Max-Age=63072000';
    if (path === '/slow') {
      // Holds the document open, so the number of scans running at once is visible here.
      slowInFlight += 1;
      slowPeak = Math.max(slowPeak, slowInFlight);
      return setTimeout(() => { slowInFlight -= 1; res.writeHead(200, headers); res.end(pages[path]); }, 1500);
    }
    res.writeHead(200, headers);
    res.end(pages[path]);
  });
  port = await listen(first); // all interfaces, so "localhost" resolves on IPv4 or IPv6

  const probe = http.createServer();
  closedPort = await listen(probe, '127.0.0.1');
  await new Promise((r) => probe.close(r));
});

after(() => {
  first?.close();
  third?.close();
});

function run(args, { ipinfo = '/ipinfo', out = mkdtempSync(join(tmpdir(), 'consent-scanner-')) } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args, '--out', out], {
      env: { ...process.env, CONSENT_SCANNER_IPINFO_URL: `http://127.0.0.1:${port2}${ipinfo}` },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const files = readdirSync(out);
      const read = (ext) => {
        const f = files.find((n) => n.endsWith(ext));
        return f ? readFileSync(join(out, f), 'utf8') : null;
      };
      const md = read('.md');
      const json = read('.json');
      resolve({ code, stdout, stderr, out, files, md, json: json && JSON.parse(json) });
    });
  });
}

const url = (path) => `http://localhost:${port}${path}`;

function urlsFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'consent-scanner-urls-'));
  const file = join(dir, 'urls.txt');
  writeFileSync(file, lines.join('\n'));
  return file;
}

const readOut = (dir, name) => readFileSync(join(dir, name), 'utf8');

describe('CLI scans', { concurrency: true }, () => {
  test('a page with a third-party script and a _ga cookie exits 1', async () => {
    const r = await run([url('/tracking'), '--wait', '0.5']);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.files.length, 2);
    const base = r.files[0].replace(/\.(md|json)$/, '');
    assert.match(base, /^localhost-\d{8}-\d{6}$/);
    assert.deepEqual(r.files.sort(), [`${base}.json`, `${base}.md`]);

    assert.equal(r.json.summary.thirdPartyScripts, 1);
    assert.equal(r.json.summary.trackingCookies, 1);
    assert.equal(r.json.summary.hasFindings, true);
    const script = r.json.requests.find((q) => q.resourceType === 'script' && q.party === 'third');
    assert.equal(script.url, `http://127.0.0.1:${port2}/t.js`);
    assert.equal(script.status, 200);
    const ga = r.json.cookies.find((c) => c.name === '_ga');
    assert.equal(ga.party, 'first');
    assert.equal(ga.tracker.service, 'Google Analytics');
    assert.ok(!JSON.stringify(r.json).includes('GA1.1.999.111'), 'cookie value leaked');

    // iframe traffic is captured because listeners are on the context
    const pixel = r.json.requests.find((q) => q.url.endsWith('/pixel.gif'));
    assert.ok(pixel, 'iframe request missing');
    assert.equal(pixel.frameUrl, url('/frame'));

    // location check results are recorded, and the browser timezone follows the exit IP
    assert.equal(r.json.environment.exitCountry, 'DE');
    assert.equal(r.json.environment.exitTimezone, 'Europe/Berlin');
    assert.equal(r.json.environment.timezone, 'Europe/Berlin');
    assert.equal(r.json.environment.locale, 'en-GB');
    assert.equal(r.json.environment.requireEu, false);
    assert.equal(r.stderr, '', 'no location warning for an EU exit IP');
    assert.ok(r.json.environment.browserVersion);
    assert.ok(r.json.environment.userAgent);

    // stdout: verdict, then both paths
    const out = r.stdout.trim().split('\n');
    assert.equal(out[0], 'Before any consent was given, this page contacted 1 outside company and set 1 tracking cookie.');
    assert.deepEqual(out.slice(1).sort(), [join(r.out, `${base}.json`), join(r.out, `${base}.md`)]);

    assert.match(r.md, /^# Consent scan: localhost$/m);
    assert.ok(r.md.includes(`http://127.0.0.1:${port2}/t.js`), 'third-party script missing from report');
  });

  test('a page with no third-party activity exits 0', async () => {
    const r = await run([url('/clean'), '--wait', '0.5']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.files.length, 2);
    assert.equal(r.json.summary.hasFindings, false);
    assert.equal(r.json.summary.thirdPartyRequests, 0);
    assert.ok(r.json.requests.some((q) => q.resourceType === 'document' && q.party === 'first'));
    assert.equal(r.stdout.split('\n')[0], 'No third-party trackers or tracking cookies were detected before consent.');
  });

  test('a bot-check page exits 3 and still writes both files', async () => {
    const r = await run([url('/challenge'), '--wait', '0.5']);
    assert.equal(r.code, 3, r.stderr);
    assert.equal(r.files.length, 2);
    assert.equal(r.json.blocked.detected, true);
    assert.ok(r.json.blocked.reason);
    assert.match(r.md, /This scan is unreliable/);
  });

  test('a page that freezes itself still finishes, with a warning', { timeout: 20_000 }, async () => {
    const r = await run([url('/hang'), '--wait', '0.5']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.files.length, 2);
    assert.deepEqual(r.json.banner, { detected: false, cmp: null, visible: null });
    assert.equal(r.json.blocked.detected, false);
    assert.ok(r.json.warnings.some((w) => /stopped responding/.test(w)), JSON.stringify(r.json.warnings));
    assert.match(r.md, /stopped responding/);
  });

  test('--save-html on a single URL writes the rendered HTML next to the report and prints its path', async () => {
    const r = await run([url('/dynamic'), '--wait', '0', '--save-html']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.files.length, 3, r.files.join(', '));
    const html = r.files.find((f) => f.endsWith('.html'));
    assert.ok(html, r.files.join(', '));
    assert.match(readOut(r.out, html), /<p id="added">Added by script<\/p>/);
    assert.equal(r.stdout.trim().split('\n').at(-1), join(r.out, html));
    assert.ok(!('html' in r.json), 'HTML is kept out of the JSON');
  });

  test('an explicit --timezone and --locale are applied', async () => {
    const r = await run([url('/clean'), '--wait', '0', '--timezone', 'Europe/Paris', '--locale', 'fr-FR']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.environment.timezone, 'Europe/Paris');
    assert.equal(r.json.environment.locale, 'fr-FR');
    assert.equal(r.json.input.waitSeconds, 0);
  });

  test('by default, a non-EU exit IP still scans, with a warning on stderr and in the report', async () => {
    const r = await run([url('/clean'), '--wait', '0'], { ipinfo: '/ipinfo-us' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^Warning: exit IP 8\.8\.8\.8 is in US, outside the EU\/EEA\/UK/);
    assert.match(r.stderr, /--require-eu/);
    assert.equal(r.stdout.split('\n')[0], 'No third-party trackers or tracking cookies were detected before consent.');
    assert.equal(r.json.environment.requireEu, false);
    assert.equal(r.json.environment.exitCountry, 'US');
    assert.equal(r.json.environment.exitIp, '8.8.8.8');
    assert.equal(r.json.environment.timezone, 'America/Chicago');
    assert.match(r.md, /⚠️ This scan did not come from an EU location/);
  });

  test('by default, a failed lookup still scans and falls back to Europe/Berlin', async () => {
    const r = await run([url('/clean'), '--wait', '0'], { ipinfo: '/ipinfo-bad' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /couldn't verify the scan location/);
    assert.match(r.md, /⚠️ This scan did not come from an EU location/);
    assert.equal(r.json.environment.timezone, 'Europe/Berlin');
    assert.equal(r.json.environment.exitCountry, null);
  });

  test('--require-eu with an EU exit IP scans normally', async () => {
    const r = await run([url('/clean'), '--wait', '0', '--require-eu']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.json.environment.requireEu, true);
    assert.ok(!r.md.includes('⚠️'));
  });

  test('an unreachable URL exits 2 and writes nothing', async () => {
    const r = await run([`http://127.0.0.1:${closedPort}/`, '--wait', '0']);
    assert.equal(r.code, 2);
    assert.deepEqual(r.files, []);
    assert.match(r.stderr, /Couldn't load/);
    assert.equal(r.stdout, '');
  });

  test('a missing scheme gets https:// added', async () => {
    // The local server only speaks http, so the https:// attempt fails — the error names the URL tried.
    const r = await run([`localhost:${port}/clean`, '--wait', '0']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(`https://localhost:${port}/clean`), r.stderr);
  });

  test('--out is created if it does not exist', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'consent-scanner-'));
    const nested = join(parent, 'a', 'b');
    const code = await new Promise((resolve) => {
      spawn(process.execPath, [BIN, url('/clean'), '--wait', '0', '--out', nested], {
        env: { ...process.env, CONSENT_SCANNER_IPINFO_URL: `http://127.0.0.1:${port2}/ipinfo` },
      }).on('close', resolve);
    });
    assert.equal(code, 0);
    assert.equal(readdirSync(nested).length, 2);
  });
});

describe('CLI batch scans', { concurrency: true }, () => {
  test('--urls --save-html scans every URL and writes a JSON and HTML per URL plus one batch report', { timeout: 30_000 }, async () => {
    const list = urlsFile([
      '# pages to scan',
      url('/tracking'),
      '',
      url('/clean'),
      url('/challenge'),
      url('/dynamic'),
      url('/clean'), // duplicate, scanned once
    ]);
    const r = await run(['--urls', list, '--wait', '0.5', '--save-html']);
    assert.equal(r.code, 3, `blocked beats findings\n${r.stderr}`);
    assert.equal(r.stderr, '');

    const reports = r.files.filter((f) => f.endsWith('.md'));
    assert.equal(reports.length, 1, r.files.join(', '));
    assert.match(reports[0], /^batch-\d{8}-\d{6}\.md$/);
    const jsons = r.files.filter((f) => f.endsWith('.json'));
    const htmls = r.files.filter((f) => f.endsWith('.html'));
    assert.equal(jsons.length, 4, r.files.join(', '));
    assert.equal(r.files.length, 9);
    for (const j of jsons) {
      assert.match(j, /^localhost-\d{8}-\d{6}(-\d+)?\.json$/);
      assert.ok(htmls.includes(j.replace(/\.json$/, '.html')), `no HTML next to ${j}`);
    }

    const scans = Object.fromEntries(jsons.map((j) => {
      const data = JSON.parse(readOut(r.out, j));
      assert.ok(!('html' in data), 'HTML is kept out of the JSON');
      return [new URL(data.input.url).pathname, { json: data, html: readOut(r.out, j.replace(/\.json$/, '.html')) }];
    }));
    assert.deepEqual(Object.keys(scans).sort(), ['/challenge', '/clean', '/dynamic', '/tracking']);
    assert.equal(scans['/tracking'].json.summary.thirdPartyScripts, 1);
    assert.equal(scans['/tracking'].json.summary.trackingCookies, 1);
    assert.equal(scans['/challenge'].json.blocked.detected, true);
    assert.match(scans['/tracking'].html, /<p>Hello<\/p>/);
    assert.match(scans['/dynamic'].html, /<p id="added">Added by script<\/p>/, 'HTML is the rendered DOM, not the source');

    // stdout: one line per URL in input order, then the report path.
    const out = r.stdout.trim().split('\n');
    assert.deepEqual(out.slice(0, 4).map((l) => l.split(': ')[0]), [url('/tracking'), url('/clean'), url('/challenge'), url('/dynamic')]);
    assert.equal(out[0], `${url('/tracking')}: Before any consent was given, this page contacted 1 outside company and set 1 tracking cookie.`);
    assert.equal(out.at(-1), join(r.out, reports[0]));

    const md = readOut(r.out, reports[0]);
    assert.match(md, /^# Consent scan batch: 4 pages$/m);
    assert.ok(md.includes('| URL | Result | Third parties | Cookies | Scripts before consent |'));
    const rows = md.split('\n').filter((l) => l.startsWith('| `http'));
    assert.deepEqual(rows.map((l) => l.split('`')[1]), [url('/tracking'), url('/clean'), url('/challenge'), url('/dynamic')]);
    assert.ok(rows[0].includes('| Findings | 1 | 1 (1 tracking) | 1 |'), rows[0]);
    assert.match(md, /^## 1\. localhost$/m);
    assert.match(md, /^## 4\. localhost$/m);
    for (const [, target] of md.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(existsSync(join(r.out, target)), `broken link ${target}`);
    }
  });

  test('scans at most 3 URLs at once', { timeout: 30_000 }, async () => {
    const list = urlsFile([1, 2, 3, 4, 5].map((n) => url(`/slow?${n}`)));
    const r = await run(['--urls', list, '--wait', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(slowPeak, 3);
  });

  test('a page that freezes while its HTML is saved keeps its detection results, and gets no HTML file', { timeout: 30_000 }, async () => {
    const r = await run(['--urls', urlsFile([url('/freeze-late')]), '--wait', '0', '--save-html']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.banner, { detected: true, cmp: 'Cookiebot', visible: true });
    assert.match(r.json.environment.userAgent, /HeadlessChrome|Chrome/, 'detection finished before the freeze');
    assert.ok(r.json.warnings.some((w) => /while we saved its HTML/.test(w)), JSON.stringify(r.json.warnings));
    assert.ok(!r.json.warnings.some((w) => /neither could be detected/.test(w)));
    assert.equal(r.files.filter((f) => f.endsWith('.html')).length, 0, r.files.join(', '));
    assert.match(r.md, /The rendered HTML couldn't be saved/);
  });

  test("existing files in --out are never overwritten, and a taken .html moves the whole pair to the next name", { timeout: 30_000 }, async () => {
    // Fill every name this run could pick in the next minute, the way a second run sharing --out would.
    const out = mkdtempSync(join(tmpdir(), 'consent-scanner-'));
    const now = Date.now();
    for (let s = -2; s <= 60; s++) {
      const ts = new Date(now + s * 1000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      writeFileSync(join(out, `localhost-${ts}.html`), 'other run');
      writeFileSync(join(out, `batch-${ts}.md`), 'other run');
    }
    const before = readdirSync(out).length;
    const r = await run(['--urls', urlsFile([url('/clean')]), '--wait', '0', '--save-html'], { out });
    assert.equal(r.code, 0, r.stderr);
    const added = r.files.length - before;
    assert.equal(added, 3, r.files.join(', '));
    const json = r.files.find((f) => f.endsWith('.json'));
    assert.match(json, /^localhost-\d{8}-\d{6}-2\.json$/);
    assert.match(readOut(out, json.replace(/\.json$/, '.html')), /Nothing to see/);
    const report = r.stdout.trim().split('\n').at(-1);
    assert.match(report, /batch-\d{8}-\d{6}-2\.md$/);
    for (const f of r.files.filter((n) => !/-2\./.test(n))) assert.equal(readOut(out, f), 'other run', `${f} was overwritten`);
  });

  test('without --save-html, a batch writes no HTML files and the report never mentions HTML', async () => {
    const r = await run(['--urls', urlsFile([url('/dynamic')]), '--wait', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.files.filter((f) => f.endsWith('.html')).length, 0, r.files.join(', '));
    assert.equal(r.files.length, 2, r.files.join(', '));
    assert.doesNotMatch(r.md, /HTML/);
  });

  test('a URL that fails to load is reported, the rest still scan, and the batch exits 2', async () => {
    const down = `http://127.0.0.1:${closedPort}/`;
    const r = await run(['--urls', urlsFile([down, url('/clean')]), '--wait', '0', '--save-html']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Couldn't load/);
    assert.equal(r.files.filter((f) => f.endsWith('.json')).length, 1);
    assert.equal(r.files.filter((f) => f.endsWith('.html')).length, 1);
    const md = readOut(r.out, r.files.find((f) => f.endsWith('.md')));
    assert.ok(md.includes(`| \`${down}\` | Scan failed | n/a | n/a | n/a |`), md);
    assert.match(md, /Couldn't load/);
    const out = r.stdout.trim().split('\n');
    assert.equal(out[0], `${down}: This page couldn't be scanned.`);
  });
});

describe('CLI errors before the browser starts', { concurrency: true }, () => {
  test('--require-eu: exit IP outside the EU exits 2 with the spec message', async () => {
    const r = await run([url('/clean'), '--require-eu'], { ipinfo: '/ipinfo-us' });
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'Exit IP 8.8.8.8 is in US, outside the EU/EEA/UK. Connect your VPN to an EU server, or run without --require-eu.');
    assert.deepEqual(r.files, []);
  });

  test('--require-eu: a failed location lookup exits 2', async () => {
    const r = await run([url('/clean'), '--require-eu'], { ipinfo: '/ipinfo-bad' });
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), "Couldn't verify scan location. Check your connection, or run without --require-eu.");
    assert.deepEqual(r.files, []);
  });

  test('an invalid URL exits 2', async () => {
    const r = await run(['http://exa mple.com']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /URL/);
    assert.deepEqual(r.files, []);
  });

  test('a non-http URL exits 2', async () => {
    const r = await run(['ftp://example.com/']);
    assert.equal(r.code, 2);
    assert.deepEqual(r.files, []);
  });

  test('an invalid --timezone exits 2', async () => {
    const r = await run([url('/clean'), '--timezone', 'Mars/Olympus_Mons']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Mars\/Olympus_Mons/);
  });

  test('an invalid --wait exits 2', async () => {
    const r = await run([url('/clean'), '--wait', 'soon']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--wait/);
  });

  test('a missing URL exits 2 with usage', async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Usage: consent-scanner <url>/);
  });

  test('an unknown flag exits 2', async () => {
    const r = await run([url('/clean'), '--bogus']);
    assert.equal(r.code, 2);
  });

  test('--urls with more than 10 URLs exits 2 and writes nothing', async () => {
    const r = await run(['--urls', urlsFile(Array.from({ length: 11 }, (_, i) => url(`/clean?${i}`)))]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /11 URLs/);
    assert.match(r.stderr, /limit is 10/);
    assert.deepEqual(r.files, []);
  });

  test('--urls with an invalid line exits 2 and names the line', async () => {
    const r = await run(['--urls', urlsFile([url('/clean'), 'ftp://example.com/'])]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Line 2: /);
    assert.deepEqual(r.files, []);
  });

  test('--urls with an empty list exits 2', async () => {
    const r = await run(['--urls', urlsFile(['# nothing yet', ''])]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no URLs/);
  });

  test('--urls with a missing file exits 2', async () => {
    const missing = join(tmpdir(), 'consent-scanner-does-not-exist.txt');
    const r = await run(['--urls', missing]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(missing), r.stderr);
    assert.deepEqual(r.files, []);
  });

  test('--urls and a URL argument together exit 2', async () => {
    const r = await run([url('/clean'), '--urls', urlsFile([url('/clean')])]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not both/);
  });

  test('--urls with --require-eu outside the EU exits 2 before scanning', async () => {
    const r = await run(['--urls', urlsFile([url('/clean')]), '--require-eu'], { ipinfo: '/ipinfo-us' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /outside the EU\/EEA\/UK/);
    assert.deepEqual(r.files, []);
  });

  test('--help prints usage and exits 0', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: consent-scanner <url>/);
    assert.match(r.stdout, /--urls <file>/);
    assert.match(r.stdout, /--require-eu/);
    assert.ok(!r.stdout.includes('--any-region'));
  });
});

test('no input events were ever sent to any scanned page', () => {
  // Runs after the scans above (top-level tests run in order).
  assert.deepEqual(inputEvents, []);
});

test('the input-event detector itself works', async () => {
  // Guard against the previous test passing vacuously.
  const res = await fetch(`http://127.0.0.1:${port}/input-event?click`);
  assert.equal(res.status, 204);
  assert.deepEqual(inputEvents, ['/input-event?click']);
  inputEvents.length = 0;
});
