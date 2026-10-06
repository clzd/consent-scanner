// Exit-IP lookup and the EU/EEA/UK check. The lookup goes through Node's fetch,
// never the scan browser, so it can't show up in the scan results.

export const IPINFO_URL = 'https://ipinfo.io/json';
export const LOOKUP_TIMEOUT_MS = 5000;
export const FALLBACK_TIMEZONE = 'Europe/Berlin';

// EU-27, the rest of the EEA (IS, LI, NO), and GB.
export const ALLOWED_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB',
]);

const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

/** Pull { ip, country, timezone } out of an ipinfo response body, or null if it's malformed. */
export function parseIpinfo(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.country !== 'string' || !/^[A-Z]{2}$/.test(body.country)) return null;
  return { ip: str(body.ip), country: body.country, timezone: str(body.timezone) };
}

/** Fetch the exit location. Returns parsed info, or null on network error, timeout, or a malformed response. */
export async function lookupExitLocation(url = process.env.CONSENT_SCANNER_IPINFO_URL || IPINFO_URL) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseIpinfo(await res.json());
  } catch {
    return null;
  }
}

/**
 * Decide whether the scan may proceed. `info` is the parsed lookup, or null if it failed.
 * By default a non-EU or unverified location only produces a warning; `requireEu` refuses it.
 */
export function checkLocation(info, { requireEu }) {
  const inAllowedRegion = Boolean(info && ALLOWED_COUNTRIES.has(info.country));
  const ip = info?.ip ?? 'unknown';
  let error = null;
  let warning = null;
  if (!inAllowedRegion && requireEu) {
    error = info
      ? `Exit IP ${ip} is in ${info.country}, outside the EU/EEA/UK. Connect your VPN to an EU server, or run without --require-eu.`
      : "Couldn't verify scan location. Check your connection, or run without --require-eu.";
  } else if (!inAllowedRegion) {
    warning = info
      ? `Warning: exit IP ${ip} is in ${info.country}, outside the EU/EEA/UK, so results may not match what EU visitors see. For a GDPR scan, connect a VPN to an EU server. Pass --require-eu to refuse non-EU scans.`
      : "Warning: couldn't verify the scan location, so results may not match what EU visitors see. Pass --require-eu to refuse unverified scans.";
  }
  return {
    ok: error === null,
    error,
    warning,
    inAllowedRegion,
    exitIp: info?.ip ?? null,
    exitCountry: info?.country ?? null,
    exitTimezone: info?.timezone ?? null,
  };
}

/** An explicit --timezone wins, then the exit IP's timezone, then Europe/Berlin. */
export function chooseTimezone({ explicit, exitTimezone }) {
  return explicit || exitTimezone || FALLBACK_TIMEZONE;
}
