import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_COUNTRIES, parseIpinfo, checkLocation, chooseTimezone } from '../src/location.js';

test('allowed set is EU-27 + IS/LI/NO + GB', () => {
  assert.equal(ALLOWED_COUNTRIES.size, 31);
  for (const c of ['DE', 'FR', 'NL', 'IE', 'CY', 'IS', 'LI', 'NO', 'GB']) assert.ok(ALLOWED_COUNTRIES.has(c), c);
  for (const c of ['US', 'CH', 'CA', 'UK']) assert.ok(!ALLOWED_COUNTRIES.has(c), c);
});

test('parseIpinfo extracts ip, country, timezone', () => {
  assert.deepEqual(parseIpinfo({ ip: '1.2.3.4', country: 'NL', timezone: 'Europe/Amsterdam', city: 'x' }), {
    ip: '1.2.3.4', country: 'NL', timezone: 'Europe/Amsterdam',
  });
});

test('parseIpinfo tolerates a missing ip and timezone', () => {
  assert.deepEqual(parseIpinfo({ country: 'DE' }), { ip: null, country: 'DE', timezone: null });
});

test('parseIpinfo returns null for malformed responses', () => {
  for (const bad of [null, undefined, 'DE', 42, [], {}, { country: 5 }, { country: '' }, { country: 'Germany' }]) {
    assert.equal(parseIpinfo(bad), null, JSON.stringify(bad));
  }
});

for (const requireEu of [false, true]) {
  for (const country of ['DE', 'NO', 'GB']) {
    test(`checkLocation passes ${country} with no warning (requireEu=${requireEu})`, () => {
      const r = checkLocation({ ip: '1.2.3.4', country, timezone: 'Europe/Oslo' }, { requireEu });
      assert.equal(r.ok, true);
      assert.equal(r.error, null);
      assert.equal(r.warning, null);
      assert.equal(r.inAllowedRegion, true);
      assert.equal(r.exitCountry, country);
      assert.equal(r.exitIp, '1.2.3.4');
      assert.equal(r.exitTimezone, 'Europe/Oslo');
    });
  }
}

test('by default, a non-EU exit IP passes with a warning', () => {
  const r = checkLocation({ ip: '8.8.8.8', country: 'US', timezone: 'America/Chicago' }, { requireEu: false });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.inAllowedRegion, false);
  assert.equal(r.warning, 'Warning: exit IP 8.8.8.8 is in US, outside the EU/EEA/UK, so results may not match what EU visitors see. For a GDPR scan, connect a VPN to an EU server. Pass --require-eu to refuse non-EU scans.');
});

test('by default, a failed lookup passes with a warning', () => {
  const r = checkLocation(null, { requireEu: false });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.inAllowedRegion, false);
  assert.equal(r.warning, "Warning: couldn't verify the scan location, so results may not match what EU visitors see. Pass --require-eu to refuse unverified scans.");
  assert.equal(r.exitIp, null);
  assert.equal(r.exitCountry, null);
});

test('requireEu fails outside the EU/EEA/UK with the spec message', () => {
  const r = checkLocation({ ip: '8.8.8.8', country: 'US', timezone: 'America/Chicago' }, { requireEu: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Exit IP 8.8.8.8 is in US, outside the EU/EEA/UK. Connect your VPN to an EU server, or run without --require-eu.');
});

test('requireEu fails when the lookup failed', () => {
  const r = checkLocation(null, { requireEu: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, "Couldn't verify scan location. Check your connection, or run without --require-eu.");
  assert.equal(r.exitIp, null);
  assert.equal(r.exitCountry, null);
});

test('chooseTimezone: explicit --timezone wins', () => {
  assert.equal(chooseTimezone({ explicit: 'Europe/Paris', exitTimezone: 'Europe/Amsterdam' }), 'Europe/Paris');
});

test('chooseTimezone: exit-IP timezone is next', () => {
  assert.equal(chooseTimezone({ explicit: undefined, exitTimezone: 'Europe/Amsterdam' }), 'Europe/Amsterdam');
});

test('chooseTimezone: falls back to Europe/Berlin', () => {
  assert.equal(chooseTimezone({ explicit: undefined, exitTimezone: null }), 'Europe/Berlin');
});
