#!/usr/bin/env node
// Argument parsing, output paths, and exit codes.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupExitLocation, checkLocation, chooseTimezone, FALLBACK_TIMEZONE } from '../src/location.js';
import { runScan, ScanError } from '../src/scan.js';
import { classify } from '../src/classify.js';
import { renderMarkdown, renderJson, verdictLine, renderBatchMarkdown } from '../src/report.js';
import { normalizeUrl, parseUrlList, InputError, MAX_BATCH_URLS } from '../src/urls.js';
import { mapWithConcurrency, batchOutcome, BATCH_CONCURRENCY } from '../src/batch.js';

const EXIT = { CLEAN: 0, FINDINGS: 1, ERROR: 2, BLOCKED: 3 };

const USAGE = `Usage: consent-scanner <url> [--wait <seconds>] [--out <dir>] [--locale <bcp47>] [--timezone <iana>] [--require-eu]
       consent-scanner --urls <file> [same options]
       consent-scanner --help

Loads <url> in headless Chromium without giving consent and reports every third-party
request, script, and cookie seen before the consent banner was answered.

Options:
  --urls <file>      Scan up to ${MAX_BATCH_URLS} URLs listed in <file>, one per line, ${BATCH_CONCURRENCY} at a time.
                     Writes a .json per URL plus one batch-<timestamp>.md report.
  --save-html        Also save each page's rendered HTML as a .html file next to its .json
  --wait <seconds>   Seconds to keep recording after the load event (default 10)
  --out <dir>        Directory for the output files (default .)
  --locale <bcp47>   Browser locale and Accept-Language (default en-GB)
  --timezone <iana>  Browser timezone (default: the exit IP's timezone)
  --require-eu       Refuse to scan unless the exit IP is in the EU/EEA/UK
  -h, --help         Show this help

Exit codes: 0 no findings, 1 findings, 2 error, 3 blocked by a bot check.
A batch exits with the most serious result across its URLs: 2, then 3, then 1, then 0.
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
        urls: { type: 'string' },
        out: { type: 'string', default: '.' },
        locale: { type: 'string', default: 'en-GB' },
        timezone: { type: 'string' },
        'require-eu': { type: 'boolean', default: false },
        'save-html': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new CliError(`${err.message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const batch = values.urls !== undefined;
  if (batch && positionals.length > 0) throw new CliError('Pass one URL or --urls <file>, not both.');
  if (!batch && positionals.length !== 1) throw new CliError(USAGE);

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
    ...(batch ? { urls: readUrlList(values.urls) } : { url: normalizeUrl(positionals[0]) }),
    waitSeconds,
    out: values.out,
    locale: values.locale,
    timezone: values.timezone,
    requireEu: values['require-eu'],
    saveHtml: values['save-html'],
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

function readUrlList(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`Couldn't read the URL list ${file}: ${err.code === 'ENOENT' ? 'no such file' : firstLine(err)}.`);
  }
  try {
    return parseUrlList(text);
  } catch (err) {
    throw err instanceof InputError ? new CliError(`${file}: ${err.message}`) : err;
  }
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const stamp = (iso) => iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHmmss, UTC

function outputBase(url, scannedAt) {
  const host = new URL(url).hostname.replace(/[^a-z0-9.-]/g, '-');
  return `${host}-${stamp(scannedAt)}`;
}

function exitCodeFor(result) {
  if (result.blocked.detected) return EXIT.BLOCKED;
  return result.summary.hasFindings ? EXIT.FINDINGS : EXIT.CLEAN;
}

/** Steps 2–8 for one URL: scan, record the location check, classify. */
async function scanOne(url, opts, timezone, location) {
  const { html, ...raw } = await runScan({ url, waitSeconds: opts.waitSeconds, locale: opts.locale, timezone, captureHtml: opts.saveHtml });
  raw.environment = {
    ...raw.environment,
    exitIp: location.exitIp,
    exitCountry: location.exitCountry,
    exitTimezone: location.exitTimezone,
    requireEu: opts.requireEu,
  };
  return { result: classify(raw), html };
}

async function runSingle(opts, timezone, location) {
  const { result, html } = await scanOne(opts.url, opts, timezone, location);
  mkdirSync(opts.out, { recursive: true });
  const base = join(opts.out, outputBase(opts.url, result.scannedAt));
  writeFileSync(`${base}.md`, renderMarkdown(result));
  writeFileSync(`${base}.json`, renderJson(result));
  if (html !== null) writeFileSync(`${base}.html`, html);

  console.log(verdictLine(result));
  console.log(`${base}.md`);
  console.log(`${base}.json`);
  if (html !== null) console.log(`${base}.html`);
  return exitCodeFor(result);
}

async function runBatch(opts, timezone, location) {
  mkdirSync(opts.out, { recursive: true });
  const startedAt = new Date().toISOString();
  // Scans of one host can finish in the same second, so names get -2, -3… instead of overwriting.
  // The 'wx' flag makes the existence check and the write one step, so even another run writing to
  // the same --out can't overwrite a file. The .html must be free too, so the pair shares one name.
  const writeNew = (base, ext, content, { alsoFree = [] } = {}) => {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (alsoFree.some((e) => existsSync(join(opts.out, `${name}${e}`)))) continue;
      try {
        writeFileSync(join(opts.out, `${name}${ext}`), content, { flag: 'wx' });
        return name;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  };

  const entries = await mapWithConcurrency(opts.urls, BATCH_CONCURRENCY, async (url) => {
    try {
      const { result, html } = await scanOne(url, opts, timezone, location);
      // Claiming the .json claims the name; the .html then goes next to it.
      const name = writeNew(outputBase(url, result.scannedAt), '.json', renderJson(result), { alsoFree: ['.html'] });
      const files = { json: `${name}.json`, html: null };
      if (html !== null) {
        // The scan itself succeeded, so a failed HTML write costs only the HTML file, not the result.
        try {
          writeFileSync(join(opts.out, `${name}.html`), html, { flag: 'wx' });
          files.html = `${name}.html`;
        } catch (err) {
          console.error(`Couldn't save the HTML for ${url}: ${firstLine(err)}`);
        }
      }
      return { url, result, error: null, files };
    } catch (err) {
      // One bad URL doesn't stop the batch: it gets a "Scan failed" row in the report.
      const expected = err instanceof ScanError;
      console.error(expected ? err.message : `Unexpected error scanning ${url}: ${err?.stack ?? err}`);
      return { url, result: null, error: expected ? err.message : `Unexpected error: ${firstLine(err)}`, files: null };
    }
  });

  const report = join(opts.out, `${writeNew(`batch-${stamp(startedAt)}`, '.md', renderBatchMarkdown({
    startedAt,
    waitSeconds: opts.waitSeconds,
    locale: opts.locale,
    timezone,
    exitCountry: location.exitCountry,
    saveHtml: opts.saveHtml,
    entries,
  }))}.md`);

  for (const e of entries) console.log(`${e.url}: ${e.result ? verdictLine(e.result) : "This page couldn't be scanned."}`);
  console.log(report);
  return { error: EXIT.ERROR, blocked: EXIT.BLOCKED, findings: EXIT.FINDINGS, clean: EXIT.CLEAN }[batchOutcome(entries)];
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

  // 2–9. Scan, classify, and write.
  return opts.urls ? runBatch(opts, timezone, location) : runSingle(opts, timezone, location);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const expected = err instanceof CliError || err instanceof ScanError || err instanceof InputError;
  console.error(expected ? err.message : `Unexpected error: ${err?.stack ?? err}`);
  process.exitCode = EXIT.ERROR;
}
