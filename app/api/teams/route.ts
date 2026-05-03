import { asc, count, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  columns,
  projects,
  teamMemberships,
  teams,
} from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Always treat as dynamic: every handler in this file reads the session
// cookie and queries (or writes) the database. The GET response also
// embeds per-user `isMember`, so prerender / route caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Default kanban-style columns auto-created with every new team's project.
 * Position is the integer order key; the (projectId, position) unique index
 * in the schema enforces "no two columns share a slot" at the DB layer.
 */
const DEFAULT_COLUMNS = [
  { name: "To Do", position: 0 },
  { name: "In Progress", position: 1 },
  { name: "Done", position: 2 },
] as const;

type TeamsErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: TeamsErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

const createTeamInputSchema = z.object({
  // Trim and bound. We intentionally allow any non-empty string after trim —
  // teams are tenant-private resources, so the admin gets to decide what
  // counts as a valid label.
  name: z.string().trim().min(1).max(120),
});

/**
 * Create a new team in the caller's tenant.
 *
 * Behavior (single DB transaction so partial state never escapes):
 *   1. Insert team scoped to `session.user.tenantId`.
 *   2. Add the creator as a team admin via team_memberships.
 *   3. Create a default project (visibility = "private") owned by the team.
 *   4. Seed the project with three default columns: "To Do" (0),
 *      "In Progress" (1), "Done" (2).
 *
 * Authorization: tenant admins only. Members hitting this endpoint get a 403,
 * not a 401, so the client can distinguish "log in" from "you can't do this".
 *
 * Tenant isolation: tenantId is taken from the JWT session claim — never
 * accepted from the request body or query string — so a compromised admin
 * cookie can only ever create teams in its own tenant.
 */
export async function POST(request: Request): Promise<NextResponse> {
  // 1. Authenticate.
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  // 2. Authorize.
  if (session.user.role !== "admin") {
    return errorResponse(
      403,
      "FORBIDDEN",
      "Only tenant admins can create teams",
    );
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  // 3. Parse JSON body. Malformed JSON should be a 400, not a 500.
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

  // 4. Validate shape.
  const parsed = createTeamInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { name } = parsed.data;

  // 5. Atomically create team + membership + project + columns. Throwing
  //    inside the transaction callback is the documented Drizzle path for
  //    rolling back, so any DB error here aborts every insert.
  try {
    const result = await db.transaction(async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ name, tenantId })
        .returning({
          id: teams.id,
          name: teams.name,
          tenantId: teams.tenantId,
          createdAt: teams.createdAt,
        });

      await tx.insert(teamMemberships).values({
        userId,
        teamId: team.id,
        role: "admin",
      });

      // Auto-project shares the team's name; a future task can rename it.
      // Visibility defaults to "private" via the column default in
      // lib/db/schema.ts but we set it explicitly so the contract is obvious
      // at the call site.
      const [project] = await tx
        .insert(projects)
        .values({
          teamId: team.id,
          name,
          visibility: "private",
        })
        .returning({
          id: projects.id,
          teamId: projects.teamId,
          name: projects.name,
          visibility: projects.visibility,
          createdAt: projects.createdAt,
        });

      const insertedColumns = await tx
        .insert(columns)
        .values(
          DEFAULT_COLUMNS.map((col) => ({
            projectId: project.id,
            name: col.name,
            position: col.position,
          })),
        )
        .returning({
          id: columns.id,
          projectId: columns.projectId,
          name: columns.name,
          position: columns.position,
        });

      // Sort by position so the response order is stable regardless of how
      // Postgres returned the rows from the multi-row INSERT.
      insertedColumns.sort((a, b) => a.position - b.position);

      return { team, project, columns: insertedColumns };
    });

    return NextResponse.json(
      {
        team: result.team,
        project: result.project,
        columns: result.columns,
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    console.error("[POST /api/teams] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to create team at this time",
    );
  }
}

/**
 * List every team in the caller's tenant.
 *
 * Response shape: `{ teams: Array<{ id, name, createdAt, memberCount,
 * isMember }> }`, sorted by `name` ascending.
 *
 *   - `memberCount` is the number of `team_memberships` rows for the team
 *     (admins + members), aggregated server-side so the client doesn't have
 *     to issue N+1 lookups.
 *   - `isMember` is true iff the *current* user has a membership row in the
 *     team. We compute it in the same aggregate pass via BOOL_OR over the
 *     left-joined memberships, so a team with zero members correctly gets
 *     `false` (COALESCE turns the NULL aggregate into false).
 *
 * Authorization: any authenticated user in the tenant may list — this is the
 * directory view that powers "join a team" UX. Tenant isolation is enforced
 * by the WHERE clause on `tenantId` taken from the JWT claim; we never
 * accept a tenantId from query string or body.
 *
 * Caching: forced dynamic at the file scope above. Per-tenant + per-user
 * `isMember` makes the response unsafe to share across users, so even an
 * accidental fetch cache hit would leak membership state.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  try {
    // LEFT JOIN keeps teams with zero memberships in the result. We aggregate
    // by team to get both the member count and the current-user membership
    // flag in a single round-trip; BOOL_OR returns NULL on an empty group, so
    // we COALESCE it to false to keep the response shape boolean-only.
    const rows = await db
      .select({
        id: teams.id,
        name: teams.name,
        createdAt: teams.createdAt,
        memberCount: count(teamMemberships.userId),
        isMember: sql<boolean>`COALESCE(BOOL_OR(${teamMemberships.userId} = ${userId}), false)`,
      })
      .from(teams)
      .leftJoin(teamMemberships, eq(teamMemberships.teamId, teams.id))
      .where(eq(teams.tenantId, tenantId))
      .groupBy(teams.id)
      .orderBy(asc(teams.name));

    return NextResponse.json({ teams: rows }, { status: 200 });
  } catch (err: unknown) {
    console.error("[GET /api/teams] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load teams at this time",
    );
  }
}
