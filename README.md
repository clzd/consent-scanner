# consent-scanner

`consent-scanner` loads one URL in headless Chromium without accepting or rejecting the consent banner. It records every third-party request, third-party script, and cookie that showed up before anyone answered the banner. It writes a plain-language Markdown report for non-technical readers and a JSON file with the full data.

## Install

Requires Node.js 20 or later.

```
npm install
npx playwright install chromium
```

## Usage

```
npx consent-scanner example.com --out scans
```

This writes `scans/example.com-<timestamp>.md` and `.json`. The exit code is `0` with no findings, `1` with findings, `2` on error, and `3` when the site served a bot check instead of the real page. Run `npx consent-scanner --help` for all options.

### Several URLs at once

Put up to 10 URLs in a text file, one per line. Blank lines and lines starting with `#` are skipped.

```
# urls.txt
example.com
https://shop.example.com/checkout
```

```
npx consent-scanner --urls urls.txt --out scans
```

This scans 3 URLs at a time and writes, into `scans/`:

- `<host>-<timestamp>.json` for each URL, with the same data as a single scan.
- `batch-<timestamp>.md`: one report with a summary table (URL, third parties, cookies, scripts before consent) and a section per URL.

Add `--save-html` (in batch or single-URL mode) to also save each page's final rendered HTML as `<host>-<timestamp>.html` next to its JSON, for analysis with other tools. It's off by default because the files can be megabytes and hold whatever the site wrote into the page. It's the site's own code, so open it in a text editor rather than a browser.

A URL that fails to load doesn't stop the others. The batch exits with its most serious result: `2` if any scan failed, then `3`, then `1`, then `0`.

Consent tools decide whether to show a GDPR banner based on the visitor's IP address. For a meaningful GDPR scan, connect a system-wide VPN to an EU server first. Scans from outside the EU/EEA/UK still run, but they print a warning and the report says so. Pass `--require-eu` to refuse those scans instead.

## Sample report

An excerpt from a report:

```markdown
# Consent scan: www.example.com

**Before any consent was given, this page contacted 4 outside companies and set 3 tracking cookies.**

## Consent banner

A OneTrust consent banner was found and was visible. Everything below happened while it was still waiting for an answer.

## Who was contacted

| Company | What it does | Requests | Scripts loaded | Cookies set |
|---|---|---|---|---|
| Google | Analytics, tag management | 2 | 1 | `_ga`, `_ga_ABC123` |
| Meta | Advertising, social media | 2 | 1 | `_fbp` |
| OneTrust | Consent management | 1 | 1 | — |
| Unrecognized third party | — | 1 | 0 | — |
```

The full report goes on to explain each tracking cookie, the scan's limitations, and every third-party request.

## Not legal advice

This tool describes what a page did before consent. It doesn't decide whether that was lawful. Some third-party requests, such as CDNs, web fonts, and the consent tool itself, may be strictly necessary. Have someone qualified review the results before you draw conclusions.

## License

MIT. See [LICENSE](LICENSE).
