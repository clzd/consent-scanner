// Renders the classified result as a plain-language Markdown report and as JSON.
import { ALLOWED_COUNTRIES } from './location.js';
import { UNRECOGNIZED } from './classify.js';
import { code, cell } from './markdown.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COUNTRIES_WITH_THE = new Set(['NL', 'GB', 'US', 'AE', 'PH']);
const URL_LIMIT = 120;

const CATEGORY_LABELS = {
  advertising: 'advertising',
  analytics: 'analytics',
  social: 'social media',
  'session-replay': 'session recording',
  'tag-manager': 'tag management',
  'consent-management': 'consent management',
  cdn: 'content delivery',
  fonts: 'web fonts',
  other: 'other',
};

const COOKIE_PURPOSES = {
  analytics: 'identifies you across visits to measure how the site is used',
  advertising: 'lets advertisers recognize you and measure their ads',
  social: 'lets a social network recognize you',
  'session-replay': 'helps record how you use the page',
  'tag-manager': 'used by a tag manager',
  'consent-management': 'stores consent choices',
};

const CAVEAT = 'Some third-party requests (content delivery networks, web fonts, the consent tool itself) may be strictly necessary, and this report is not legal advice.';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function verdictLine(result) {
  if (result.blocked.detected) return 'This scan is unreliable: the site showed a bot check instead of the real page.';
  const { hasFindings, companies, trackingCookies } = result.summary;
  if (!hasFindings) return 'No third-party trackers or tracking cookies were detected before consent.';
  const parts = [];
  if (companies > 0) parts.push(`contacted ${plural(companies, 'outside company', 'outside companies')}`);
  if (trackingCookies > 0) parts.push(`set ${plural(trackingCookies, 'tracking cookie', 'tracking cookies')}`);
  return `Before any consent was given, this page ${parts.join(' and ')}.`;
}

function formatDate(iso) {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

function countryPhrase(code) {
  if (!code) return 'an unknown location';
  let name = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {}
  return COUNTRIES_WITH_THE.has(code) ? `the ${name}` : name;
}

function duration(expires, scannedAt) {
  if (!expires) return 'deleted when you close the browser';
  const days = (Date.parse(expires) - Date.parse(scannedAt)) / 86_400_000;
  if (days <= 0) return 'already expired';
  if (days >= 365 * 0.95) return `lasts ${plural(Math.round(days / 365), 'year', 'years')}`;
  if (days >= 28) return `lasts ${plural(Math.round(days / 30.44), 'month', 'months')}`;
  if (days >= 1) return `lasts ${plural(Math.round(days), 'day', 'days')}`;
  return `lasts ${plural(Math.max(1, Math.round(days * 24)), 'hour', 'hours')}`;
}

function truncate(url) {
  return url.length > URL_LIMIT ? `${url.slice(0, URL_LIMIT - 1)}…` : url;
}

const EU_WARNING = '⚠️ This scan did not come from an EU location, so it may not reflect what EU visitors see.';

function introSection(result) {
  const { input, environment: env, scannedAt } = result;
  const out = [`**${verdictLine(result)}**`];
  if (!ALLOWED_COUNTRIES.has(env.exitCountry)) out.push(EU_WARNING);
  if (result.blocked.detected) {
    out.push(`${result.blocked.reason} Sites often treat VPN addresses as suspicious. Try again with your VPN connected to a different VPN server.`);
  }
  out.push(
    `Scanned ${code(input.finalUrl || input.url)} on ${formatDate(scannedAt)}, from ${countryPhrase(env.exitCountry)} ` +
    `(browser set to ${env.locale}, ${env.timezone}). We loaded the page in a fresh browser, didn't click anything, ` +
    `and recorded activity for ${plural(input.waitSeconds, 'second', 'seconds')} after the page finished loading.`,
  );
  return out;
}

function bannerSection({ banner }, h = '##') {
  let text;
  if (!banner.detected) {
    text = "We didn't recognize a consent banner on this page. The site may use a consent tool we don't know about, or it may not show one at all.";
  } else if (banner.visible === true) {
    text = `A ${banner.cmp} consent banner was found and was visible. Everything below happened while it was still waiting for an answer.`;
  } else if (banner.visible === false) {
    text = `A ${banner.cmp} consent banner was found, but it wasn't visible on screen when the scan ended. Everything below happened before anyone answered it.`;
  } else {
    text = `A ${banner.cmp} consent tool was detected on the page, but we couldn't tell whether its banner was showing. Everything below happened before anyone answered it.`;
  }
  return [`${h} Consent banner`, text];
}

function companiesSection({ companies }, h = '##', domainsListedIn = 'the appendix') {
  const out = [`${h} Who was contacted`];
  if (companies.length === 0) {
    out.push("This page didn't contact any outside companies before consent.");
    return out;
  }
  out.push(
    'Each row is an outside company the page contacted. A *request* is your browser asking that company\'s server for something, ' +
    'such as an image or a piece of code. Every request tells the company your IP address and which page you were on. ' +
    'A *script* is code from that company that runs inside the page and can collect information about your visit.',
  );
  const rows = [
    '| Company | What it does | Requests | Scripts loaded | Cookies set |',
    '|---|---|---|---|---|',
  ];
  for (const c of companies) {
    const name = c.company === UNRECOGNIZED ? 'Unrecognized third party' : c.company;
    const what = c.categories.length ? capitalize(c.categories.map((k) => CATEGORY_LABELS[k] ?? k).join(', ')) : '—';
    const cookies = c.cookies.length ? c.cookies.map(code).join(', ') : '—';
    rows.push(`| ${cell(name)} | ${cell(what)} | ${c.requests} | ${c.scripts} | ${cell(cookies)} |`);
  }
  out.push(rows.join('\n'));
  const unknown = companies.find((c) => c.company === UNRECOGNIZED);
  if (unknown) {
    out.push(`"Unrecognized third party" means an outside server that isn't on our list of known companies (${plural(unknown.domains.length, 'domain', 'domains')}, listed in ${domainsListedIn}).`);
  }
  return out;
}

function cookiesSection({ cookies, scannedAt }, h = '##') {
  const out = [`${h} Cookies`];
  if (cookies.length === 0) {
    out.push('No cookies were set.');
    return out;
  }
  out.push('Cookies are small files a website stores in your browser so it can recognize you later. Tracking cookies are the ones used to follow you across visits or across websites.');
  const tracking = cookies.filter((c) => c.tracker);
  const others = cookies.length - tracking.length;
  if (tracking.length) {
    out.push('These tracking cookies were set before consent:');
    out.push(tracking.map((c) => {
      const purpose = COOKIE_PURPOSES[c.tracker.category] ?? 'used for tracking';
      return `- ${code(c.name)} — ${c.tracker.service}, ${purpose}, ${duration(c.expires, scannedAt)}`;
    }).join('\n'));
    if (others) {
      out.push(`${others === 1 ? '1 other cookie was' : `${others} other cookies were`} also set. They aren't on our list of known tracking cookies, and they may be needed for the site to work.`);
    }
  } else {
    out.push(`No known tracking cookies were set. ${others === 1 ? '1 cookie was' : `${others} cookies were`} set that aren't on our list of known tracking cookies; they may be needed for the site to work.`);
  }
  return out;
}

function meaningSection({ summary }) {
  const text = summary.hasFindings
    ? 'Outside companies were contacted, or tracking cookies were set, before anyone answered the consent banner. ' +
      'Privacy rules in the EU and UK generally require consent before tracking, so this is worth reviewing with whoever runs the site. '
    : "We didn't see any outside tracking before consent during this visit. ";
  return ['## What this means', text + CAVEAT];
}

const LIMITATIONS = [
  'One page, one visit, no scrolling or clicking. Some trackers only fire on interaction.',
  "The scan's location is the VPN server's location. Sites can treat known VPN addresses differently from home connections.",
];

function limitationsSection({ warnings }) {
  const items = [...LIMITATIONS, ...warnings];
  return ['## Limitations', items.map((w) => `- ${w}`).join('\n')];
}

function appendixSection({ requests }) {
  const out = ['## Appendix: all third-party requests'];
  const byDomain = new Map();
  for (const r of requests) {
    if (r.party !== 'third') continue;
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    byDomain.get(r.domain).push(r);
  }
  if (byDomain.size === 0) {
    out.push('None.');
    return out;
  }
  for (const domain of [...byDomain.keys()].sort()) {
    out.push(`### ${domain}`);
    out.push(byDomain.get(domain).map((r) => {
      const status = r.failed ? 'failed' : (r.status ?? 'no response');
      return `- ${r.resourceType}, ${status} — ${code(truncate(r.url))}`;
    }).join('\n'));
  }
  return out;
}

export function renderMarkdown(result) {
  const host = new URL(result.input.finalUrl || result.input.url).hostname;
  return [
    `# Consent scan: ${host}`,
    ...introSection(result),
    ...bannerSection(result),
    ...companiesSection(result),
    ...cookiesSection(result),
    ...meaningSection(result),
    ...limitationsSection(result),
    ...appendixSection(result),
  ].join('\n\n') + '\n';
}

export function renderJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

// Batch report: one summary table, then a short section per URL. Per-request detail stays in each JSON.

const hostOf = (url) => new URL(url).hostname;

export function batchVerdict(entries) {
  const n = entries.length;
  const scanned = entries.filter((e) => e.result);
  const findings = scanned.filter((e) => !e.result.blocked.detected && e.result.summary.hasFindings).length;
  const blocked = scanned.filter((e) => e.result.blocked.detected).length;
  const failed = n - scanned.length;
  const out = [];
  if (findings === 0 && blocked === 0 && failed === 0) {
    out.push(`No third-party trackers or tracking cookies were detected before consent on any of the ${plural(n, 'page', 'pages')}.`);
  } else {
    out.push(`Before any consent was given, ${findings} of ${plural(n, 'page', 'pages')} contacted outside companies or set tracking cookies.`);
  }
  if (blocked) out.push(`${plural(blocked, 'page', 'pages')} showed a bot check instead of the real page.`);
  if (failed) out.push(`${plural(failed, 'page', 'pages')} couldn't be scanned.`);
  return out.join(' ');
}

function batchRow({ url, result }) {
  if (!result) return `| ${cell(code(url))} | Scan failed | n/a | n/a | n/a |`;
  const { summary, blocked } = result;
  const status = blocked.detected ? 'Blocked by a bot check' : summary.hasFindings ? 'Findings' : 'No findings';
  const cookies = summary.trackingCookies ? `${summary.cookies} (${summary.trackingCookies} tracking)` : `${summary.cookies}`;
  return `| ${cell(code(url))} | ${status} | ${summary.companies} | ${cookies} | ${summary.thirdPartyScripts} |`;
}

function batchSummarySection(entries) {
  return [
    '## Summary',
    [
      '| URL | Result | Third parties | Cookies | Scripts before consent |',
      '|---|---|---|---|---|',
      ...entries.map(batchRow),
    ].join('\n'),
    '*Third parties* are the outside companies each page contacted. *Cookies* counts every cookie set, with the tracking ones in brackets. ' +
    '*Scripts before consent* are pieces of code from outside companies that ran in the page before anyone answered the consent banner. ' +
    'A page marked "Blocked by a bot check" showed a challenge instead of the real page, so its numbers are unreliable.',
  ];
}

const fileLink = (name) => `[${name}](${name})`;

function batchPageSection({ url, result, error, files }, i, saveHtml) {
  if (!result) {
    return [`## ${i + 1}. ${hostOf(url)}`, code(url), "**This page couldn't be scanned.**", code(error)];
  }
  const out = [`## ${i + 1}. ${hostOf(result.input.finalUrl || url)}`, `**${verdictLine(result)}**`];
  if (result.blocked.detected) out.push(result.blocked.reason);
  const finalUrl = result.input.finalUrl && result.input.finalUrl !== url ? `, which ended up at ${code(result.input.finalUrl)}` : '';
  out.push(`Scanned ${code(url)}${finalUrl}.`);
  if (files.html) out.push(`Full data: ${fileLink(files.json)}. Rendered HTML: ${fileLink(files.html)}.`);
  else if (saveHtml) out.push(`Full data: ${fileLink(files.json)}. The rendered HTML couldn't be saved.`);
  else out.push(`Full data: ${fileLink(files.json)}.`);
  out.push(...bannerSection(result, '###'), ...companiesSection(result, '###', 'the JSON file'), ...cookiesSection(result, '###'));
  if (result.warnings.length) out.push('### Warnings', result.warnings.map((w) => `- ${w}`).join('\n'));
  return out;
}

function batchMeaningSection() {
  return [
    '## What this means',
    'Pages marked "Findings" contacted outside companies, or set tracking cookies, before anyone answered the consent banner. ' +
    'Privacy rules in the EU and UK generally require consent before tracking, so those pages are worth reviewing with whoever runs the site. ' +
    CAVEAT,
  ];
}

/**
 * @param {{ startedAt: string, waitSeconds: number, locale: string, timezone: string, exitCountry: string|null,
 *   saveHtml?: boolean, entries: { url: string, result: object|null, error: string|null, files: { json: string, html: string|null }|null }[] }} batch
 */
export function renderBatchMarkdown({ startedAt, waitSeconds, locale, timezone, exitCountry, saveHtml = false, entries }) {
  const intro = [`**${batchVerdict(entries)}**`];
  if (!ALLOWED_COUNTRIES.has(exitCountry)) intro.push(EU_WARNING);
  intro.push(
    `Scanned on ${formatDate(startedAt)}, from ${countryPhrase(exitCountry)} (browser set to ${locale}, ${timezone}). ` +
    "Each page was loaded in its own fresh browser, nothing was clicked, and activity was recorded for " +
    `${plural(waitSeconds, 'second', 'seconds')} after each page finished loading.`,
  );
  return [
    `# Consent scan batch: ${plural(entries.length, 'page', 'pages')}`,
    ...intro,
    ...batchSummarySection(entries),
    ...entries.flatMap((e, i) => batchPageSection(e, i, saveHtml)),
    ...batchMeaningSection(),
    '## Limitations',
    [...LIMITATIONS, "Each page's own warnings are listed in its section."].map((w) => `- ${w}`).join('\n'),
  ].join('\n\n') + '\n';
}
