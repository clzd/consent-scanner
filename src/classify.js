// Pure functions from the raw scan result to the JSON output shape.
import { readFileSync } from 'node:fs';
import { getDomain } from 'tldts';
import { BOT_CHECKS } from './botchecks.js';
import { code } from './markdown.js';

export const TOOL = { name: 'consent-scanner', version: '0.1.0' };
export const UNRECOGNIZED = 'Unrecognized';
export const CATEGORIES = [
  'advertising', 'analytics', 'social', 'session-replay', 'tag-manager',
  'consent-management', 'cdn', 'fonts', 'other',
];

export function loadTrackers() {
  return JSON.parse(readFileSync(new URL('../data/trackers.json', import.meta.url), 'utf8'));
}

/** eTLD+1, or the full host when there isn't one (IP addresses, localhost). */
export function registrableDomain(host) {
  return getDomain(host) || host;
}

const hostOf = (url) => new URL(url).hostname;

export function firstPartyDomains(inputUrl, finalUrl) {
  return [...new Set([inputUrl, finalUrl].filter(Boolean).map((u) => registrableDomain(hostOf(u))))];
}

export function partyOf(host, fpDomains) {
  return fpDomains.includes(registrableDomain(host)) ? 'first' : 'third';
}

const pick = ({ company, service, category }) => ({ company, service, category });

/** The tracker entry whose key equals the host or is a parent of it; the longest key wins. */
export function matchTrackerDomain(host, trackers) {
  let best = null;
  for (const key of Object.keys(trackers.domains)) {
    if ((host === key || host.endsWith(`.${key}`)) && (!best || key.length > best.length)) best = key;
  }
  return best ? pick(trackers.domains[best]) : null;
}

const regexCache = new Map();
const regex = (pattern) => {
  if (!regexCache.has(pattern)) regexCache.set(pattern, new RegExp(pattern));
  return regexCache.get(pattern);
};

/** The first cookie pattern that matches the name. Party is ignored on purpose. */
export function matchTrackerCookie(name, trackers) {
  const hit = trackers.cookies.find((c) => regex(c.pattern).test(name));
  return hit ? pick(hit) : null;
}

export function detectBlocked({ mainStatus, title, presentSelectors = [] }) {
  if (BOT_CHECKS.statuses.includes(mainStatus)) {
    return { detected: true, reason: `The main page returned HTTP ${mainStatus}.` };
  }
  if (title && BOT_CHECKS.title.test(title)) {
    return { detected: true, reason: `The page title ${code(title)} looks like a bot check.` };
  }
  const selector = BOT_CHECKS.selectors.find((s) => presentSelectors.includes(s));
  if (selector) return { detected: true, reason: `The page contains a bot-check element (${selector}).` };
  return { detected: false, reason: null };
}

const sorted = (xs) => [...new Set(xs)].sort();

function groupCompanies(requests, cookies) {
  const groups = new Map();
  for (const r of requests) {
    if (r.party !== 'third') continue;
    const name = r.tracker?.company ?? UNRECOGNIZED;
    if (!groups.has(name)) groups.set(name, { company: name, services: [], categories: [], domains: [], requests: 0, scripts: 0, cookies: [] });
    const g = groups.get(name);
    if (r.tracker) {
      g.services.push(r.tracker.service);
      g.categories.push(r.tracker.category);
    }
    g.domains.push(r.domain);
    g.requests += 1;
    if (r.resourceType === 'script') g.scripts += 1;
  }
  // Tracking cookies are attached to a company only when that company was also contacted.
  for (const c of cookies) {
    if (c.tracker && groups.has(c.tracker.company)) groups.get(c.tracker.company).cookies.push(c.name);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, services: sorted(g.services), categories: sorted(g.categories), domains: sorted(g.domains), cookies: sorted(g.cookies) }))
    .sort((a, b) => (a.company === UNRECOGNIZED) - (b.company === UNRECOGNIZED) || b.requests - a.requests || a.company.localeCompare(b.company));
}

export function classify(raw, trackers = loadTrackers()) {
  const fp = firstPartyDomains(raw.input.url, raw.input.finalUrl);

  const requests = raw.requests.map((r) => {
    const host = hostOf(r.url);
    const party = partyOf(host, fp);
    return {
      url: r.url,
      method: r.method,
      resourceType: r.resourceType,
      host,
      domain: registrableDomain(host),
      party,
      tracker: party === 'third' ? matchTrackerDomain(host, trackers) : null,
      frameUrl: r.frameUrl,
      status: r.status,
      failed: r.failed,
      msSinceStart: r.msSinceStart,
    };
  });

  // Cookie values are deliberately never copied.
  const cookies = raw.cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    party: partyOf(c.domain.replace(/^\./, ''), fp),
    tracker: matchTrackerCookie(c.name, trackers),
  }));

  const third = requests.filter((r) => r.party === 'third');
  const companies = groupCompanies(requests, cookies);
  const unrecognized = companies.find((c) => c.company === UNRECOGNIZED);
  const trackingCookies = cookies.filter((c) => c.tracker).length;

  const summary = {
    hasFindings: third.some((r) => r.tracker?.category !== 'consent-management') || trackingCookies > 0,
    thirdPartyRequests: third.length,
    thirdPartyDomains: new Set(third.map((r) => r.domain)).size,
    // Each unrecognized domain is counted as its own company: we can't tell who owns them.
    companies: companies.length - (unrecognized ? 1 : 0) + (unrecognized?.domains.length ?? 0),
    thirdPartyScripts: third.filter((r) => r.resourceType === 'script').length,
    cookies: cookies.length,
    trackingCookies,
  };

  return {
    tool: TOOL,
    scannedAt: raw.scannedAt,
    input: raw.input,
    environment: raw.environment,
    blocked: detectBlocked({ mainStatus: raw.mainStatus, title: raw.title, presentSelectors: raw.presentBotSelectors }),
    firstPartyDomains: fp,
    warnings: raw.warnings,
    banner: raw.banner,
    summary,
    companies,
    requests,
    cookies,
  };
}
