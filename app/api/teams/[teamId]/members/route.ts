import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { teamMemberships, teams, users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Forced dynamic: every handler authenticates and queries the DB on every
// invocation. Responses are tenant- and team-scoped, so prerender / route
// caching must never apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MembersErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: MembersErrorCode,
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

/**
 * GET /api/teams/[teamId]/members
 *
 * Returns the team's membership list in the exact shape the task create/edit
 * "assignee" dropdown needs — `{ id, name, email }` per row, plus the per-team
 * `role` and `joinedAt` fields for callers that want to render badges. The id
 * column maps directly to `teamMemberships.userId` so a client can drop the
 * value into a `assigneeId` field on POST /api/projects/[projectId]/tasks or
 * PUT /api/tasks/[taskId] without further translation.
 *
 * This is a sibling endpoint to GET /api/teams/[teamId], which returns the
 * same membership data nested inside a team-detail envelope. The members-only
 * endpoint exists so the dropdown can fetch just what it needs without paying
 * for the extra team metadata, and so the URL is semantically meaningful for
 * future caching / prefetch decisions.
 *
 * Authorization (mirrors GET /api/teams/[teamId]):
 *   - Caller must be authenticated (401 otherwise).
 *   - Team must live in the caller's tenant (404 otherwise — never leak
 *     cross-tenant team existence). We deliberately don't gate on team
 *     membership: any tenant user opening a project they have read-access to
 *     should be able to see the assignee roster, and the create/edit POST/PUT
 *     endpoints enforce the stricter "must be a team member to write" gate
 *     downstream.
 *
 * Response shape (200):
 *   {
 *     members: Array<{
 *       id: string,            // = users.id, drop straight into assigneeId
 *       userId: string,        // legacy alias for id; kept for callers that
 *                              // copy the team-detail shape
 *       name: string | null,
 *       email: string,
 *       role: "admin" | "member",
 *       joinedAt: string,      // ISO timestamp from team_memberships.created_at
 *     }>
 *   }
 *
 * Members are sorted admins-first then by name (case-insensitive via the DB
 * collation), with email as a deterministic tiebreaker so the order is stable
 * across requests.
 */
export async function GET(
  _request: Request,
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

  try {
    // 1. Tenant-scoped team lookup. A team in another tenant collapses to 404
    //    so cross-tenant existence never leaks via the response code.
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
      .limit(1);

    if (!team) {
      return errorResponse(404, "NOT_FOUND", "Team not found");
    }

    // 2. Fetch members with a join onto users so the response carries enough
    //    profile data for the dropdown (name + email) plus the user id that
    //    the create/edit endpoints expect on `assigneeId`. The `users.tenantId`
    //    re-assertion is defense-in-depth: the POST handler in this file
    //    already gates by tenant on insert, but if a stray membership row ever
    //    pointed at a user from another tenant it would be silently filtered
    //    here rather than leaked.
    const rows = await db
      .select({
        userId: teamMemberships.userId,
        role: teamMemberships.role,
        joinedAt: teamMemberships.createdAt,
        name: users.name,
        email: users.email,
      })
      .from(teamMemberships)
      .innerJoin(users, eq(users.id, teamMemberships.userId))
      .where(
        and(eq(teamMemberships.teamId, teamId), eq(users.tenantId, tenantId)),
      )
      .orderBy(
        // admins first (alphabetical "admin" < "member"), then name. Email is
        // the deterministic tiebreaker so the order is fully stable.
        asc(teamMemberships.role),
        asc(users.name),
        asc(users.email),
      );

    // Reshape with `id` as the canonical key so callers can lift a row
    // straight into the assignee dropdown without renaming. We keep `userId`
    // around as an alias to match the team-detail endpoint's wire format —
    // dropping it would break clients that prefer that shape.
    const members = rows.map((row) => ({
      id: row.userId,
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role,
      joinedAt: row.joinedAt,
    }));

    return NextResponse.json({ members }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[GET /api/teams/[teamId]/members] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load team members at this time",
    );
  }
}

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
