import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns, projects, tasks, teamMemberships } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every write pulls the session cookie + queries the DB, and
// the response is tenant- + visibility-scoped, so prerender / route caching
// must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ColumnErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "MIN_COLUMNS"
  | "COLUMN_HAS_TASKS"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ColumnErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// projectId / columnId come from the dynamic segments; validate as UUIDs
// before we hit Postgres so the uuid-cast in the WHERE clause never panics
// with a 500 on obvious garbage.
const projectIdParamSchema = z.uuid();
const columnIdParamSchema = z.uuid();

// Body shape for PUT. `name` is currently the only mutable field on a column
// — `position` is reordered through dedicated move endpoints, and `projectId`
// is structural (cross-project moves aren't a feature). We trim+bound the
// same way POST /api/projects/[projectId]/columns does so we don't admit
// whitespace-only labels or arbitrary-length strings into the DB.
const updateColumnInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  // .strict() so unknown keys fail validation rather than silently dropping —
  // protects against client typos like { tname: "..." } turning into a no-op.
  .strict();

/**
 * PUT /api/projects/[projectId]/columns/[columnId]
 *
 * Update a column's metadata. Body: `{ name: string }`.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - Column must belong to the project named in the URL (404 otherwise; a
 *     mismatched [projectId, columnId] pair is indistinguishable from "the
 *     column doesn't exist" from the caller's perspective).
 *   - Caller must be a *team admin* (`team_memberships.role = "admin"`) of
 *     the owning team. Tenant-level admins do NOT bypass; column management
 *     is a team-scoped operation, mirroring the sibling POST handler and the
 *     team / project endpoints. Non-admin members of the team get 403, as do
 *     non-members of a private project (which fall out of the visibility
 *     gate as 403 first).
 *
 * Race safety: the column row is locked with `FOR UPDATE` inside a
 * transaction before the UPDATE so two concurrent admins renaming the same
 * column serialize through the lock and the response always reflects the
 * final post-write state of *this* transaction. We re-assert the
 * column→project relationship in the UPDATE WHERE clause as defense-in-depth:
 * if the column were somehow moved between the existence check and the
 * UPDATE, the row count would be zero and the transaction would correctly
 * surface a 404.
 *
 * Response: 200 with `{ column: { id, projectId, name, position } }`.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string; columnId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { projectId: rawProjectId, columnId: rawColumnId } =
    await context.params;
  const projectIdParse = projectIdParamSchema.safeParse(rawProjectId);
  if (!projectIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid project id");
  }
  const columnIdParse = columnIdParamSchema.safeParse(rawColumnId);
  if (!columnIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid column id");
  }
  const projectId = projectIdParse.data;
  const columnId = columnIdParse.data;

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

  const parsed = updateColumnInputSchema.safeParse(rawBody);
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
    //    project => 404) and the visibility gate (private + non-member =>
    //    403). The team-admin gate below is strictly stronger, but resolving
    //    access first lets us return the canonical 404 for missing /
    //    cross-tenant projects without leaking via the admin probe.
    const access = await resolveProjectAccessByProjectId({
      projectId,
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

    // 2. Team-admin gate. Tenant admins do NOT bypass: column management is a
    //    team-scoped operation, mirroring the sibling POST handler and the
    //    team / project endpoints. Non-admin members and non-members of a
    //    public project both get 403 here.
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
        "Only team admins can update columns",
      );
    }

    // 3. Verify the column belongs to this project. Done outside the
    //    transaction since a missing column short-circuits before we take
    //    any locks. The (id, projectId) compound filter is what makes a
    //    mismatched [projectId, columnId] pair indistinguishable from "the
    //    column doesn't exist" — the response is the same 404 either way.
    const [existing] = await db
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(eq(columns.id, columnId), eq(columns.projectId, access.project.id)),
      )
      .limit(1);

    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Column not found");
    }

    // 4. Lock + update the column row in a single transaction. Two concurrent
    //    admins renaming the same column serialize through the FOR UPDATE
    //    lock, so the row we re-read in `.returning()` reflects the post-
    //    write state of *this* transaction. We re-assert the column->project
    //    relationship in the UPDATE WHERE clause as defense-in-depth: if the
    //    column were somehow moved between the existence check and the
    //    UPDATE, the row count would be zero and the transaction would
    //    correctly surface a 404.
    const updated = await db.transaction(async (tx) => {
      await tx
        .select({ id: columns.id })
        .from(columns)
        .where(
          and(
            eq(columns.id, columnId),
            eq(columns.projectId, access.project.id),
          ),
        )
        .for("update");

      const [row] = await tx
        .update(columns)
        .set({ name })
        .where(
          and(
            eq(columns.id, columnId),
            eq(columns.projectId, access.project.id),
          ),
        )
        .returning({
          id: columns.id,
          projectId: columns.projectId,
          name: columns.name,
          position: columns.position,
        });

      return row;
    });

    if (!updated) {
      // Defensive: the existence check above passed but the UPDATE found no
      // row — only possible if the column was deleted between the two queries.
      return errorResponse(404, "NOT_FOUND", "Column not found");
    }

    return NextResponse.json({ column: updated }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[PUT /api/projects/[projectId]/columns/[columnId]] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to update column at this time",
    );
  }
}

/**
 * DELETE /api/projects/[projectId]/columns/[columnId]
 *
 * Permanently delete a column from a project. Returns 204 No Content with an
 * empty body on success — the row is gone, there is nothing meaningful to
 * echo back, and the REST contract for "no representation to return" is the
 * empty 204.
 *
 * Authorization (mirrors PUT above):
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - Column must belong to the project named in the URL (404 otherwise; a
 *     mismatched [projectId, columnId] pair is indistinguishable from "the
 *     column doesn't exist" from the caller's perspective).
 *   - Caller must be a *team admin* (`team_memberships.role = "admin"`) of
 *     the owning team. Tenant-level admins do NOT bypass; column management
 *     is a team-scoped operation, mirroring the sibling POST/PUT handlers.
 *     Non-admin members get 403, as do non-members of a private project
 *     (which fall out of the visibility gate as 403 first).
 *
 * Product invariants (both surface as 422 — the request is well-formed but
 * the server state currently forbids the deletion):
 *   - **Minimum one column.** A project must always have at least one column
 *     so the kanban board has a place to render. Deleting the last remaining
 *     column would leave the board in a broken state, so the handler returns
 *     422 `MIN_COLUMNS` if the count under the lock is 1. We compute the
 *     count *under the project FOR UPDATE lock* so a peer DELETE that's
 *     already in flight serializes through us and the count we observe is
 *     authoritative for the duration of this transaction.
 *   - **Column must be empty.** The column being deleted must have zero tasks.
 *     Cascading the task deletes implicitly would silently throw away user
 *     work; instead we surface 422 `COLUMN_HAS_TASKS` with the message
 *     "Move or delete tasks first" and let the client drive the cleanup. The
 *     count is taken under the column FOR UPDATE lock so a peer task-create
 *     can't race in between the count and the DELETE.
 *
 * Race safety:
 *   - We take a project FOR UPDATE lock first, then the column FOR UPDATE
 *     lock. The project lock is shared with sibling endpoints (POST columns,
 *     PATCH reorder) so column-set mutations on the same project serialize
 *     against each other; the column lock prevents concurrent DELETEs of
 *     the same column row from double-deleting.
 *   - Lock order is consistent across handlers (project-then-column) so we
 *     don't introduce deadlock pairs with PATCH reorder or POST.
 *
 * Position semantics:
 *   - Remaining columns keep their existing `position` values. The board
 *     ordering still renders correctly because the GET endpoint sorts by
 *     position ascending — gaps in the integer sequence are tolerated
 *     (this matches POST which appends at max+1, never compacts). A future
 *     "compact positions on delete" task can be added without breaking
 *     clients; today we err on the side of minimal mutation.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string; columnId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { projectId: rawProjectId, columnId: rawColumnId } =
    await context.params;
  const projectIdParse = projectIdParamSchema.safeParse(rawProjectId);
  if (!projectIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid project id");
  }
  const columnIdParse = columnIdParamSchema.safeParse(rawColumnId);
  if (!columnIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid column id");
  }
  const projectId = projectIdParse.data;
  const columnId = columnIdParse.data;

  try {
    // 1. Resolve project access. Tenant isolation (cross-tenant => 404) and
    //    visibility gate (private + non-member => 403) live in the helper.
    //    The team-admin check below is strictly stronger, but resolving
    //    access first lets us return the canonical 404 for missing /
    //    cross-tenant projects without leaking via the admin probe.
    const access = await resolveProjectAccessByProjectId({
      projectId,
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

    // 2. Team-admin gate. Tenant admins do NOT bypass: column management is a
    //    team-scoped operation, mirroring the sibling POST and PUT handlers.
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
        "Only team admins can delete columns",
      );
    }

    // 3. Verify the column belongs to this project. Done outside the
    //    transaction since a missing column short-circuits before we take
    //    any locks. The (id, projectId) compound filter is what makes a
    //    mismatched [projectId, columnId] pair indistinguishable from "the
    //    column doesn't exist" — the response is the same 404 either way.
    const [existing] = await db
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(eq(columns.id, columnId), eq(columns.projectId, access.project.id)),
      )
      .limit(1);

    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Column not found");
    }

    // 4. Atomic check + delete. We hold a FOR UPDATE lock on the owning
    //    project for the lifetime of the transaction so concurrent column
    //    mutations (POST / PATCH reorder / sibling DELETEs) serialize
    //    against each other; the count we read for the MIN_COLUMNS check
    //    is therefore authoritative for the rest of this tx. We then take
    //    a FOR UPDATE lock on the column row itself so a concurrent peer
    //    DELETE of the same column collapses to a single winner — the
    //    loser sees the row gone under the lock and 404s cleanly.
    const result = await db.transaction(async (tx) => {
      // Lock the project row first. Same lock POST and PATCH reorder take,
      // so column-set mutations on this project serialize through us.
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, access.project.id))
        .for("update");

      // Lock the column row. If the column was deleted between our existence
      // check and the lock acquisition (peer DELETE won the race), the
      // SELECT returns nothing and we 404.
      const [lockedColumn] = await tx
        .select({ id: columns.id })
        .from(columns)
        .where(
          and(
            eq(columns.id, columnId),
            eq(columns.projectId, access.project.id),
          ),
        )
        .for("update");

      if (!lockedColumn) {
        return { kind: "not_found" as const };
      }

      // Min-columns invariant. Count *all* columns under the project lock —
      // including the one we're about to delete — and refuse if that count
      // is 1. The lock above guarantees no peer can append/remove columns
      // concurrently, so the count is authoritative.
      const [columnCountRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(columns)
        .where(eq(columns.projectId, access.project.id));

      const columnCount = columnCountRow?.count ?? 0;
      if (columnCount <= 1) {
        return { kind: "min_columns" as const };
      }

      // Empty-column invariant. Count tasks under the column lock so a peer
      // task create / move can't slip a task in between the count and the
      // DELETE. tasks→columns is ON DELETE CASCADE, so without this guard
      // an admin could silently destroy user work; we surface 422 instead
      // and let the client move/clean up first.
      const [taskCountRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.columnId, lockedColumn.id));

      const taskCount = taskCountRow?.count ?? 0;
      if (taskCount > 0) {
        return { kind: "has_tasks" as const };
      }

      // Safe to delete. Re-assert (id, projectId) in the WHERE clause as
      // defense-in-depth — if the column were somehow moved between the
      // lock and the delete, the row count would be zero and the parent
      // handler would 404.
      await tx
        .delete(columns)
        .where(
          and(
            eq(columns.id, lockedColumn.id),
            eq(columns.projectId, access.project.id),
          ),
        );

      return { kind: "ok" as const };
    });

    if (result.kind === "not_found") {
      return errorResponse(404, "NOT_FOUND", "Column not found");
    }
    if (result.kind === "min_columns") {
      return errorResponse(
        422,
        "MIN_COLUMNS",
        "Project must have at least one column",
      );
    }
    if (result.kind === "has_tasks") {
      return errorResponse(
        422,
        "COLUMN_HAS_TASKS",
        "Move or delete tasks first",
      );
    }

    // 204 No Content: the resource is gone and there's no representation to
    // return. Body MUST be empty per the HTTP spec — `new NextResponse(null,
    // ...)` is the right shape (json() would emit "null" as a body).
    return new NextResponse(null, { status: 204 });
  } catch (err: unknown) {
    console.error(
      "[DELETE /api/projects/[projectId]/columns/[columnId]] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to delete column at this time",
    );
  }
}
