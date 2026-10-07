---
name: secure-build
description: "Use when writing or reviewing code that fetches URLs, handles user input, calls external services, stores credentials, or needs to stay up under failure. Covers security (TLS, input validation, XSS, CSRF, CORS, SSRF, hashing, auth, authorization, brute force) and reliability (timeouts, retry, circuit breaker, error handling, race conditions)."
---

# Secure Build

Fifteen rules that stop the most common security holes and outage causes in server code. Each rule has a BAD and GOOD Node.js example in the reference files.

## When to use

- Writing a route, handler, or API that takes input from users or other systems.
- Adding login, sessions, passwords, roles, or anything that touches credentials.
- Fetching a URL, calling a third-party API, or talking to a database or queue.
- Reviewing a pull request for security or reliability problems.

## Checklist

Go through every item that applies before calling the code done.

**Security**

1. **TLS:** HTTPS only, HSTS header set, cookies marked Secure, no http:// assets.
2. **Input validation:** every input is schema-checked at the boundary and rejected with 400 before logic runs.
3. **XSS:** user input is escaped for its context before it reaches a page.
4. **CSRF:** cookie-authenticated routes that change state need a CSRF token or SameSite cookies.
5. **CORS:** Access-Control-Allow-Origin comes from an allowlist of your origins, never `*` or a reflected Origin.
6. **SSRF:** user-supplied URLs are limited to safe schemes, and the resolved IP is checked against private ranges.
7. **Hashing:** passwords are stored as salted, slow hashes (scrypt, bcrypt, Argon2), never plain or SHA/MD5.
8. **Authentication:** credentials are verified with a constant-time hash compare, then a random session token is issued.
9. **Authorization:** every protected action checks the user's role AND that they own the record.
10. **Brute force:** logins lock out after N failures for a cooldown period.

**Reliability**

11. **Timeouts:** every outbound call has a timeout.
12. **Retry:** retries use exponential backoff with jitter, capped, and only on idempotent or keyed operations.
13. **Circuit breaker:** repeated failures open the circuit, calls fail fast, and a trial call closes it later.
14. **Error handling:** full detail goes to logs, a calm message goes to the user, nothing is swallowed.
15. **Race conditions:** check-then-update happens in one atomic step (conditional update, lock, or unique constraint).

## References

- [references/security.md](references/security.md): rules 1 to 10, each with a rule, a BAD example, and a GOOD example.
- [references/reliability.md](references/reliability.md): rules 11 to 15, same format.

Read the block for any checklist item you are applying or reviewing. Copy the GOOD pattern, not the BAD one.
