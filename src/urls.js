// Turns user input into scannable URLs: one URL argument, or a --urls list file.
export const MAX_BATCH_URLS = 10;

export class InputError extends Error {}

/** Adds https:// when the scheme is missing. Only http and https pass. */
export function normalizeUrl(input) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InputError(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InputError(`Only http and https URLs can be scanned, not ${url.protocol}// (from ${input}).`);
  }
  return url.href;
}

/** One URL per line. Blank lines and lines starting with # are skipped, duplicates dropped. */
export function parseUrlList(text, max = MAX_BATCH_URLS) {
  const urls = new Set();
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    try {
      urls.add(normalizeUrl(trimmed));
    } catch (err) {
      throw new InputError(`Line ${i + 1}: ${err.message}`);
    }
  });
  if (urls.size === 0) throw new InputError('The URL list has no URLs. Put one URL per line.');
  if (urls.size > max) throw new InputError(`The URL list has ${urls.size} URLs; the limit is ${max}.`);
  return [...urls];
}
