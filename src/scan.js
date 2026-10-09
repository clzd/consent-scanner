// The only module that touches Playwright. Loads one page without interacting
// with it and returns the raw observations for classify.js.
import { chromium } from 'playwright';
import { CMPS } from './cmps.js';
import { BOT_CHECKS } from './botchecks.js';

const NAV_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 30_000;
// Reading the page runs on its main thread, so a page that freezes itself would block it forever.
const INSPECT_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol('timed out');

export class ScanError extends Error {}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to the promise's value, or to TIMED_OUT after ms. */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, ms, TIMED_OUT); });
  promise.catch(() => {}); // the abandoned call rejects later, when the browser closes
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function detectBanner(page) {
  for (const cmp of CMPS) {
    let selectorHit = false;
    let visible = null;
    if (cmp.selector) {
      const el = page.locator(cmp.selector).first();
      selectorHit = (await el.count().catch(() => 0)) > 0;
      if (selectorHit) visible = await el.isVisible().catch(() => false);
    }
    const globalHit = !selectorHit && cmp.global
      ? await page.evaluate((name) => typeof window[name] !== 'undefined', cmp.global).catch(() => false)
      : false;
    if (selectorHit || globalHit) {
      // Found via its global but its banner element is absent: the banner isn't showing.
      if (!selectorHit && cmp.selector) visible = false;
      return { detected: true, cmp: cmp.name, visible };
    }
  }
  return { detected: false, cmp: null, visible: null };
}

async function presentSelectors(page, selectors) {
  const found = [];
  for (const s of selectors) {
    if ((await page.locator(s).count().catch(() => 0)) > 0) found.push(s);
  }
  return found;
}

async function inspectPage(page) {
  const banner = await detectBanner(page);
  const title = await page.title().catch(() => '');
  const presentBotSelectors = await presentSelectors(page, BOT_CHECKS.selectors);
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
  return { banner, title, presentBotSelectors, userAgent };
}

/**
 * @param {{ url: string, waitSeconds: number, locale: string, timezone: string, captureHtml?: boolean }} opts
 * @returns raw result (see test/fixtures/raw.json for the shape), plus `html`: the rendered page,
 *   or null when captureHtml is off or the page stopped responding
 */
export async function runScan({ url, waitSeconds, locale, timezone, captureHtml = false }) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new ScanError(`Couldn't start the browser: ${firstLine(err)}. Did you run "npx playwright install chromium"?`);
  }

  try {
    // A fresh context per run: no stored cookies, so no earlier consent can leak in.
    const context = await browser.newContext({ locale, timezoneId: timezone });
    const requests = [];
    const byRequest = new Map();
    let recording = true;
    let t0 = Date.now();

    // Listeners go on the context so iframe and popup traffic is captured too.
    context.on('request', (req) => {
      if (!recording) return;
      const reqUrl = req.url();
      if (!/^https?:/i.test(reqUrl)) return;
      let frameUrl = null;
      try { frameUrl = req.frame().url() || null; } catch {}
      const entry = {
        url: reqUrl,
        method: req.method(),
        resourceType: req.resourceType(),
        frameUrl,
        status: null,
        failed: false,
        msSinceStart: Math.max(0, Date.now() - t0),
      };
      byRequest.set(req, entry);
      requests.push(entry);
    });
    context.on('requestfinished', (req) => {
      const entry = byRequest.get(req);
      if (!recording || !entry) return;
      // Synchronous on purpose: req.response() has no timeout and can stay pending forever after a request finishes.
      entry.status = req.existingResponse()?.status() ?? null;
    });
    context.on('requestfailed', (req) => {
      const entry = byRequest.get(req);
      if (!recording || !entry) return;
      entry.failed = true;
    });

    const page = await context.newPage();
    const scannedAt = new Date().toISOString();
    const warnings = [];

    t0 = Date.now();
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      throw new ScanError(`Couldn't load ${url}: ${firstLine(err)}`);
    }
    const mainStatus = response?.status() ?? null;

    try {
      await page.waitForLoadState('load', { timeout: LOAD_TIMEOUT_MS });
    } catch {
      warnings.push("The page didn't finish loading within 30 seconds, so the scan carried on without waiting for it.");
    }

    await sleep(waitSeconds * 1000);
    recording = false;

    const cookies = (await context.cookies()).map(({ value, ...rest }) => rest);
    const inspectStart = Date.now();
    let inspected = await withDeadline(inspectPage(page), INSPECT_TIMEOUT_MS);
    let html = null;
    if (inspected === TIMED_OUT) {
      warnings.push("The page stopped responding while we checked it for a consent banner and a bot check, so neither could be detected.");
      inspected = { banner: { detected: false, cmp: null, visible: null }, title: '', presentBotSelectors: [], userAgent: null };
    } else if (captureHtml) {
      // The DOM as it stands after the wait window, serialized: what scripts built, not the original source.
      // It gets what's left of the deadline on its own, so a timeout here never discards the detection results.
      const remaining = Math.max(0, INSPECT_TIMEOUT_MS - (Date.now() - inspectStart));
      const content = await withDeadline(page.content().catch((err) => ({ error: firstLine(err) })), remaining);
      if (content === TIMED_OUT) {
        warnings.push("The page stopped responding while we saved its HTML, so no HTML file was written.");
      } else if (typeof content === 'string') {
        html = content;
      } else {
        warnings.push(`The page's HTML couldn't be read (${content.error}), so no HTML file was written.`);
      }
    }
    const { banner, title, presentBotSelectors, userAgent } = inspected;

    return {
      scannedAt,
      input: { url, finalUrl: page.url(), waitSeconds },
      environment: { browserVersion: browser.version(), userAgent, locale, timezone },
      mainStatus,
      title,
      presentBotSelectors,
      warnings,
      banner,
      requests,
      cookies,
      html,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
