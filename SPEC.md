# consent-scanner — Spec

## Purpose

`consent-scanner` loads one URL in headless Chromium **without giving consent** and reports every third-party request, third-party script, and cookie that appeared before anyone touched the consent banner. It writes two files: a plain-language Markdown report for non-technical readers (marketing, legal, site owners) and a JSON file with the full data.

The tool never clicks, scrolls, or interacts with the page. Everything it sees during the scan happened before consent.

## Scope

- One command, one URL in, two files out.
- Node.js ≥ 20, ESM.
- Dependencies: `playwright` (Chromium only) and `tldts` (Public Suffix List lookups). Arguments are parsed with `node:util` `parseArgs`. Nothing else.

### Non-goals

- Clicking "Accept" or "Reject" and comparing the before/after behavior.
- Crawling more than one page, or scanning more than one URL per run.
- Routing through a proxy or changing IP address. Use a system-wide VPN (such as NordVPN, connected to an EU server) to get an EU IP. The tool only verifies the exit location and matches the browser's timezone to it (see [Location check](#location-check)).
- Inspecting localStorage, sessionStorage, or IndexedDB, or detecting fingerprinting.
- Making any legal judgment. The report describes what happened; it does not say whether that was lawful.

## CLI

```
consent-scanner <url> [--wait <seconds>] [--out <dir>] [--locale <bcp47>] [--timezone <iana>] [--require-eu]
consent-scanner --help
```

| Flag | Default | Meaning |
|---|---|---|
| `<url>` | required | Page to scan. If the scheme is missing, `https://` is added. |
| `--wait` | `10` | Seconds to keep recording after the `load` event fires. |
| `--out` | `.` | Directory for the output files. Created if it doesn't exist. |
| `--locale` | `en-GB` | Browser locale. Also sets the `Accept-Language` header and `navigator.language`. |
| `--timezone` | from exit IP | IANA timezone ID for the browser. By default it's taken from the exit-IP lookup, so it matches the VPN server's location (see [Location check](#location-check)). An invalid ID exits `2`. |
| `--require-eu` | off | Refuse to scan (exit `2`) when the exit IP is outside the EU/EEA/UK, or when the location lookup fails. Without it, such scans run but carry a prominent warning. |

**Output files:** `<host>-<YYYYMMDD-HHmmss>.md` and `.json`. `<host>` is the input URL's hostname with every character outside `[a-z0-9.-]` replaced by `-`. The timestamp is in UTC.

**stdout:** the one-line verdict, followed by the paths of both files.

**stderr:** errors, and the location warning when the scan isn't from a verified EU/EEA/UK location.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Scan completed with no findings. |
| `1` | Scan completed with findings (see [Findings](#findings)). |
| `2` | Error: invalid URL, browser launch failure, navigation failure, or a failed location check (exit IP outside the EU/EEA/UK, or the lookup failed) with `--require-eu`. The message goes to stderr and no files are written. |
| `3` | Blocked: the site showed a bot check instead of the real page (see [Bot-check detection](#bot-check-detection)). Both files are still written, marked unreliable, so you can see what happened. |

## Scan procedure

1. Run the [location check](#location-check). If it fails under `--require-eu`, exit `2` before launching the browser. Otherwise print any location warning to stderr and continue.
2. Launch headless Chromium and create a fresh browser context with `{ locale, timezoneId }`. Nothing is stored or carried over between runs, so no earlier consent can leak in. The user agent is Playwright's default.
3. Attach listeners to the context (not the page) so that iframe and popup traffic is captured too:
   - `request`: records the URL, method, `resourceType`, frame URL, and time in ms since navigation started.
   - `requestfinished` and `requestfailed`: record the response status, or `failed: true`.
4. Call `page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })`. Keep the main document's response status. If this throws, exit `2`.
5. Wait up to 30 s for the `load` event. If it doesn't fire, add a warning and continue.
6. Wait `--wait` seconds, then stop recording and ignore any later events.
7. Collect cookies for every domain with `context.cookies()`.
8. Run banner detection (see [Consent banner detection](#consent-banner-detection)) and [bot-check detection](#bot-check-detection).
9. Close the browser, classify the data, and write both files.

## Location check

Consent tools decide whether to show a GDPR banner from the visitor's **IP address**. Browser locale and timezone mostly change the banner's language. For an accurate GDPR scan, the scan must therefore come from an EU IP address.

**How the tool gets an EU IP:** it doesn't, and it has no VPN or proxy code. You connect a system-wide VPN (such as NordVPN) to an EU server before scanning. All traffic from the machine, including the headless Chromium browser the tool launches, then goes through it. If the VPN uses split tunneling, Terminal and Node must not be excluded.

**What the tool does:** it checks the exit location and flags any result that may be misleading. By default it still scans, so the tool works out of the box, for example on a demo or right after cloning the repo. `--require-eu` makes the check strict.

1. Before launching the browser, it makes one request to `https://ipinfo.io/json` with Node's `fetch`, not the scan browser, so the request never appears in the scan results.
2. It records `ip`, `country`, and `timezone` from the response in `environment.exitIp`, `environment.exitCountry`, and `environment.exitTimezone`.
3. If `country` is in the allowed set, the scan proceeds with no warning. The allowed set is the EU-27, the other EEA countries (IS, LI, NO), and GB. It lives as a constant in `src/location.js`.
4. If the country isn't in the allowed set:
   - **Default:** the scan proceeds. stderr gets `Warning: exit IP <ip> is in <country>, outside the EU/EEA/UK, so results may not match what EU visitors see. For a GDPR scan, connect a VPN to an EU server. Pass --require-eu to refuse non-EU scans.`
   - **`--require-eu`:** the tool exits `2` with: `Exit IP <ip> is in <country>, outside the EU/EEA/UK. Connect your VPN to an EU server, or run without --require-eu.`
5. If the lookup fails (network error, timeout after 5 s, or a malformed response):
   - **Default:** the scan proceeds. stderr gets `Warning: couldn't verify the scan location, so results may not match what EU visitors see. Pass --require-eu to refuse unverified scans.`
   - **`--require-eu`:** the tool exits `2` with: `Couldn't verify scan location. Check your connection, or run without --require-eu.`

**Matching the browser to the VPN:** unless `--timezone` is passed, the browser's `timezoneId` is set to the `timezone` from the lookup, for example `Europe/Amsterdam` for a Dutch server. A timezone that disagrees with the IP is a bot signal. The locale stays `en-GB` by default so that banners tend to show in English. Locale has little effect on geo decisions.

**When the location isn't a verified EU/EEA/UK one** (cases 4 and 5 without `--require-eu`), the timezone falls back to `Europe/Berlin` if the lookup failed. The report's first line after the verdict reads: "⚠️ This scan did not come from an EU location, so it may not reflect what EU visitors see."

## Bot-check detection

VPN exit IPs are well-known datacenter addresses, so some sites answer them with a bot challenge instead of the real page. A scan of a challenge page is meaningless, so the tool detects one after the wait window. It treats the page as blocked if any of these is true:

- The main document's status is `403`, `429`, or `503`.
- The page title matches `/just a moment|attention required|access denied|checking your browser|verify you are human/i`.
- One of these elements exists: `#challenge-form`, `#cf-challenge-running`, `iframe[src*="challenges.cloudflare.com"]`, `#px-captcha`, or `#sec-if-cpt-container`.

When the page is blocked:
- Set `blocked: { detected: true, reason: "<which signal matched>" }` in the JSON.
- Replace the report's verdict line with: **"This scan is unreliable: the site showed a bot check instead of the real page."** The report should also suggest trying a different VPN server.
- Write both files and exit `3`.

The signals live in `src/botchecks.js` as plain data, like the CMP signatures.

## Classification

### First-party vs third-party

- The first-party domains are the registrable domains (eTLD+1, via `tldts.getDomain`) of the **input URL** and of the **final main-frame URL** after redirects. Usually these are the same domain.
- A request is first-party when its host's eTLD+1 is a first-party domain. Otherwise it is third-party.
- A cookie's party is decided the same way, using its `domain` with any leading dot stripped.
- When `getDomain` returns null (for an IP address or `localhost`), the full hostname is used as the domain instead.

### Third-party scripts

These are third-party requests whose `resourceType` is `script`. Inline scripts are not reported.

### Tracker identification

`data/trackers.json` is a bundled, hand-curated list:

```json
{
  "domains": {
    "google-analytics.com": { "company": "Google", "service": "Google Analytics", "category": "analytics" },
    "cookielaw.org":        { "company": "OneTrust", "service": "OneTrust CMP",    "category": "consent-management" }
  },
  "cookies": [
    { "pattern": "^_ga(_.+)?$", "company": "Google", "service": "Google Analytics", "category": "analytics" },
    { "pattern": "^_fbp$",      "company": "Meta",   "service": "Meta Pixel",       "category": "advertising" }
  ]
}
```

- **Domain match:** the request host equals a key, or ends with `.` + the key. The longest matching key wins.
- **Cookie match:** the first regex in `cookies` that matches the cookie name. Cookie matching ignores party, so first-party tracking cookies such as `_ga`, `_fbp`, and `_gcl_au` are caught.
- **Categories:** `advertising`, `analytics`, `social`, `session-replay`, `tag-manager`, `consent-management`, `cdn`, `fonts`, `other`.
- Third-party domains that aren't in the list are reported as **"Unrecognized third party"**, with `tracker: null`.
- The starter list has roughly 60 entries covering the major ad, analytics, social, session-replay, and tag-manager vendors, the CDNs and font services, and the CMPs listed below. Write it by hand rather than copying DuckDuckGo Tracker Radar or Disconnect wholesale: both are licensed CC BY-NC-SA 4.0, which restricts commercial use.

### Findings

A scan **has findings**, and exits `1`, if either of these is true:

- There is at least one third-party request whose category is not `consent-management`. The CMP has to load before consent in order to work, so it is listed but not counted.
- At least one cookie, first- or third-party, matches a tracker cookie pattern.

## Consent banner detection

After the wait window, check for each known CMP using a JS global (`page.evaluate`) or a DOM selector. The first match wins. If a selector matches, also record whether the element is visible (`locator.isVisible()`).

| CMP | Global | Selector |
|---|---|---|
| OneTrust | `OneTrust` | `#onetrust-banner-sdk` |
| Cookiebot | `Cookiebot` | `#CybotCookiebotDialog` |
| Didomi | `Didomi` | `#didomi-host` |
| Usercentrics | `UC_UI` | `#usercentrics-root` |
| TrustArc | `truste` | `#truste-consent-track` |
| Quantcast Choice | — | `.qc-cmp2-container` |
| Google Funding Choices | — | `.fc-consent-root` |
| Generic IAB TCF CMP | `__tcfapi` | — |

The signatures live in `src/cmps.js` as plain data, so adding a CMP needs no code changes. The banner is never clicked.

## JSON output

```json
{
  "tool": { "name": "consent-scanner", "version": "0.1.0" },
  "scannedAt": "2026-10-06T21:30:00.000Z",
  "input": { "url": "https://example.com/", "finalUrl": "https://www.example.com/", "waitSeconds": 10 },
  "environment": { "browserVersion": "…", "userAgent": "…", "locale": "en-GB", "timezone": "Europe/Amsterdam", "exitIp": "…", "exitCountry": "NL", "exitTimezone": "Europe/Amsterdam", "requireEu": false },
  "blocked": { "detected": false, "reason": null },
  "firstPartyDomains": ["example.com"],
  "warnings": [],
  "banner": { "detected": true, "cmp": "OneTrust", "visible": true },
  "summary": {
    "hasFindings": true,
    "thirdPartyRequests": 42,
    "thirdPartyDomains": 12,
    "companies": 6,
    "thirdPartyScripts": 9,
    "cookies": 15,
    "trackingCookies": 7
  },
  "companies": [
    {
      "company": "Google",
      "services": ["Google Analytics", "Google Tag Manager"],
      "categories": ["analytics", "tag-manager"],
      "domains": ["google-analytics.com", "googletagmanager.com"],
      "requests": 12,
      "scripts": 3,
      "cookies": ["_ga", "_ga_ABC123"]
    }
  ],
  "requests": [
    {
      "url": "https://www.google-analytics.com/g/collect?…",
      "method": "POST",
      "resourceType": "fetch",
      "host": "www.google-analytics.com",
      "domain": "google-analytics.com",
      "party": "third",
      "tracker": { "company": "Google", "service": "Google Analytics", "category": "analytics" },
      "frameUrl": "https://www.example.com/",
      "status": 204,
      "failed": false,
      "msSinceStart": 812
    }
  ],
  "cookies": [
    {
      "name": "_ga",
      "domain": ".example.com",
      "path": "/",
      "expires": "2028-10-06T21:30:00.000Z",
      "httpOnly": false,
      "secure": false,
      "sameSite": "Lax",
      "party": "first",
      "tracker": { "company": "Google", "service": "Google Analytics", "category": "analytics" }
    }
  ]
}
```

- `requests` contains **every** request, first-party included, each with a `party` field.
- `companies` contains third parties only. Unrecognized domains are grouped under `"company": "Unrecognized"`.
- Cookie **values are never stored**.
- `expires` is `null` for session cookies.

## Markdown report

The report is for non-technical readers. It uses plain sentences, explains jargon on first use, and puts raw URLs only in the appendix.

```markdown
# Consent scan: www.example.com

**Before any consent was given, this page contacted 6 outside companies and set 7 tracking cookies.**

Scanned https://www.example.com/ on 6 Oct 2026, 21:30 UTC, from the Netherlands (browser set to en-GB, Europe/Amsterdam). We loaded the page in a fresh browser, didn't click anything, and recorded activity for 10 seconds after the page finished loading.

## Consent banner
A OneTrust consent banner was found and was visible. Everything below happened while it was still waiting for an answer.

## Who was contacted
| Company | What it does | Requests | Scripts loaded | Cookies set |
|---|---|---|---|---|
| Google | Analytics, tag management | 12 | 3 | _ga, _ga_ABC123 |
| Meta | Advertising | 4 | 1 | _fbp |
| Unrecognized third party | — | 2 | 0 | — |

## Cookies
Plain-language list of tracking cookies first ("_ga — Google Analytics, identifies you across visits, lasts 2 years"), then a count of the other cookies.

## What this means
Two or three sentences in fixed wording, varied only by whether there were findings. Includes this caveat: some third-party requests (CDNs, fonts, the consent tool itself) may be strictly necessary, and this report is not legal advice.

## Limitations
- One page, one visit, no scrolling or clicking. Some trackers only fire on interaction.
- The scan's location is the VPN server's location. Sites can treat known VPN addresses differently from home connections.
- Plus any entries from `warnings`.

## Appendix: all third-party requests
Grouped by domain. Each entry shows resource type, status, and the URL truncated to 120 characters.
```

When there are no findings, the verdict line reads: **"No third-party trackers or tracking cookies were detected before consent."**

## Project layout

```
package.json            "bin": { "consent-scanner": "bin/consent-scanner.js" }, "type": "module"
bin/consent-scanner.js  argument parsing, output paths, exit codes
src/scan.js             Playwright: launch, record, wait, collect cookies, detect banner → raw result
src/location.js         exit-IP lookup, allowed-country set, timezone selection
src/cmps.js             CMP signature data
src/botchecks.js        bot-check signature data
src/classify.js         party resolution, tracker lookup, company grouping, findings
src/report.js           renderMarkdown(result), renderJson(result)
data/trackers.json      bundled tracker list
test/                   node:test
```

`scan.js` is the only module that touches Playwright. Everything after it is a pure function of the raw result, which keeps it testable without a browser.

## Testing

- **Unit (`node:test`):** party resolution, including subdomains, multi-part TLDs like `.co.uk`, IP addresses, and `localhost`. Also tracker domain and cookie matching, the findings rules (for example, CMP-only traffic produces no findings), and Markdown rendering against a fixture raw result.
- **Location (unit):** `src/location.js` gets the ipinfo response as input, so it can be tested without a network. Cover EU, EEA, and GB countries passing with no warning; a non-EU country and a malformed or failed response passing with a warning by default and failing under `--require-eu`; and the timezone choice (an explicit `--timezone` wins, then the exit-IP timezone, then `Europe/Berlin`).
- **Integration:** a local `http` server serves a page on `localhost:<port>` that loads a script from `127.0.0.1:<port2>` and sets a `_ga` cookie. The test runs the CLI and asserts exit code `1`, that both files exist, and that the JSON contains one third-party script and one tracking cookie. A second page with no third-party activity must exit `0`. A third page titled "Just a moment..." containing `#challenge-form` must exit `3`. Integration tests set `CONSENT_SCANNER_IPINFO_URL` to a local stub that returns `{"country":"DE","timezone":"Europe/Berlin"}`, so they pass without a VPN. Other stubs return a non-EU country and a malformed body, to cover the warn-by-default path and the `--require-eu` exit `2`. This environment variable is the only test hook.

## Acceptance criteria

1. `consent-scanner example.com` writes `example.com-<ts>.md` and `.json` to the current directory and exits `0` or `1`.
2. No click, keypress, scroll, or mouse event is ever sent to the page.
3. Every third-party request made within the wait window appears in the JSON, and every third-party script appears in the report.
4. First-party tracking cookies (such as `_ga`) are flagged as tracking.
5. An unreachable URL exits `2`, writes nothing, and prints a clear error.
6. The Markdown report reads as plain English to someone who doesn't know what an HTTP request is.
7. With the VPN on an EU server, the browser's timezone matches the exit IP's timezone, and the JSON records the exit IP and country.
8. With the VPN off (or on a non-EU server), the tool still scans, prints a warning to stderr, and the report carries the ⚠️ warning. With `--require-eu`, it instead exits `2` without launching the browser.
9. A page that serves a Cloudflare challenge is reported as blocked and exits `3`.

## Setup

```
npm install
npx playwright install chromium
```

For an accurate GDPR scan, connect your VPN to an EU server before running the tool. Without one, the tool still scans and flags the result with a warning. Pass `--require-eu` to refuse instead.
