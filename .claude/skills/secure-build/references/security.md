# Security

Plain Node.js (ESM), no frameworks. Snippets run inside a request handler with `req` and `res` from `node:http`. Helpers like `readBody`, `readForm`, `getSession`, and `db` stand in for your own code.

## 1. TLS

**Rule:** Serve every page and API over HTTPS and send an HSTS header so browsers refuse to fall back to plain HTTP. Mark cookies Secure and HttpOnly, and never load scripts, images, or APIs over http:// from an https page.

**BAD**

```js
import http from 'node:http';

http.createServer((req, res) => {
  res.setHeader('Set-Cookie', `sid=${newSessionId()}`);
  res.end('<script src="http://cdn.example.com/app.js"></script>');
}).listen(80);
```

**GOOD**

```js
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
const tls = { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') };
https.createServer(tls, (req, res) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Set-Cookie', `sid=${newSessionId()}; Secure; HttpOnly; SameSite=Lax; Path=/`);
  res.end('<script src="https://cdn.example.com/app.js"></script>');
}).listen(443);
http.createServer((req, res) => res.writeHead(301, { Location: `https://example.com${req.url}` }).end()).listen(80);
```

## 2. Input validation

**Rule:** Check every input against a schema (type, length, format, allowed keys) at the point it enters your system. Reject anything that fails with a 400 before any business logic, database call, or side effect runs.

**BAD**

```js
const body = JSON.parse(await readBody(req)); // crashes on bad JSON
await db.users.update(body.id, body); // attacker can send { "role": "admin" }
res.end('ok');
```

**GOOD**

```js
const schema = {
  id: (v) => Number.isInteger(v) && v > 0,
  email: (v) => typeof v === 'string' && v.length <= 254 && /^[^@\s]+@[^@\s]+$/.test(v),
};
const isValid = (b) => b !== null && typeof b === 'object' &&
  Object.keys(b).every((k) => Object.hasOwn(schema, k)) &&
  Object.entries(schema).every(([k, check]) => check(b[k]));
let body; try { body = JSON.parse(await readBody(req)); } catch { body = null; }
if (!isValid(body)) return res.writeHead(400).end('Invalid input');
await db.users.update(body.id, { email: body.email });
```

## 3. XSS

**Rule:** Never put user-controlled text into HTML, attributes, or scripts without escaping it for that context. Escape on output (or use `textContent` in the browser), and add a Content-Security-Policy as a second line of defense.

**BAD**

```js
const name = new URL(req.url, 'http://localhost').searchParams.get('name');
res.setHeader('Content-Type', 'text/html');
res.end(`<h1>Hello ${name}</h1>`); // ?name=<script>stealCookies()</script>
```

**GOOD**

```js
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const name = new URL(req.url, 'http://localhost').searchParams.get('name') ?? '';
res.setHeader('Content-Type', 'text/html; charset=utf-8');
res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'");
res.end(`<h1>Hello ${escapeHtml(name)}</h1>`);
```

## 4. CSRF

**Rule:** A route that changes data and trusts a session cookie must prove the request came from your own pages, because browsers attach cookies to requests from any site. Set SameSite=Lax or Strict on the session cookie and require a per-session CSRF token on every POST, PUT, PATCH, and DELETE.

**BAD**

```js
// Session cookie has no SameSite, and there is no token: any site can post this form.
if (req.method === 'POST' && req.url === '/transfer') {
  const session = getSession(req);
  await transfer(session.userId, await readForm(req));
  res.end('done');
}
```

**GOOD**

```js
import { timingSafeEqual } from 'node:crypto';
// At login: session.csrf = randomBytes(32).toString('hex'), cookie set with SameSite=Lax.
const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);
if (req.method === 'POST' && req.url === '/transfer') {
  const session = getSession(req);
  const form = await readForm(req); // the page's form includes <input type="hidden" name="csrf">
  const sent = Buffer.from(String(form.csrf ?? ''));
  if (!safeEqual(sent, Buffer.from(session.csrf))) return res.writeHead(403).end('Forbidden');
  await transfer(session.userId, form);
  res.end('done');
}
```

## 5. CORS

**Rule:** Only send Access-Control-Allow-Origin for origins on an explicit allowlist of your own sites. Never use `*` on private APIs and never echo back whatever Origin the request sent.

**BAD**

```js
// Reflecting Origin with credentials lets any website read your users' data.
res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

**GOOD**

```js
const ALLOWED = new Set(['https://app.example.com', 'https://admin.example.com']);
const origin = req.headers.origin;
if (origin && ALLOWED.has(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}
res.setHeader('Vary', 'Origin'); // keeps caches from serving one origin's answer to another
```

## 6. SSRF

**Rule:** When your server fetches a URL a user gave you, allow only https, resolve the hostname yourself, and refuse private, loopback, link-local, and cloud metadata addresses. Check the resolved IP rather than the hostname, connect to that exact IP so DNS cannot change between the check and the request, and do not follow redirects.

**BAD**

```js
const { url } = JSON.parse(await readBody(req));
const upstream = await fetch(url); // http://169.254.169.254/latest/meta-data/ leaks cloud keys
res.end(await upstream.text());
```

**GOOD**

```js
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';
const blocked = new BlockList();
['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.168.0.0/16'].forEach((cidr) => { const [ip, bits] = cidr.split('/'); blocked.addSubnet(ip, +bits); });
const url = new URL(userUrl); if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed');
const { address } = await lookup(url.hostname, { family: 4 }); // IPv4 only, so IPv6 tricks fail closed
if (blocked.check(address)) throw new Error(`Blocked address ${address}`);
https.get({ host: address, port: url.port || 443, servername: url.hostname, path: url.pathname + url.search,
  headers: { host: url.host }, timeout: 5000 }, onResponse); // pinned to the checked IP, no redirects
```

## 7. Hashing

**Rule:** Store only a password hash made with a slow, salted algorithm such as scrypt, bcrypt, or Argon2, never the password itself or a fast hash like SHA-256 or MD5. Use a new random salt for every password and store it next to the hash.

**BAD**

```js
import { createHash } from 'node:crypto';
const hash = createHash('sha256').update(password).digest('hex'); // fast and unsalted: cracked in hours
await db.users.insert({ email, password: hash });
```

**GOOD**

```js
import { scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(scrypt);
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }; // about 32 MB of memory per hash
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, PARAMS);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
await db.users.insert({ email, passwordHash: await hashPassword(password) });
```

## 8. Authentication

**Rule:** Re-hash the submitted password with the stored salt and compare in constant time, and return the same generic error whether the email or the password was wrong. On success, issue a long random session token, store it on the server, and send it in a Secure, HttpOnly cookie.

**BAD**

```js
const user = await db.users.findByEmail(email);
if (!user) return res.writeHead(401).end('No such user'); // tells attackers which emails exist
if (user.password !== password) return res.writeHead(401).end('Wrong password'); // plain-text compare
res.setHeader('Set-Cookie', `user=${user.id}`); // guessable, forgeable "session"
```

**GOOD**

```js
import { randomBytes, timingSafeEqual } from 'node:crypto'; // scryptAsync, PARAMS, hashPassword: see Hashing
async function verifyPassword(password, stored) {
  const [, salt, key] = stored.split('$').map((part) => Buffer.from(part, 'hex'));
  return timingSafeEqual(await scryptAsync(password, salt, 64, PARAMS), key);
}
const user = await db.users.findByEmail(email); // unknown email still hashes, so timing matches
const ok = user ? await verifyPassword(password, user.passwordHash) : (await hashPassword(password), false);
if (!ok) return res.writeHead(401).end('Invalid email or password');
const token = randomBytes(32).toString('hex');
await db.sessions.insert({ token, userId: user.id, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
res.setHeader('Set-Cookie', `sid=${token}; Secure; HttpOnly; SameSite=Lax; Path=/`);
```

## 9. Authorization

**Rule:** Every protected action must check that the user's role allows it AND that the specific record belongs to them. Never trust an ID from the URL or body on its own; load the record and compare its owner to the logged-in user.

**BAD**

```js
const user = await requireUser(req); // logged in, so far so good
await db.invoices.delete(invoiceId); // but anyone can delete anyone's invoice by changing the ID
res.end('deleted');
```

**GOOD**

```js
const user = await requireUser(req); // 401 if not logged in
if (!['owner', 'billing'].includes(user.role)) return res.writeHead(403).end('Forbidden');
const invoice = await db.invoices.findById(invoiceId);
if (!invoice || invoice.accountId !== user.accountId) {
  return res.writeHead(404).end('Not found'); // 404, so other accounts' IDs are not confirmed
}
await db.invoices.delete(invoice.id);
res.end('deleted');
```

## 10. Brute force

**Rule:** Count failed logins per account, and after N failures lock further attempts for a cooldown period. Reset the counter on a successful login, and keep the error message generic so lockouts do not reveal which accounts exist.

**BAD**

```js
const ok = await checkCredentials(email, password);
if (!ok) return res.writeHead(401).end('Invalid email or password');
// No limit: an attacker can try millions of passwords against one account.
```

**GOOD**

```js
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // email -> { count, until }. Use Redis or the DB if you run more than one instance.
const key = email.toLowerCase();
const entry = fails.get(key) ?? { count: 0, until: 0 };
if (entry.until > Date.now()) return res.writeHead(429).end('Too many attempts. Try again in 15 minutes.');
if (!(await checkCredentials(email, password))) {
  fails.set(key, ++entry.count >= MAX_FAILS ? { count: 0, until: Date.now() + LOCK_MS } : entry);
  return res.writeHead(401).end('Invalid email or password');
}
fails.delete(key);
```
