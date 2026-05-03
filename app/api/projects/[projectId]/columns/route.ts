import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns, projects, teamMemberships } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { getNewPosition } from "@/lib/server/position";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every read pulls the session cookie and queries the DB,
// and the response is tenant- + visibility-scoped, so prerender / route
// caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Hard cap on the number of columns a single project may have. The cap is a
 * product invariant — kanban boards become unusable past a handful of lanes
 * — and we enforce it server-side rather than trusting the client. The check
 * is performed under a `FOR UPDATE` lock on the project row so concurrent
 * POSTs can't race past the limit.
 */
const MAX_COLUMNS_PER_PROJECT = 10;

type ColumnsErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "LIMIT_REACHED"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ColumnsErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// projectId is a dynamic segment; validate as a UUID before we hit Postgres
// so the uuid-cast in the WHERE clause never panics with a 500.
const projectIdParamSchema = z.uuid();

/**
 * GET /api/projects/[projectId]/columns
 *
 * Returns the project's kanban-style columns ordered by `position` ascending
 * — the canonical render order for the board.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - If the project is `private`, caller must be a team member of the
 *     owning team (403 otherwise).
 *   - If the project is `public`, any tenant member can read it.
 *
 * Response shape: `{ columns: Array<{ id, projectId, name, position }> }`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { projectId: rawProjectId } = await context.params;
  const projectIdParse = projectIdParamSchema.safeParse(rawProjectId);
  if (!projectIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid project id");
  }

  try {
    const access = await resolveProjectAccessByProjectId({
      projectId: projectIdParse.data,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this project",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Project not found");
    }

    // The (projectId, position) unique index in lib/db/schema.ts means this
    // ORDER BY can be served straight from the index — no sort step needed
    // at the planner level.
    const rows = await db
      .select({
        id: columns.id,
        projectId: columns.projectId,
        name: columns.name,
        position: columns.position,
      })
      .from(columns)
      .where(eq(columns.projectId, access.project.id))
      .orderBy(asc(columns.position));

    return NextResponse.json({ columns: rows }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[GET /api/projects/[projectId]/columns] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load columns at this time",
    );
  }
}

const createColumnInputSchema = z.object({
  // Trim before length-checking so a whitespace-only string fails the
  // non-empty rule. Bound to keep arbitrarily-long inputs out of the DB.
  name: z.string().trim().min(1).max(120),
});

/**
 * POST /api/projects/[projectId]/columns
 *
 * Create a new kanban column at the end of the project's lane order.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - Caller must be a *team admin* (`team_memberships.role = "admin"`) of
 *     the owning team. Tenant-level admins do NOT bypass; column management
 *     is a team-scoped operation. Non-admin members of the team get 403, as
 *     do non-members of a private project.
 *
 * Validation:
 *   - `name` non-empty after trim, max 120 chars.
 *   - Project may not exceed `MAX_COLUMNS_PER_PROJECT` (10) columns. The
 *     count + insert run inside a transaction with a `FOR UPDATE` row lock
 *     on the project so two concurrent admins can't race past the cap.
 *
 * Position assignment:
 *   - `position = max(existing positions) + 1`, or 0 if the project has no
 *     columns. The `(projectId, position)` unique index acts as a backstop:
 *     even if the read+insert ever raced, the duplicate would 23505 rather
 *     than corrupt the lane order.
 *
 * Response: 201 with `{ column: { id, projectId, name, position } }`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { projectId: rawProjectId } = await context.params;
  const projectIdParse = projectIdParamSchema.safeParse(rawProjectId);
  if (!projectIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid project id");
  }

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

  const parsed = createColumnInputSchema.safeParse(rawBody);
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
    // 1. Resolve project access. This enforces tenant isolation (cross-tenant
    //    project => 404) and the visibility rule (private + non-member =>
    //    403). We layer the team-admin check below — but the visibility
    //    gate already establishes "caller can see the project at all".
    const access = await resolveProjectAccessByProjectId({
      projectId: projectIdParse.data,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this project",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Project not found");
    }

    // 2. Team-admin gate. Tenant admins do NOT bypass: column management is
    //    a team-scoped operation, mirroring the team-membership endpoints.
    const [callerMembership] = await db
      .select({ role: teamMemberships.role })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, access.team.id),
          eq(teamMemberships.userId, session.user.id),
        ),
      )
      .limit(1);

    if (!callerMembership || callerMembership.role !== "admin") {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team admins can create columns",
      );
    }

    // 3. Atomically check the count cap and insert the new column. We lock
    //    the project row with FOR UPDATE so two concurrent admins creating
    //    columns serialize against each other — the count we read is
    //    authoritative for the duration of this transaction, and the
    //    `position = max + 1` derivation can't collide with a sibling insert.
    const result = await db.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, access.project.id))
        .for("update");

      // Pull existing columns pre-sorted by ascending position so the
      // shared `getNewPosition` helper can derive the append slot from
      // `existing[length - 1]`. Append uses the standard POSITION_STEP
      // (1000) spacing — see `lib/server/position.ts` for the contract.
      const existing = await tx
        .select({ position: columns.position })
        .from(columns)
        .where(eq(columns.projectId, access.project.id))
        .orderBy(asc(columns.position));

      if (existing.length >= MAX_COLUMNS_PER_PROJECT) {
        return { kind: "limit" as const };
      }

      // `insertAfterIndex = existing.length - 1` is the canonical
      // "append" call; the helper short-circuits to 0 when the project
      // has no columns yet, so no extra branch is needed here. The
      // (projectId, position) unique index acts as a backstop for
      // races, but the FOR UPDATE row lock above already serializes us.
      const nextPosition = getNewPosition(existing, existing.length - 1);

      const [created] = await tx
        .insert(columns)
        .values({
          projectId: access.project.id,
          name,
          position: nextPosition,
        })
        .returning({
          id: columns.id,
          projectId: columns.projectId,
          name: columns.name,
          position: columns.position,
        });

      return { kind: "ok" as const, column: created };
    });

    if (result.kind === "limit") {
      return errorResponse(
        422,
        "LIMIT_REACHED",
        `Project already has the maximum of ${MAX_COLUMNS_PER_PROJECT} columns`,
      );
    }

    return NextResponse.json({ column: result.column }, { status: 201 });
  } catch (err: unknown) {
    console.error(
      "[POST /api/projects/[projectId]/columns] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to create column at this time",
    );
  }
}
