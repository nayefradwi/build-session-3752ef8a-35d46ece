import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge-runtime route guard.
 *
 * NextAuth v5 issues a JWT session cookie on successful sign-in. We can't
 * import the full `auth()` helper here because the auth config pulls in
 * `bcrypt` and the `postgres` driver, neither of which run on the Edge
 * runtime that Next.js middleware executes in. Instead we do a lightweight
 * cookie-presence check — the authoritative session validation still runs
 * in server components / route handlers via `await auth()`. That layered
 * model is the pattern recommended by Auth.js for v5.
 *
 * The cookie name varies by environment:
 *   - dev / HTTP:    `authjs.session-token`
 *   - prod / HTTPS:  `__Secure-authjs.session-token`
 *   - legacy v4:     `next-auth.session-token` (+ `__Secure-` variant)
 *
 * We accept all four so a partial migration / staging-vs-prod difference
 * doesn't lock users out.
 */
const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
] as const;

function hasSessionCookie(request: NextRequest): boolean {
  for (const name of SESSION_COOKIE_NAMES) {
    if (request.cookies.get(name)?.value) {
      return true;
    }
  }
  return false;
}

export function middleware(request: NextRequest): NextResponse {
  if (hasSessionCookie(request)) {
    return NextResponse.next();
  }

  // Preserve where the user was heading so the login page can bounce them
  // back after authenticating. We round-trip path + search; we drop the
  // hash because servers never see it anyway.
  const { pathname, search } = request.nextUrl;
  const next = `${pathname}${search}`;

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

/**
 * Matcher: only protected app surfaces. We deliberately exclude `/api/*`
 * (route handlers do their own auth — and the NextAuth `/api/auth/*`
 * endpoints must remain reachable while signed-out so users can sign in)
 * and `/login`, `/register`, public marketing pages, and Next.js internals.
 *
 * Adding a new top-level protected segment? List it here.
 */
export const config = {
  matcher: [
    "/dashboard/:path*",
    "/teams/:path*",
    "/projects/:path*",
    "/account/:path*",
  ],
};
