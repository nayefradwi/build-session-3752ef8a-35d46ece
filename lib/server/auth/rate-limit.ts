import "server-only";

/**
 * Lightweight in-memory token-bucket-ish rate limiter for brute-force
 * protection on credential sign-in. Designed for the lambda-warm case on
 * Vercel: the map lives for the lifetime of a single Node.js instance, so
 * across cold starts an attacker effectively gets a fresh budget. That is
 * acceptable for an MVP — for stronger guarantees, swap the storage for
 * `@upstash/ratelimit` backed by Redis without changing the call sites.
 *
 * The store is keyed by a string (typically `${ip}:${email}`) and tracks the
 * sliding-window timestamps of recent attempts. Each call to `checkLimit`
 * either records the attempt and returns `{ ok: true }`, or returns
 * `{ ok: false, retryAfterMs }` if the caller is over budget.
 */

export interface RateLimitOptions {
  /** Max attempts allowed within the window. */
  limit: number;
  /** Sliding window length, in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** When `ok` is false, the suggested wait before the next attempt. */
  retryAfterMs?: number;
  /** Remaining attempts in the current window after this call. */
  remaining: number;
}

/** Default policy: 5 attempts per minute per (ip, email) pair. */
export const LOGIN_RATE_LIMIT: RateLimitOptions = {
  limit: 5,
  windowMs: 60_000,
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
 * Returns whether the attempt is allowed and how many remain.
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
    const retryAfterMs = Math.max(0, oldest + options.windowMs - now);
    // Persist the trimmed list so the store doesn't grow unboundedly.
    store.set(key, recent);
    return { ok: false, retryAfterMs, remaining: 0 };
  }

  recent.push(now);
  store.set(key, recent);
  return { ok: true, remaining: options.limit - recent.length };
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
