# Reliability

Plain Node.js (ESM), no frameworks. `postJson(url, body, headers)` stands in for a fetch wrapper with a timeout that throws an Error with `.status` on non-2xx responses. `db.query` is a Postgres-style client.

## 11. Timeouts

**Rule:** Every outbound call (HTTP, database, queue, DNS) needs a deadline so one slow dependency cannot hang your whole service. Set it from the dependency's normal response time and handle a timeout as a normal failure.

**BAD**

```js
const res = await fetch('https://api.example.com/rates'); // can hang for minutes
const rates = await res.json();
```

**GOOD**

```js
try {
  const res = await fetch('https://api.example.com/rates', { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Rates API returned ${res.status}`);
  return await res.json();
} catch (err) {
  if (err.name === 'TimeoutError') throw new Error('Rates API timed out after 3s', { cause: err });
  throw err;
}
```

## 12. Retry

**Rule:** Retry only temporary failures (timeouts, dropped connections, 429, 5xx) and only for operations that are safe to repeat, such as reads or writes sent with an idempotency key. Wait longer before each attempt using exponential backoff with random jitter, and cap the number of attempts.

**BAD**

```js
async function charge(order) {
  while (true) {
    try { return await postJson(PAY_URL, order); }
    catch { /* retries instantly, forever, and may charge the customer twice */ }
  }
}
```

**GOOD**

```js
const isTransient = (err) => err.name === 'TimeoutError' || err.cause?.code === 'ECONNRESET' || err.status === 429 || err.status >= 500;
async function withRetry(fn, attempts = 4, baseMs = 200) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1) * (0.5 + Math.random())));
    }
  }
}
// Safe to retry: the idempotency key makes the payment API charge only once.
await withRetry(() => postJson(PAY_URL, order, { 'Idempotency-Key': order.id }));
```

## 13. Circuit breaker

**Rule:** After a dependency fails several times in a row, stop calling it for a cooldown period and fail fast, using a fallback if you have one. When the cooldown ends, let one trial call through, and close the circuit again if it succeeds.

**BAD**

```js
// Rates API is down: every request still waits the full timeout, piling up until the server falls over.
const rates = await fetchRates();
```

**GOOD**

```js
function circuitBreaker(fn, { threshold = 5, cooldownMs = 30_000 } = {}) {
  let failures = 0, openUntil = 0;
  return async (...args) => {
    if (failures >= threshold && Date.now() < openUntil) throw new Error('Circuit open: failing fast');
    if (failures >= threshold) openUntil = Date.now() + cooldownMs; // half-open: one trial call
    try { const out = await fn(...args); failures = 0; return out; }
    catch (err) { if (++failures >= threshold) openUntil = Date.now() + cooldownMs; throw err; }
  };
}
const getRates = circuitBreaker(fetchRates); // create once, reuse on every request
const rates = await getRates().catch(() => cachedRates); // fallback while the API is down
```

## 14. Error handling

**Rule:** Log the full error (message, stack, and context like IDs) where you can see it, and show the user a short, calm message with no internals. Never catch an error and do nothing: handle it, rethrow it, or log it.

**BAD**

```js
try {
  await saveOrder(order);
} catch {} // swallowed: the user sees "saved" but the order is gone
res.end('Order saved');
// Elsewhere: catch (err) { res.end(err.stack); } shows file paths and SQL to the user.
```

**GOOD**

```js
import { randomUUID } from 'node:crypto';
try {
  await saveOrder(order);
  res.end('Order saved');
} catch (err) {
  const errorId = randomUUID();
  console.error(JSON.stringify({ errorId, message: err.message, stack: err.stack, orderId: order.id }));
  res.writeHead(500, { 'Content-Type': 'text/plain' });
  res.end(`Something went wrong saving your order. Please try again. (Ref: ${errorId})`);
}
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection', err); process.exit(1); });
```

## 15. Race conditions

**Rule:** If you read a value, decide, and then write (check-then-update), another request can change the value in between. Do the check and the update in one atomic step: a conditional UPDATE, a transaction with a row lock, or a unique constraint.

**BAD**

```js
const { rows } = await db.query('SELECT balance FROM accounts WHERE id = $1', [id]);
if (rows[0].balance < amount) throw new Error('Insufficient funds');
await db.query('UPDATE accounts SET balance = $1 WHERE id = $2', [rows[0].balance - amount, id]);
// Two withdrawals at the same moment both pass the check, and the account goes negative.
```

**GOOD**

```js
const { rowCount } = await db.query(
  'UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1', // check and write together
  [amount, id],
);
if (rowCount === 0) throw new Error('Insufficient funds');
```
