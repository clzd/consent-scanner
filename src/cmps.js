// Consent-management platform signatures, checked in order; the first match wins.
// `global` is a window property name, `selector` a DOM selector. Either may be null.
export const CMPS = [
  { name: 'OneTrust', global: 'OneTrust', selector: '#onetrust-banner-sdk' },
  { name: 'Cookiebot', global: 'Cookiebot', selector: '#CybotCookiebotDialog' },
  { name: 'Didomi', global: 'Didomi', selector: '#didomi-host' },
  { name: 'Usercentrics', global: 'UC_UI', selector: '#usercentrics-root' },
  { name: 'TrustArc', global: 'truste', selector: '#truste-consent-track' },
  { name: 'Quantcast Choice', global: null, selector: '.qc-cmp2-container' },
  { name: 'Google Funding Choices', global: null, selector: '.fc-consent-root' },
  { name: 'Generic IAB TCF CMP', global: '__tcfapi', selector: null },
];
