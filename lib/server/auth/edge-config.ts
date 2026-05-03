import type { NextAuthConfig } from "next-auth";

/**
 * Edge-runtime-safe NextAuth.js configuration. `middleware.ts` runs in the
 * Vercel Edge runtime and therefore cannot transitively import bcrypt, the
 * `postgres` driver, or any other Node-only module. The full `authConfig`
 * in `./config.ts` pulls in all of those via the Credentials provider, so
 * we keep a separate, intentionally minimal config here for the middleware
 * to instantiate its own `NextAuth()`.
 *
 * Both NextAuth instances read the same `AUTH_SECRET` / `NEXTAUTH_SECRET`
 * environment variable, so JWTs minted by the Node-runtime auth handler
 * decode correctly when verified here. We register no providers because
 * middleware never invokes `authorize` — it only validates the session
 * cookie and inspects `req.auth`.
 */
export const authConfigEdge = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [],
} satisfies NextAuthConfig;
