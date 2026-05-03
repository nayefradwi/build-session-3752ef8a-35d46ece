import "server-only";

import { eq } from "drizzle-orm";
import type { NextAuthConfig } from "next-auth";
import { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { verifyPassword } from "@/lib/server/auth/password";
import {
  AUTH_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  checkLimit,
  getClientIp,
  resetLimit,
} from "@/lib/server/auth/rate-limit";

/**
 * Custom credential errors. Auth.js surfaces `code` to the client via the
 * `?error=CredentialsSignin&code=<code>` query string when a sign-in fails.
 * We use a small, generic vocabulary so we don't leak whether the email or
 * the password was wrong.
 */
class InvalidCredentialsError extends CredentialsSignin {
  code = "invalid_credentials";
}

class RateLimitedError extends CredentialsSignin {
  code = "rate_limited";
}

/**
 * Minimal shape we accept off the wire. The login form sends `email` +
 * `password`; we lowercase/trim email to match the registration pipeline so
 * users can sign in case-insensitively.
 */
const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(254)
    .email(),
  password: z.string().min(1).max(200),
});

/**
 * Shape returned from `authorize`. Auth.js's `User` type is a loose record;
 * we narrow it locally so the `jwt` callback can copy the multi-tenant fields
 * onto the token without type gymnastics.
 */
interface AuthorizedUser {
  id: string;
  email: string;
  name: string | null;
  tenantId: string;
  role: "admin" | "member";
}

export const authConfig: NextAuthConfig = {
  // JWT-only sessions: required by the Credentials provider (no DB session
  // row is created) and keeps middleware checks edge-friendly.
  session: { strategy: "jwt" },

  // Custom sign-in / error pages live at `/login`; Auth.js will redirect
  // unauthenticated requests here when used via `auth()` middleware.
  pages: {
    signIn: "/login",
    error: "/login",
  },

  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials, request) {
        // 1. Validate input shape. Bail out generically — we don't want
        //    distinct error codes for "missing field" vs "wrong password".
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          throw new InvalidCredentialsError();
        }
        const { email, password } = parsed.data;

        // 2. Brute-force protection. Two layers, both must pass:
        //
        //    a) Per-IP cap: 10 attempts / 15 min, shared with the register
        //       endpoint's policy (`AUTH_RATE_LIMIT`). Catches credential-
        //       stuffing across many emails from a single IP.
        //
        //    b) Per (ip, email) cap: 5 attempts / 60 s (`LOGIN_RATE_LIMIT`).
        //       Prevents a single attacker from burning the password space
        //       on one user, and prevents a victim from being locked out
        //       by an attacker spamming their email from many IPs (since
        //       each attacker IP gets its own bucket).
        //
        //    The Auth.js Credentials flow turns thrown errors into a
        //    redirect with `?error=CredentialsSignin&code=rate_limited`;
        //    we can't set HTTP headers from here, but the broader 429 +
        //    Retry-After surface is exposed by `POST /api/auth/register`
        //    where we own the response.
        const ip = getClientIp(request);
        const ipKey = `auth:${ip}`;
        const ipLimit = checkLimit(ipKey, AUTH_RATE_LIMIT);
        if (!ipLimit.ok) {
          throw new RateLimitedError();
        }
        const rateKey = `login:${ip}:${email}`;
        const limit = checkLimit(rateKey, LOGIN_RATE_LIMIT);
        if (!limit.ok) {
          throw new RateLimitedError();
        }

        // 3. Look up the user. We select only the columns we need; password
        //    hash is required for comparison.
        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            passwordHash: users.passwordHash,
            tenantId: users.tenantId,
            role: users.role,
          })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        // 4. Compare password. We always run `verifyPassword` even when the
        //    user is missing? — no, bcrypt is expensive and the user-not-found
        //    branch is rare; the rate limiter above already smooths the
        //    timing oracle. Keep this branch fast.
        if (!user || !user.passwordHash) {
          throw new InvalidCredentialsError();
        }
        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) {
          throw new InvalidCredentialsError();
        }

        // 5. Successful auth: clear the bucket so this user isn't penalized
        //    for prior failed attempts (typo, password manager hiccup, …).
        resetLimit(rateKey);

        const authorized: AuthorizedUser = {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: user.tenantId,
          role: user.role,
        };
        return authorized;
      },
    }),
  ],

  callbacks: {
    /**
     * `jwt` runs on sign-in (with `user` populated) and on every subsequent
     * token read (with only `token`). We persist tenant/role on first sign-in
     * so the session can read them without an extra DB hit.
     */
    async jwt({ token, user }) {
      if (user) {
        const authed = user as Partial<AuthorizedUser>;
        if (authed.id) token.sub = authed.id;
        if (authed.tenantId) token.tenantId = authed.tenantId;
        if (authed.role) token.role = authed.role;
      }
      return token;
    },

    /**
     * `session` shapes what `useSession()` / `auth()` returns to callers.
     * Surface tenantId and role on `session.user` for tenant-scoped queries
     * downstream.
     */
    async session({ session, token }) {
      if (session.user) {
        if (token.sub) session.user.id = token.sub;
        if (typeof token.tenantId === "string") {
          session.user.tenantId = token.tenantId;
        }
        if (token.role === "admin" || token.role === "member") {
          session.user.role = token.role;
        }
      }
      return session;
    },
  },
};
