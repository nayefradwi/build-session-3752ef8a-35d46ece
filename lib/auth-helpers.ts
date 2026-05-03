import "server-only";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { Session } from "next-auth";

import { db } from "@/lib/db";
import { teamMemberships, teams } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

/**
 * Reusable server-side authorization primitives for API route handlers.
 *
 * Every protected handler in `app/api/**` shares the same shape — pull the
 * session out of the cookie, refuse on missing/foreign tenant, optionally
 * gate on team membership or team-admin role. Inlining that logic into each
 * route was producing copy-paste drift (subtle 401 vs 403 vs 404 differences,
 * forgotten tenantId checks, ad-hoc error envelopes), so this module
 * centralizes the contract:
 *
 *   - `requireSession(req?)`              — 401 if no/incomplete session
 *   - `requireTenantMember(s, tenantId)`  — 403 if resource is in another tenant
 *   - `requireTeamMember(s, teamId)`      — 404 if team∉tenant, 403 if not member
 *   - `requireTeamAdmin(s, teamId)`       — 404 if team∉tenant, 403 if not admin
 *
 * Each helper either returns a value (a narrowed session, or the team role) or
 * throws an `AuthError`. Route handlers catch the error and convert it to a
 * `NextResponse` via `err.toResponse()` (or the `authErrorResponse(err)`
 * convenience). The 404-vs-403 split mirrors the convention already in place
 * across the existing routes: cross-tenant existence collapses to 404 so the
 * response can't be used to enumerate teams in other tenants, while
 * permission failures *within* the caller's tenant honestly return 403.
 *
 * Tenant isolation is enforced via the JWT claim — `session.user.tenantId` —
 * never from request input. A compromised cookie can therefore only ever
 * grant access to its own tenant's resources.
 */

/**
 * Narrowed session shape that the `require*` helpers guarantee on success.
 *
 * NextAuth widens `session.user.tenantId` and `session.user.role` to optional
 * fields (the augmentation in `lib/server/auth/types.ts` declares them as
 * `?:`). After `requireSession` returns, both are guaranteed present, so
 * downstream callers can read them without re-checking.
 */
export interface AuthenticatedSession extends Session {
  user: {
    id: string;
    tenantId: string;
    role: "admin" | "member";
    email?: string | null;
    name?: string | null;
    image?: string | null;
  };
}

/**
 * Vocabulary the helpers throw with — matches the `code` field already in use
 * across the existing route handler error envelopes so route-level catch
 * blocks can pass `err.toResponse()` straight through to the client.
 */
export type AuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND";

/**
 * Sentinel error class thrown by every `require*` helper. Carries the HTTP
 * status, a stable `code`, and a user-facing message. Route handlers catch
 * the error and call `.toResponse()` to produce a `NextResponse` matching the
 * envelope shape used by the rest of the app:
 *
 *   { error: <message>, code: <AuthErrorCode> }
 */
export class AuthError extends Error {
  readonly status: number;
  readonly code: AuthErrorCode;

  constructor(status: number, code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }

  /**
   * Convert this error to the JSON envelope every route in this app uses.
   * Kept as an instance method so the call site is just `err.toResponse()`.
   */
  toResponse(): NextResponse {
    return NextResponse.json(
      { error: this.message, code: this.code },
      { status: this.status },
    );
  }

  /** Type guard for `unknown` values — useful in route-level catch blocks. */
  static is(err: unknown): err is AuthError {
    return err instanceof AuthError;
  }
}

/**
 * Convenience wrapper for the catch-and-rethrow pattern. Returns a
 * `NextResponse` if `err` is an `AuthError`, else `null` so the caller can
 * fall through to its generic 500 branch:
 *
 * ```
 * try { ... } catch (err) {
 *   const res = authErrorResponse(err);
 *   if (res) return res;
 *   console.error(...);
 *   return NextResponse.json({ error: "...", code: "INTERNAL_ERROR" }, ...);
 * }
 * ```
 */
export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) return err.toResponse();
  return null;
}

/**
 * Resolve and validate the current session. The optional `req` parameter is
 * accepted for forward-compatibility with callers that already hold a
 * `Request` / `NextRequest` reference; Auth.js v5's `auth()` reads cookies
 * from the ambient request scope and does not need it threaded through, so we
 * accept and ignore it rather than forcing every call site to pass `null`.
 *
 * Throws `AuthError(401, "UNAUTHENTICATED")` if the session is missing,
 * lacks a user id, or is missing either of the multi-tenant claims
 * (`tenantId`, `role`) the rest of the helpers require. Returning the
 * narrowed `AuthenticatedSession` lets callers drop the `?` from
 * `session.user.tenantId` etc. without further refinement.
 */
export async function requireSession(
  _req?: Request | null,
): Promise<AuthenticatedSession> {
  const session = await auth();
  if (
    !session?.user?.id ||
    !session.user.tenantId ||
    (session.user.role !== "admin" && session.user.role !== "member")
  ) {
    throw new AuthError(401, "UNAUTHENTICATED", "Sign in to continue");
  }
  return session as AuthenticatedSession;
}

/**
 * Assert the resource being accessed belongs to the caller's tenant.
 *
 * Use when the route handler has already loaded a resource (or its owning
 * tenantId) and wants to verify the caller's tenant matches. Throws
 * `AuthError(403, "FORBIDDEN")` on mismatch.
 *
 * Note: routes that load resources by id often prefer the inverse pattern —
 * scope the SELECT by `session.user.tenantId` in the WHERE clause and 404
 * on missing rows — because that collapses cross-tenant existence into a
 * single non-leaking response. This helper covers the case where the
 * resource is loaded via a path that doesn't already scope by tenant (e.g.
 * deep joins, or assertions inside transactions).
 */
export function requireTenantMember(
  session: AuthenticatedSession,
  resourceTenantId: string,
): void {
  if (session.user.tenantId !== resourceTenantId) {
    throw new AuthError(
      403,
      "FORBIDDEN",
      "Resource is outside your tenant",
    );
  }
}

/**
 * Assert the caller is a member of the given team. On success returns the
 * caller's per-team role (`"admin" | "member"`), so callers that need to
 * branch on it (e.g. "admins see a delete button") don't need a second
 * lookup.
 *
 * Failure modes:
 *   - `AuthError(404, "NOT_FOUND")` — team doesn't exist OR exists in a
 *     different tenant. The two are collapsed to avoid leaking cross-tenant
 *     team existence via the response code.
 *   - `AuthError(403, "FORBIDDEN")` — team is in the caller's tenant but the
 *     caller has no `team_memberships` row.
 */
export async function requireTeamMember(
  session: AuthenticatedSession,
  teamId: string,
): Promise<"admin" | "member"> {
  const role = await loadTeamRoleOrThrowNotFound(session, teamId);
  if (role === null) {
    throw new AuthError(
      403,
      "FORBIDDEN",
      "You are not a member of this team",
    );
  }
  return role;
}

/**
 * Assert the caller is a *team admin* of the given team. Tenant-level admins
 * do NOT bypass — team admin is a distinct, team-scoped role (mirrors the
 * convention enforced by every team-scoped route handler in this app).
 *
 * Same 404 vs 403 split as `requireTeamMember`. Non-admin members also get
 * 403 (not 404) since they've already proven they can see the team.
 */
export async function requireTeamAdmin(
  session: AuthenticatedSession,
  teamId: string,
): Promise<void> {
  const role = await loadTeamRoleOrThrowNotFound(session, teamId);
  if (role === null) {
    throw new AuthError(
      403,
      "FORBIDDEN",
      "You are not a member of this team",
    );
  }
  if (role !== "admin") {
    throw new AuthError(
      403,
      "FORBIDDEN",
      "Only team admins can perform this action",
    );
  }
}

/**
 * Internal: verify the team exists in the caller's tenant (404 otherwise),
 * then return the caller's per-team role or `null` if there is no membership
 * row. Keeps the tenant-isolation + membership-lookup pair in one place so
 * `requireTeamMember` and `requireTeamAdmin` can't drift apart.
 */
async function loadTeamRoleOrThrowNotFound(
  session: AuthenticatedSession,
  teamId: string,
): Promise<"admin" | "member" | null> {
  const tenantId = session.user.tenantId;

  // 1. Tenant-scoped existence check. A team in another tenant is
  //    indistinguishable from a non-existent one — both surface as 404 so
  //    the response code can't be used to enumerate teamIds across tenants.
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
    .limit(1);

  if (!team) {
    throw new AuthError(404, "NOT_FOUND", "Team not found");
  }

  // 2. Membership lookup. Composite PK on (userId, teamId) means at most one
  //    row exists per (caller, team), so the limit(1) is a tightening hint
  //    rather than a correctness requirement.
  const [membership] = await db
    .select({ role: teamMemberships.role })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.userId, session.user.id),
      ),
    )
    .limit(1);

  return membership?.role ?? null;
}
