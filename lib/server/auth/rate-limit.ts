import "server-only";

/**
 * Lightweight in-memory token-bucket-ish rate limiter for brute-force
 * protection on the auth surface. Designed for the lambda-warm case on
 * Vercel: the map lives for the lifetime of a single Node.js instance, so
 * across cold starts an attacker effectively gets a fresh budget. That is
 * acceptable for an MVP — for stronger guarantees, swap the storage for
 * `@upstash/ratelimit` backed by Redis without changing the call sites.
 *
 * The store is keyed by a string (typically `${ip}:${email}` for login or
 * `${prefix}:${ip}` for IP-only policies) and tracks the sliding-window
 * timestamps of recent attempts. Each call to `checkLimit` either records
 * the attempt and returns `{ ok: true, ... }`, or returns
 * `{ ok: false, retryAfterMs, ... }` if the caller is over budget.
 */

export interface RateLimitOptions {
  /** Max attempts allowed within the window. */
  limit: number;
  /** Sliding window length, in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Echoes the configured policy limit for header building. */
  limit: number;
  /** Remaining attempts in the current window after this call. */
  remaining: number;
  /**
   * Epoch milliseconds at which the oldest in-window attempt rolls off,
   * which is also when the next attempt is guaranteed to be allowed.
   * Always populated so callers can build `X-RateLimit-Reset` consistently.
   */
  resetAt: number;
  /** When `ok` is false, the suggested wait before the next attempt. */
  retryAfterMs?: number;
}

/**
 * Per (ip, email) login policy used inside the NextAuth credentials
 * `authorize` callback. Tighter than the broad per-IP auth policy below so
 * a single attacker can't burn the password space against one user.
 */
export const LOGIN_RATE_LIMIT: RateLimitOptions = {
  limit: 5,
  windowMs: 60_000,
};

/**
 * Broader per-IP auth policy applied to both `POST /api/auth/register` and
 * the NextAuth credentials POST. Caps total auth-surface activity from a
 * single IP at 10 attempts every 15 minutes, regardless of which email or
 * organization name they target.
 */
export const AUTH_RATE_LIMIT: RateLimitOptions = {
  limit: 10,
  windowMs: 15 * 60_000,
};

// Use a module-level Map so the limiter is shared across requests within the
// same Node.js process. We store it on globalThis so that Next.js dev-mode
// hot reloading doesn't reset state on every code edit.
const GLOBAL_KEY = Symbol.for("@app/login-rate-limit-store");

type Store = Map<string, number[]>;

function getStore(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  let store = g[GLOBAL_KEY];
  if (!store) {
    store = new Map<string, number[]>();
    g[GLOBAL_KEY] = store;
  }
  return store;
}

/**
 * Record an attempt for `key`, applying the sliding-window policy.
 * Returns whether the attempt is allowed, how many remain, and the epoch
 * ms timestamp when the next attempt is guaranteed to be allowed.
 */
export function checkLimit(
  key: string,
  options: RateLimitOptions = LOGIN_RATE_LIMIT,
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - options.windowMs;
  const store = getStore();

  const existing = store.get(key) ?? [];
  // Drop timestamps outside the window before evaluating.
  const recent = existing.filter((ts) => ts > cutoff);

  if (recent.length >= options.limit) {
    // Oldest in-window attempt determines when budget frees up.
    const oldest = recent[0];
    const resetAt = oldest + options.windowMs;
    const retryAfterMs = Math.max(0, resetAt - now);
    // Persist the trimmed list so the store doesn't grow unboundedly.
    store.set(key, recent);
    return {
      ok: false,
      limit: options.limit,
      remaining: 0,
      resetAt,
      retryAfterMs,
    };
  }

  recent.push(now);
  store.set(key, recent);
  // After this attempt, the bucket frees up once the oldest in-window
  // timestamp ages out. With only the just-recorded attempt in the bucket
  // that is `now + windowMs`.
  const resetAt = recent[0] + options.windowMs;
  return {
    ok: true,
    limit: options.limit,
    remaining: options.limit - recent.length,
    resetAt,
  };
}

/**
 * Reset the bucket for `key`. Useful after a successful sign-in so the user
 * doesn't get penalized for past failed attempts.
 */
export function resetLimit(key: string): void {
  getStore().delete(key);
}

/**
 * Best-effort extraction of the client IP from a request. Vercel sets the
 * `x-forwarded-for` header (comma-separated, leftmost is the original client).
 * Falls back to a fixed sentinel so the limiter still works locally.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/**
 * Build the standard rate-limit response headers for a given result.
 * Returns `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
 * (Unix-seconds — the de-facto convention used by GitHub, Stripe, etc.),
 * and — only when the request was blocked — a `Retry-After` header
 * expressed in seconds (RFC 7231 §7.1.3).
 *
 * Pass the returned object straight into `NextResponse.json(body, { headers })`
 * or merge into an existing `Headers` instance.
 */
export function buildRateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
  if (!result.ok && typeof result.retryAfterMs === "number") {
    // Retry-After must be a non-negative integer count of seconds. Round up
    // so we never tell a client to retry before the window actually frees.
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
    );
  }
  return headers;
}
