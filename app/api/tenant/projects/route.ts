import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { projects, teamMemberships, teams } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Forced dynamic: every read pulls the session cookie and queries the DB.
// The response is per-tenant + per-user (the `isMember` flag and the
// visibility-filter both depend on the caller's identity), so prerender /
// route caching would be a tenant-isolation bug.
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
 * GET /api/tenant/projects
 *
 * Tenant-wide directory of teams + their projects, filtered by the visibility
 * gate. Powers the "browse projects" surface where a user discovers public
 * projects across the tenant alongside the private projects they're a member
 * of.
 *
 * Visibility policy (matches lib/server/projects/access.ts):
 *   - `public` projects appear in every tenant member's listing.
 *   - `private` projects appear ONLY for callers who hold a
 *     `team_memberships` row for the owning team.
 *
 * The membership probe runs as a LEFT JOIN against `team_memberships` keyed
 * to the caller's userId, which lets us compute `isMember` per row in the
 * same round-trip and apply the visibility filter in the WHERE clause without
 * a correlated subquery.
 *
 * Response shape:
 *   { projects: Array<{ teamId, teamName, projectId, projectName, visibility,
 *     isMember }> }
 *
 * Sorted by team name then project createdAt ascending so the listing is
 * stable across requests; teams group together and projects within a team
 * appear in creation order (the auto-seeded project for each team is
 * therefore the first row of its group).
 *
 * Authorization: any authenticated user in the tenant. Tenant isolation is
 * enforced by filtering on `session.user.tenantId` from the JWT claim — never
 * accepted from query string or body.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  try {
    // The LEFT JOIN below is keyed to the *current user* (userId is bound at
    // query-build time), so a non-NULL `team_memberships.userId` on a row
    // means "this caller is a member of this team". We reuse that flag for
    // both the visibility gate (in the WHERE clause) and the response's
    // `isMember` field, avoiding a second round-trip.
    //
    // INNER JOIN on projects: a team without a project doesn't surface here —
    // every team is auto-seeded with one project at creation time, so this is
    // equivalent to listing teams while still letting future multi-project
    // teams flatten naturally. If a team ever truly has zero projects we
    // intentionally hide it from the directory (no project = nothing to show).
    const rows = await db
      .select({
        teamId: teams.id,
        teamName: teams.name,
        projectId: projects.id,
        projectName: projects.name,
        visibility: projects.visibility,
        // BOOL via NOT NULL on the LEFT-joined membership row. The cast keeps
        // the inferred TS type as `boolean` rather than `unknown`.
        isMember: sql<boolean>`(${teamMemberships.userId} IS NOT NULL)`,
      })
      .from(teams)
      .innerJoin(projects, eq(projects.teamId, teams.id))
      .leftJoin(
        teamMemberships,
        and(
          eq(teamMemberships.teamId, teams.id),
          eq(teamMemberships.userId, userId),
        ),
      )
      .where(
        and(
          eq(teams.tenantId, tenantId),
          // Visibility gate: keep public projects for everyone, plus private
          // projects where the caller has a membership row (NOT NULL on the
          // LEFT-joined column).
          or(
            eq(projects.visibility, "public"),
            isNotNull(teamMemberships.userId),
          ),
        ),
      )
      .orderBy(asc(teams.name), asc(projects.createdAt));

    return NextResponse.json({ projects: rows }, { status: 200 });
  } catch (err: unknown) {
    console.error("[GET /api/tenant/projects] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load projects at this time",
    );
  }
}
