// The only module that touches Playwright. Loads one page without interacting
// with it and returns the raw observations for classify.js.
import { chromium } from 'playwright';
import { CMPS } from './cmps.js';
import { BOT_CHECKS } from './botchecks.js';

const NAV_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 30_000;

export class ScanError extends Error {}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * @param {{ url: string, waitSeconds: number, locale: string, timezone: string }} opts
 * @returns raw result (see test/fixtures/raw.json for the shape)
 */
export async function runScan({ url, waitSeconds, locale, timezone }) {
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
    const pending = [];
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
      pending.push(req.response().then((res) => { entry.status = res?.status() ?? null; }, () => {}));
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
    await Promise.allSettled(pending);

    const cookies = (await context.cookies()).map(({ value, ...rest }) => rest);
    const banner = await detectBanner(page);
    const title = await page.title().catch(() => '');
    const presentBotSelectors = await presentSelectors(page, BOT_CHECKS.selectors);
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);

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
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
