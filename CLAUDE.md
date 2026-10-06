# consent-scanner

Spec: SPEC.md. Node ≥ 20, ESM.

- One-time setup: `npm install && npx playwright install chromium`. The integration tests launch real Chromium.
- Tests: `npm test` runs everything (~3s), `npm run test:unit` skips the browser, `node --test test/<file>` runs one file.
- `src/scan.js` is the only file allowed to import Playwright. Everything else is pure and tested from `test/fixtures/raw.json`.
- `CONSENT_SCANNER_IPINFO_URL` is the only test hook. Integration tests point it at a local stub. Don't add others.
- A hook runs `npm test` after every Edit/Write but shows only the last 80 lines of a failure. Rerun the failing file for the full output.
- Scans run from anywhere and warn when not in the EU/EEA/UK. `--require-eu` makes that a hard exit `2`.
