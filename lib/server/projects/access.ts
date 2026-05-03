import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { projects, teamMemberships, teams } from "@/lib/db/schema";

/**
 * Shape returned for any successful access resolution. We hand back both the
 * project row and the owning team's tenant so route handlers can render the
 * project payload and reuse the tenant scope for follow-up queries without an
 * extra round-trip.
 */
export type ProjectAccessGrant = {
  project: {
    id: string;
    teamId: string;
    name: string;
    visibility: "public" | "private";
    createdAt: Date;
  };
  team: {
    id: string;
    tenantId: string;
  };
  // True iff the calling user has a `team_memberships` row for the owning
  // team. Public projects still resolve for non-members, so callers that need
  // membership-gated UI bits can branch on this flag.
  isMember: boolean;
};

/**
 * Discriminated union returned by the `resolve*` helpers. We keep "not found"
 * and "forbidden" distinct so the route handler can map them to 404 / 403:
 *
 *   - `not_found` covers both "project doesn't exist" and "project lives in
 *     another tenant" — the public surface collapses these into 404 to avoid
 *     leaking cross-tenant existence.
 *   - `forbidden` is reserved for "project is private and caller isn't a
 *     team member"; the project IS in the caller's tenant, so 403 is the
 *     honest signal.
 */
export type ProjectAccessResult =
  | ({ ok: true } & ProjectAccessGrant)
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "forbidden" };

type ProjectRow = ProjectAccessGrant["project"];
type TeamRow = ProjectAccessGrant["team"];

/**
 * Apply the visibility rule to an already-fetched project + team and bolt on
 * the membership check. Shared between the by-projectId and by-teamId entry
 * points so the policy lives in exactly one place.
 */
async function gateByVisibility(
  project: ProjectRow,
  team: TeamRow,
  userId: string,
): Promise<ProjectAccessResult> {
  const [membership] = await db
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, team.id),
        eq(teamMemberships.userId, userId),
      ),
    )
    .limit(1);
  const isMember = membership !== undefined;

  // Private projects are visible only to team members. Public projects are
  // visible to any tenant member — the tenantId match is established by the
  // caller's WHERE clause before we get here, so we don't re-check it.
  if (project.visibility === "private" && !isMember) {
    return { ok: false, reason: "forbidden" };
  }

  return { ok: true, project, team, isMember };
}

/**
 * Resolve project access by `projectId`. Returns:
 *   - `not_found` if the project doesn't exist OR exists in a different tenant
 *     (collapsed for non-leak reasons).
 *   - `forbidden` if the project is private and the caller isn't a team member.
 *   - `ok` with the project, owning team, and membership flag otherwise.
 */
export async function resolveProjectAccessByProjectId(args: {
  projectId: string;
  tenantId: string;
  userId: string;
}): Promise<ProjectAccessResult> {
  const { projectId, tenantId, userId } = args;
  const [row] = await db
    .select({
      project: {
        id: projects.id,
        teamId: projects.teamId,
        name: projects.name,
        visibility: projects.visibility,
        createdAt: projects.createdAt,
      },
      team: {
        id: teams.id,
        tenantId: teams.tenantId,
      },
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(eq(projects.id, projectId), eq(teams.tenantId, tenantId)))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };
  return gateByVisibility(row.project, row.team, userId);
}

/**
 * Resolve project access by `teamId`. Each team in this app is auto-seeded
 * with a single project at creation time (see POST /api/teams), so we return
 * the team's project — disambiguating by `createdAt` ascending in case the
 * data model later grows multi-project teams. Returns the same discriminated
 * union as the by-projectId variant.
 */
export async function resolveProjectAccessByTeamId(args: {
  teamId: string;
  tenantId: string;
  userId: string;
}): Promise<ProjectAccessResult> {
  const { teamId, tenantId, userId } = args;
  const [row] = await db
    .select({
      project: {
        id: projects.id,
        teamId: projects.teamId,
        name: projects.name,
        visibility: projects.visibility,
        createdAt: projects.createdAt,
      },
      team: {
        id: teams.id,
        tenantId: teams.tenantId,
      },
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
    // Oldest-wins disambiguation if a team ever ends up with multiple
    // projects; for the current data model the team has exactly one.
    .orderBy(asc(projects.createdAt))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };
  return gateByVisibility(row.project, row.team, userId);
}
