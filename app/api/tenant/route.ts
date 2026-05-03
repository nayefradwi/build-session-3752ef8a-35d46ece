import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Always treat as dynamic: this handler reads the session cookie and queries
// the DB on every request. The response is per-tenant (the lookup is keyed on
// the caller's `session.user.tenantId` claim), so any cross-request caching
// would be a tenant-isolation bug.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type GetErrorCode = "UNAUTHENTICATED" | "NOT_FOUND" | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: GetErrorCode,
  message: string,
): NextResponse =>
  NextResponse.json({ error: message, code }, { status });

/**
 * GET /api/tenant
 *
 * Returns the current tenant the caller belongs to. Powers the dashboard home
 * page and the nav bar org-name display.
 *
 * Tenant isolation: the tenantId is read exclusively from the JWT session
 * claim (`session.user.tenantId`); we never accept it from query string or
 * body, so a compromised cookie can only ever read its own tenant.
 *
 * Response shape (200): { id, name, createdAt }
 *  - 401 UNAUTHENTICATED — no valid session.
 *  - 404 NOT_FOUND       — session references a tenant row that's been deleted
 *                          out from under it (defence-in-depth; users.tenantId
 *                          is FK-cascaded so this should be unreachable in
 *                          practice).
 *  - 500 INTERNAL_ERROR  — unexpected DB error.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const tenantId = session.user.tenantId;

  try {
    // Single-row lookup keyed on the session-bound tenantId. We project only
    // the fields the dashboard / nav bar render — no internal columns leak.
    const [tenant] = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      // Session points at a tenant that no longer exists. The FK cascade on
      // users.tenantId means the user row would have gone with it, so the
      // session itself ought to be invalid — but surface a clean 404 here
      // rather than crashing if the invariant is ever violated.
      return errorResponse(404, "NOT_FOUND", "Tenant no longer exists");
    }

    return NextResponse.json(tenant, { status: 200 });
  } catch (err: unknown) {
    console.error("[GET /api/tenant] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load tenant at this time",
    );
  }
}
