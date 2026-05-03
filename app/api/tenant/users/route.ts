import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Forced dynamic: every read pulls the session cookie and queries the DB.
// The response is per-tenant (filter is keyed on `session.user.tenantId`),
// so any prerender / route caching would be a tenant-isolation bug.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ListErrorCode = "UNAUTHENTICATED" | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ListErrorCode,
  message: string,
): NextResponse =>
  NextResponse.json({ error: message, code }, { status });

/**
 * GET /api/tenant/users
 *
 * Returns every user in the caller's tenant, projected to the minimum surface
 * the team-management "Add Member" dropdown needs: `{ id, name, email, role }`.
 * The dropdown picks a tenant user and POSTs the chosen `id` to
 * /api/teams/[teamId]/members; this endpoint is the source for that picker.
 *
 * Tenant isolation: filtering uses `session.user.tenantId` from the JWT
 * claim — never accepted from query string or body — so a compromised cookie
 * can only ever enumerate its own tenant. The `users.tenantId` FK with
 * ON DELETE CASCADE guarantees the listing reflects the live tenant
 * membership without a JOIN through `tenants`.
 *
 * Authorization: any authenticated user in the tenant. We do NOT gate on
 * tenant-admin or team-admin here:
 *   - The "Add Member" UI is rendered for team admins only, but the team-admin
 *     gate is enforced authoritatively by the downstream POST
 *     /api/teams/[teamId]/members handler. Returning 403 here would force the
 *     UI to special-case its own roster fetch.
 *   - Members already learn each other's name/email via shared boards
 *     (assignee dropdowns, task author chips), so this listing isn't a new
 *     disclosure. The `role` field is also exposed on the team-detail
 *     payload, so it's not a new fact either.
 *
 * Response shape (200):
 *   { users: Array<{ id, name, email, role }> }
 *
 * Sorted by name (case-insensitive via the DB collation), with email as a
 * deterministic tiebreaker so the order is stable across requests and rows
 * with NULL `name` (users who haven't completed their profile) sort to a
 * predictable position.
 *
 *  - 401 UNAUTHENTICATED — no valid session.
 *  - 500 INTERNAL_ERROR  — unexpected DB error.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const tenantId = session.user.tenantId;

  try {
    // Single tenant-scoped scan. We project only the columns the dropdown
    // renders — passwordHash, emailVerified, image, etc. stay server-side.
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(asc(users.name), asc(users.email));

    return NextResponse.json({ users: rows }, { status: 200 });
  } catch (err: unknown) {
    console.error("[GET /api/tenant/users] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load tenant users at this time",
    );
  }
}
