import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { teamMemberships, teams, users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Forced dynamic: every read pulls the session cookie + queries the DB, and
// the response is tenant- and team-scoped, so prerender / route caching must
// not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TeamErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: TeamErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// teamId comes from the dynamic segment; validate as a UUID before we hit
// Postgres so we don't waste a round-trip on obvious garbage and so the
// uuid-cast in the WHERE clause never panics with a 500.
const teamIdParamSchema = z.uuid();

/**
 * GET /api/teams/[teamId]
 *
 * Returns the team's basic metadata plus the full membership list with each
 * member's per-team role and a small, safe slice of their user profile.
 *
 * Authorization: any authenticated user in the same tenant as the team can
 * read this. We deliberately don't gate on team membership — the directory
 * needs to render member rosters so people know who they'd be joining. We
 * never expose teams from a different tenant: cross-tenant lookups return 404
 * (not 403) so the existence of the team in another tenant isn't leaked.
 *
 * Response shape:
 *   {
 *     team: { id, name, tenantId, createdAt },
 *     members: Array<{
 *       userId,
 *       role: "admin" | "member",
 *       joinedAt,        // team_memberships.created_at
 *       email,
 *       name,            // nullable
 *       image,           // nullable
 *     }>,
 *   }
 *
 * Members are sorted admins-first then by name (case-insensitive) so the
 * client can render a stable list without re-sorting.
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
    // 1. Fetch the team scoped by tenantId so cross-tenant access can't
    //    succeed even if the caller hand-crafts a UUID.
    const [team] = await db
      .select({
        id: teams.id,
        name: teams.name,
        tenantId: teams.tenantId,
        createdAt: teams.createdAt,
      })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
      .limit(1);

    if (!team) {
      return errorResponse(404, "NOT_FOUND", "Team not found");
    }

    // 2. Fetch members with a join onto users so the response carries enough
    //    profile data to render a roster row without an N+1 follow-up.
    //    We re-assert tenantId on the user join as a defense-in-depth check:
    //    if a stray membership ever pointed at a user from another tenant
    //    (it shouldn't — the POST handler validates this), it would be
    //    silently filtered here rather than leaked into the response.
    const members = await db
      .select({
        userId: teamMemberships.userId,
        role: teamMemberships.role,
        joinedAt: teamMemberships.createdAt,
        email: users.email,
        name: users.name,
        image: users.image,
      })
      .from(teamMemberships)
      .innerJoin(users, eq(users.id, teamMemberships.userId))
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(users.tenantId, tenantId),
        ),
      )
      .orderBy(
        // admins first (alphabetical "admin" < "member"), then name. Email is
        // the deterministic tiebreaker so the order is fully stable.
        asc(teamMemberships.role),
        asc(users.name),
        asc(users.email),
      );

    return NextResponse.json({ team, members }, { status: 200 });
  } catch (err: unknown) {
    console.error("[GET /api/teams/[teamId]] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load team at this time",
    );
  }
}

// Body shape for PUT. `name` is the only currently-mutable field on a team:
// tenantId is structural (cross-tenant moves aren't a feature) and createdAt
// is immutable. We trim+bound the same way POST /api/teams does so we don't
// admit whitespace-only labels or arbitrary-length strings into the DB.
const updateTeamInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  // .strict() so unknown keys fail validation rather than silently dropping —
  // protects against client typos like { tname: "..." } turning into a no-op.
  .strict();

/**
 * PUT /api/teams/[teamId]
 *
 * Update the team's metadata. Body: `{ name: string }`.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Team must live in the caller's tenant (404 otherwise — we never leak
 *     cross-tenant existence by returning 403).
 *   - Caller must be a *team admin* (`team_memberships.role = "admin"`).
 *     Tenant-level admins do NOT bypass; team rename is a team-scoped
 *     operation, mirroring the project / columns / members endpoints.
 *     Non-admin members get 403; non-members of the team get 403 as well
 *     (a non-membership probe of an existing in-tenant team isn't a leak —
 *     the GET handler exposes the team's existence to any tenant member).
 *
 * Race safety: the team row is locked with `FOR UPDATE` inside a transaction
 * before the UPDATE, so two concurrent admins renaming the same team
 * serialize through the lock and the response always reflects the final
 * post-write state of *this* transaction.
 *
 * Response: 200 with `{ team: { id, name, tenantId, createdAt } }`.
 */
export async function PUT(
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
  const userId = session.user.id;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON",
    );
  }

  const parsed = updateTeamInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { name } = parsed.data;

  try {
    // 1. Tenant-isolated existence check. Cross-tenant teamId => 404, never
    //    403, so the response can't be used to enumerate teamIds in other
    //    tenants. Done outside the transaction since a non-existent team
    //    short-circuits before we take any locks.
    const [existing] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
      .limit(1);

    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Team not found");
    }

    // 2. Team-admin gate. Tenant admins do NOT bypass: team rename is a
    //    team-scoped operation, mirroring the project / columns / members
    //    endpoints. Non-admin members and non-members both get 403 here.
    const [callerMembership] = await db
      .select({ role: teamMemberships.role })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.userId, userId),
        ),
      )
      .limit(1);

    if (!callerMembership || callerMembership.role !== "admin") {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team admins can update the team",
      );
    }

    // 3. Lock + update the team row in a single transaction. Two concurrent
    //    admins renaming the same team serialize through the FOR UPDATE lock,
    //    so the row we re-read in `.returning()` reflects the post-write
    //    state of *this* transaction. We re-assert tenantId in the UPDATE
    //    WHERE clause as defense-in-depth: if the team were somehow moved
    //    between the existence check and the UPDATE, the row count would be
    //    zero and the transaction would correctly surface a 404.
    const updated = await db.transaction(async (tx) => {
      await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
        .for("update");

      const [row] = await tx
        .update(teams)
        .set({ name })
        .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
        .returning({
          id: teams.id,
          name: teams.name,
          tenantId: teams.tenantId,
          createdAt: teams.createdAt,
        });

      return row;
    });

    if (!updated) {
      // Defensive: the existence check above passed but the UPDATE found no
      // row — only possible if the team was deleted between the two queries.
      return errorResponse(404, "NOT_FOUND", "Team not found");
    }

    return NextResponse.json({ team: updated }, { status: 200 });
  } catch (err: unknown) {
    console.error("[PUT /api/teams/[teamId]] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to update team at this time",
    );
  }
}
