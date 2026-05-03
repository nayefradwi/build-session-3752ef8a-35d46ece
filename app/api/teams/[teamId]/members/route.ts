import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { teamMemberships, teams, users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Forced dynamic: this handler authenticates and writes to the DB on every
// invocation. It must never be statically optimized.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AddMemberErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: AddMemberErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

const teamIdParamSchema = z.uuid();

const addMemberInputSchema = z.object({
  userId: z.uuid(),
  // Role defaults to "member"; an admin can promote a brand-new member at
  // join-time by passing "admin".
  role: z.enum(["admin", "member"]).default("member"),
});

/**
 * POST /api/teams/[teamId]/members
 *
 * Add an existing user (by userId) to the given team. Authorization rules:
 *
 *   - Caller must be authenticated.
 *   - Caller must be a team-admin of `[teamId]` (team_memberships.role =
 *     "admin"). Tenant-level admins are NOT auto-promoted into team-admins
 *     for teams they don't belong to — the team-admin role is the deliberate
 *     scope here.
 *   - The team must live in the caller's tenant (404 otherwise so we don't
 *     leak existence across tenants).
 *   - The target user must live in the same tenant as the team. Mixing users
 *     across tenants is the canonical isolation violation; a different-tenant
 *     userId returns 404 (not 403) for the same non-leak reason.
 *
 * On success: 201 with the inserted membership row. On duplicate insert
 * (composite PK collision, i.e. user already in team): 409 CONFLICT.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { teamId: rawTeamId } = await context.params;
  const teamIdParse = teamIdParamSchema.safeParse(rawTeamId);
  if (!teamIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid team id");
  }
  const teamId = teamIdParse.data;
  const tenantId = session.user.tenantId;
  const callerId = session.user.id;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = addMemberInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { userId: targetUserId, role } = parsed.data;

  try {
    // 1. Verify the team exists in the caller's tenant. A team in another
    //    tenant — or a non-existent team — is indistinguishable from the
    //    caller's perspective: both are 404.
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
      .limit(1);

    if (!team) {
      return errorResponse(404, "NOT_FOUND", "Team not found");
    }

    // 2. Verify caller is a team-admin of this team. Tenant-admins do NOT
    //    bypass — see the doc-comment above for why.
    const [callerMembership] = await db
      .select({ role: teamMemberships.role })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.userId, callerId),
        ),
      )
      .limit(1);

    if (!callerMembership || callerMembership.role !== "admin") {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team admins can add members",
      );
    }

    // 3. Verify the target user exists AND is in the same tenant. This is
    //    the tenant-isolation check; we collapse "user doesn't exist" and
    //    "user is in another tenant" into a single 404 to avoid leaking
    //    cross-tenant user existence.
    const [targetUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, targetUserId), eq(users.tenantId, tenantId)))
      .limit(1);

    if (!targetUser) {
      return errorResponse(404, "NOT_FOUND", "User not found in this tenant");
    }

    // 4. Insert the membership. The composite PK (userId, teamId) raises a
    //    unique-violation (Postgres SQLSTATE 23505) on duplicates; we treat
    //    that as a 409 rather than a 500. Drizzle bubbles the underlying
    //    `postgres` error which exposes the SQLSTATE on `.code`.
    try {
      const [membership] = await db
        .insert(teamMemberships)
        .values({ userId: targetUserId, teamId, role })
        .returning({
          userId: teamMemberships.userId,
          teamId: teamMemberships.teamId,
          role: teamMemberships.role,
          createdAt: teamMemberships.createdAt,
        });

      return NextResponse.json({ membership }, { status: 201 });
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        return errorResponse(
          409,
          "CONFLICT",
          "User is already a member of this team",
        );
      }
      throw err;
    }
  } catch (err: unknown) {
    console.error(
      "[POST /api/teams/[teamId]/members] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to add member at this time",
    );
  }
}
