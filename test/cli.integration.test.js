import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
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
  };
  first = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/input-event') { inputEvents.push(req.url); res.writeHead(204); return res.end(); }
    if (!pages[path]) { res.writeHead(404); return res.end(); }
    const headers = { 'content-type': 'text/html' };
    if (path === '/tracking') headers['set-cookie'] = '_ga=GA1.1.999.111; Path=/; Max-Age=63072000';
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

function run(args, { ipinfo = '/ipinfo' } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'consent-scanner-'));
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

  test('--help prints usage and exits 0', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: consent-scanner <url>/);
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
