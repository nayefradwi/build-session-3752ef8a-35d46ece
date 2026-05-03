import { and, desc, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { invitations } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Always treat as dynamic: this handler reads the session cookie and queries
// the DB on every request. Caching responses across users would be a tenant
// isolation bug.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ListErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ListErrorCode,
  message: string,
): NextResponse =>
  NextResponse.json({ error: message, code }, { status });

/**
 * Returns the active (status=pending, not yet expired) invitations for the
 * caller's tenant. Admin-only — members shouldn't see who's been invited.
 *
 * Tenant isolation is enforced by filtering on `session.user.tenantId`; we
 * never accept a tenantId from query string or body, so a compromised admin
 * cookie can only ever list its own tenant's invites.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  if (session.user.role !== "admin") {
    return errorResponse(
      403,
      "FORBIDDEN",
      "Only tenant admins can list invitations",
    );
  }

  const tenantId = session.user.tenantId;
  const now = new Date();

  try {
    const rows = await db
      .select({
        id: invitations.id,
        tenantId: invitations.tenantId,
        email: invitations.email,
        token: invitations.token,
        status: invitations.status,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, now),
        ),
      )
      .orderBy(desc(invitations.createdAt));

    return NextResponse.json({ invitations: rows }, { status: 200 });
  } catch (err: unknown) {
    console.error("[GET /api/tenant/invitations] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load invitations at this time",
    );
  }
}
