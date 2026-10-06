#!/usr/bin/env node
// Argument parsing, output paths, and exit codes.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupExitLocation, checkLocation, chooseTimezone, FALLBACK_TIMEZONE } from '../src/location.js';
import { runScan, ScanError } from '../src/scan.js';
import { classify } from '../src/classify.js';
import { renderMarkdown, renderJson, verdictLine } from '../src/report.js';

const EXIT = { CLEAN: 0, FINDINGS: 1, ERROR: 2, BLOCKED: 3 };

const USAGE = `Usage: consent-scanner <url> [--wait <seconds>] [--out <dir>] [--locale <bcp47>] [--timezone <iana>] [--require-eu]
       consent-scanner --help

Loads <url> in headless Chromium without giving consent and reports every third-party
request, script, and cookie seen before the consent banner was answered.

Options:
  --wait <seconds>   Seconds to keep recording after the load event (default 10)
  --out <dir>        Directory for the .md and .json output (default .)
  --locale <bcp47>   Browser locale and Accept-Language (default en-GB)
  --timezone <iana>  Browser timezone (default: the exit IP's timezone)
  --require-eu       Refuse to scan unless the exit IP is in the EU/EEA/UK
  -h, --help         Show this help

Exit codes: 0 no findings, 1 findings, 2 error, 3 blocked by a bot check.
For an accurate GDPR scan, connect a VPN to an EU server first. Scans from elsewhere
still run, but the report carries a warning.`;

class CliError extends Error {}

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        wait: { type: 'string', default: '10' },
        out: { type: 'string', default: '.' },
        locale: { type: 'string', default: 'en-GB' },
        timezone: { type: 'string' },
        'require-eu': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new CliError(`${err.message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new CliError(USAGE);

  const waitSeconds = Number(values.wait);
  if (values.wait.trim() === '' || !Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new CliError(`--wait must be a number of seconds (0 or more), not "${values.wait}".`);
  }
  try {
    Intl.getCanonicalLocales(values.locale);
  } catch {
    throw new CliError(`--locale "${values.locale}" isn't a valid BCP 47 language tag, such as en-GB.`);
  }
  if (values.timezone !== undefined && !isValidTimezone(values.timezone)) {
    throw new CliError(`--timezone "${values.timezone}" isn't a known IANA timezone ID, such as Europe/Berlin.`);
  }
  return {
    url: normalizeUrl(positionals[0]),
    waitSeconds,
    out: values.out,
    locale: values.locale,
    timezone: values.timezone,
    requireEu: values['require-eu'],
  };
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(input) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`Only http and https URLs can be scanned, not ${url.protocol}// (from ${input}).`);
  }
  return url.href;
}

function outputBase(url, scannedAt) {
  const host = new URL(url).hostname.replace(/[^a-z0-9.-]/g, '-');
  const ts = scannedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHmmss, UTC
  return `${host}-${ts}`;
}

async function main(argv) {
  const opts = parse(argv);
  if (opts.help) {
    console.log(USAGE);
    return EXIT.CLEAN;
  }

  // 1. Location check, before the browser exists. Only --require-eu makes it fatal.
  const location = checkLocation(await lookupExitLocation(), { requireEu: opts.requireEu });
  if (!location.ok) throw new CliError(location.error);
  if (location.warning) console.error(location.warning);
  let timezone = chooseTimezone({ explicit: opts.timezone, exitTimezone: location.exitTimezone });
  if (!isValidTimezone(timezone)) timezone = FALLBACK_TIMEZONE;

  // 2–8. Scan.
  const raw = await runScan({ url: opts.url, waitSeconds: opts.waitSeconds, locale: opts.locale, timezone });
  raw.environment = {
    ...raw.environment,
    exitIp: location.exitIp,
    exitCountry: location.exitCountry,
    exitTimezone: location.exitTimezone,
    requireEu: opts.requireEu,
  };

  // 9. Classify and write.
  const result = classify(raw);
  mkdirSync(opts.out, { recursive: true });
  const base = join(opts.out, outputBase(opts.url, result.scannedAt));
  writeFileSync(`${base}.md`, renderMarkdown(result));
  writeFileSync(`${base}.json`, renderJson(result));

  console.log(verdictLine(result));
  console.log(`${base}.md`);
  console.log(`${base}.json`);

  if (result.blocked.detected) return EXIT.BLOCKED;
  return result.summary.hasFindings ? EXIT.FINDINGS : EXIT.CLEAN;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const expected = err instanceof CliError || err instanceof ScanError;
  console.error(expected ? err.message : `Unexpected error: ${err?.stack ?? err}`);
  process.exitCode = EXIT.ERROR;
}
