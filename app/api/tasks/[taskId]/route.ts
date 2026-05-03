import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns, tasks, teamMemberships, users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every read pulls the session cookie and queries the DB,
// and the response is tenant- + visibility-scoped, so prerender / route
// caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TaskDetailErrorCode =
  | "INVALID_INPUT"
  | "INVALID_JSON"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: TaskDetailErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// taskId is a dynamic segment; validate as a UUID before we hit Postgres so
// the uuid-cast in the WHERE clause never panics with a 500.
const taskIdParamSchema = z.uuid();

/**
 * GET /api/tasks/[taskId]
 *
 * Returns the full detail view for a single task: title, description, integer
 * `position`, an inlined `assignee` slice (id / name / email) when assigned,
 * and `createdAt` / `updatedAt`. Attachments are returned as an empty list —
 * the attachment data model has not shipped yet, so the field is reserved on
 * the wire but always empty for now. A future schema task can populate it
 * without breaking clients that already consume this shape.
 *
 * Authorization (mirrors the project-scoped task list endpoint):
 *   - Caller must be authenticated (401 otherwise).
 *   - Task must live in a column whose project's owning team is in the
 *     caller's tenant. Cross-tenant or non-existent task ids collapse to 404
 *     to avoid leaking existence across tenant boundaries.
 *   - If the project is `private`, caller must be a team member of the owning
 *     team (403 otherwise).
 *   - If the project is `public`, any tenant member can read it.
 *
 * Implementation note: we resolve the task's projectId in a single join from
 * tasks→columns first (one round trip, scoped only by taskId so we don't
 * silently 404 on cross-tenant rows yet), then hand the projectId to the
 * shared `resolveProjectAccessByProjectId` helper which enforces the tenant
 * + visibility gates. Two trips on the happy path, but reusing the helper
 * keeps the policy in exactly one place.
 *
 * Response shape (200):
 *   {
 *     task: {
 *       id, columnId, title, description, position, createdAt, updatedAt,
 *       assignee: { id, name, email } | null,
 *       attachments: Array<{ id, filename, mimeType, size, createdAt }>,
 *     }
 *   }
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { taskId: rawTaskId } = await context.params;
  const taskIdParse = taskIdParamSchema.safeParse(rawTaskId);
  if (!taskIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid task id");
  }

  try {
    // 1. Locate the task and its owning project (via the column FK). We don't
    //    join tenants here — the access helper does the tenant check below.
    //    LEFT JOIN to `users` so an unassigned task still resolves to a row.
    const [row] = await db
      .select({
        id: tasks.id,
        columnId: tasks.columnId,
        title: tasks.title,
        description: tasks.description,
        position: tasks.position,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        assigneeId: tasks.assigneeId,
        assigneeName: users.name,
        assigneeEmail: users.email,
        projectId: columns.projectId,
      })
      .from(tasks)
      .innerJoin(columns, eq(columns.id, tasks.columnId))
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .where(eq(tasks.id, taskIdParse.data))
      .limit(1);

    if (!row) {
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // 2. Tenant + visibility gate via the shared helper. A cross-tenant task
    //    id reaches step 1 and would otherwise leak existence; collapsing to
    //    404 here matches the behavior of every other project-scoped read.
    const access = await resolveProjectAccessByProjectId({
      projectId: row.projectId,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this task",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // 3. Reshape the wire payload. `assignee` collapses the three nullable
    //    user columns into a single nullable object so clients don't have to
    //    juggle partially-populated triples. `attachments` is returned as an
    //    empty array — see the function-doc note on the missing schema.
    const assignee =
      row.assigneeId === null
        ? null
        : {
            id: row.assigneeId,
            name: row.assigneeName,
            // Email is NOT NULL on `users`; the LEFT JOIN can still produce
            // null in the unreachable "user row missing despite FK" case.
            // Coerce rather than emit a TS-unsound shape.
            email: row.assigneeEmail ?? "",
          };

    return NextResponse.json(
      {
        task: {
          id: row.id,
          columnId: row.columnId,
          title: row.title,
          description: row.description,
          position: row.position,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          assignee,
          // Attachments are reserved on the wire but the underlying table
          // doesn't exist yet — see the route doc-comment. Keeping the field
          // present (always empty) means a future schema task can light it
          // up without a breaking client change.
          attachments: [] as Array<{
            id: string;
            filename: string;
            mimeType: string;
            size: number;
            createdAt: Date;
          }>,
        },
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("[GET /api/tasks/[taskId]] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load task at this time",
    );
  }
}

// Hard upper bounds — mirrored from the create endpoint so that an entry
// created within the limit can also be edited up to the same limit. Title is
// a single board-card line; description is the long-form body.
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 10_000;

/**
 * Update payload. We deliberately distinguish "field absent" from "field
 * present with null":
 *
 *   - `title` is required on every update — it's the human-readable handle on
 *     the card and the schema column is NOT NULL. Trimmed + non-empty + max
 *     200 chars (whitespace-only titles fail the min(1) check).
 *   - `description` is optional. Omit to leave the existing value untouched;
 *     pass `null` (or "" / whitespace-only) to explicitly clear it.
 *   - `assigneeId` is optional. Omit to leave the existing assignee untouched;
 *     pass `null` to unassign. If a UUID is supplied, the user must be a
 *     member of the owning team — assigning work outside the team would put
 *     a card in front of someone who can't even view the project.
 *
 * The optional+nullable shape gives us a tri-valued field (`undefined | null
 * | T`) that the handler reads to decide between "skip", "clear", and "set".
 */
const updateTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH),
  description: z
    .string()
    .max(DESCRIPTION_MAX_LENGTH)
    .nullable()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const trimmed = v.trim();
      // Empty / whitespace-only collapses to an explicit clear so the wire
      // semantic of "" matches null at the DB layer.
      return trimmed === "" ? null : trimmed;
    }),
  assigneeId: z.uuid().nullable().optional(),
});

/**
 * PUT /api/tasks/[taskId]
 *
 * Edit a task's title, description, and/or assignee. updatedAt is bumped
 * server-side via NOW() so the timestamp reflects the DB clock (matches the
 * defaultNow stamp on insert and avoids app/DB clock drift).
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - The task's owning project must live in the caller's tenant. Cross-tenant
 *     or non-existent task ids collapse to 404 to avoid leaking existence.
 *   - Caller must be a *team member* of the owning team. Public-project
 *     visibility lets non-members READ the task (see GET above), but writes
 *     require membership; non-members get 403.
 *
 * Body validation (see `updateTaskInputSchema`):
 *   - `title` required, non-empty after trim, ≤ 200 chars.
 *   - `description` optional; omit to keep, null/"" to clear, otherwise
 *     stored trimmed (≤ 10 000 chars).
 *   - `assigneeId` optional; omit to keep, null to unassign, UUID to set.
 *     A UUID must reference a member of the owning team (422 otherwise).
 *
 * Response shape (200): same as POST /api/projects/[projectId]/tasks —
 *   { task: { id, columnId, title, description, position, createdAt,
 *     updatedAt, assignee: { id, name, email } | null } }
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { taskId: rawTaskId } = await context.params;
  const taskIdParse = taskIdParamSchema.safeParse(rawTaskId);
  if (!taskIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid task id");
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

  const parsed = updateTaskInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { title, description, assigneeId } = parsed.data;

  try {
    // 1. Locate the task and resolve the owning project. We don't check
    //    tenant in this query — that's the access helper's job below — so a
    //    cross-tenant task id flows through to step 2 and collapses to 404.
    const [taskRow] = await db
      .select({
        id: tasks.id,
        projectId: columns.projectId,
      })
      .from(tasks)
      .innerJoin(columns, eq(columns.id, tasks.columnId))
      .where(eq(tasks.id, taskIdParse.data))
      .limit(1);

    if (!taskRow) {
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // 2. Tenant + visibility gate. Cross-tenant => 404; private-project
    //    non-member READS would 403 here, but writes get an even stricter
    //    membership gate in step 3, so the 403 path is consistent.
    const access = await resolveProjectAccessByProjectId({
      projectId: taskRow.projectId,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this task",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // 3. Membership gate. Public projects let non-members read tasks but
    //    every write path (create, edit, delete) requires team membership.
    if (!access.isMember) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team members can edit tasks",
      );
    }

    // 4. Assignee membership check, only when the client is setting a
    //    concrete user. `undefined` means "leave alone", `null` means
    //    "unassign" — both skip this lookup.
    if (assigneeId !== undefined && assigneeId !== null) {
      const [assigneeMembership] = await db
        .select({ userId: teamMemberships.userId })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, access.team.id),
            eq(teamMemberships.userId, assigneeId),
          ),
        )
        .limit(1);

      if (!assigneeMembership) {
        return errorResponse(
          422,
          "INVALID_INPUT",
          "Assignee must be a member of the owning team",
        );
      }
    }

    // 5. Apply the update. `title` is always set; `description` and
    //    `assigneeId` are only included when explicitly present in the body
    //    so omitting them preserves the existing value. updatedAt is bumped
    //    via NOW() so the timestamp comes from the DB clock (consistent with
    //    the defaultNow stamp at insert time).
    const updatePayload: {
      title: string;
      updatedAt: ReturnType<typeof sql>;
      description?: string | null;
      assigneeId?: string | null;
    } = {
      title,
      updatedAt: sql`now()`,
    };
    if (description !== undefined) {
      updatePayload.description = description;
    }
    if (assigneeId !== undefined) {
      updatePayload.assigneeId = assigneeId;
    }

    const [updated] = await db
      .update(tasks)
      .set(updatePayload)
      .where(eq(tasks.id, taskRow.id))
      .returning({
        id: tasks.id,
        columnId: tasks.columnId,
        title: tasks.title,
        description: tasks.description,
        position: tasks.position,
        assigneeId: tasks.assigneeId,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      });

    if (!updated) {
      // We just confirmed the row exists in step 1 and don't race deletes
      // inside this handler, but the row could in theory have been removed
      // by a concurrent DELETE. Surface as 404 rather than 500.
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // 6. Hydrate the assignee slice for the response. We do this outside
    //    the update statement (one extra round-trip when assigned) to keep
    //    the write tight. The membership check above already proved the
    //    user exists, so this is a known-hit on the happy path; we still
    //    guard against a vanishing row to avoid crashing the response.
    let assignee: { id: string; name: string | null; email: string } | null =
      null;
    if (updated.assigneeId !== null) {
      const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, updated.assigneeId))
        .limit(1);
      assignee = user
        ? { id: user.id, name: user.name, email: user.email }
        : null;
    }

    return NextResponse.json(
      {
        task: {
          id: updated.id,
          columnId: updated.columnId,
          title: updated.title,
          description: updated.description,
          position: updated.position,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
          assignee,
        },
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("[PUT /api/tasks/[taskId]] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to update task at this time",
    );
  }
}

/**
 * DELETE /api/tasks/[taskId]
 *
 * Permanently delete a task. On success returns 204 No Content with an empty
 * body — the row is gone, there's nothing meaningful to echo back, and the
 * REST contract for "no representation to return" is the empty 204.
 *
 * Authorization (mirrors PUT):
 *   - Caller must be authenticated (401 otherwise).
 *   - The task's owning project must live in the caller's tenant. Cross-tenant
 *     or non-existent task ids collapse to 404 to avoid leaking existence.
 *   - Caller must be a *team member* of the owning team. Public-project
 *     visibility lets non-members read tasks, but every write path (create,
 *     edit, delete) requires team membership; non-members get 403.
 *
 * Cascade semantics:
 *   - Associated attachments (DB rows + storage objects) are required to be
 *     cleaned up alongside the task. The attachment data model has NOT shipped
 *     yet (see GET above — `attachments` is a hard-coded empty list on the
 *     wire), so there is nothing to delete today. The transaction below is
 *     structured to make the future addition trivial: once `lib/db/schema.ts`
 *     gains an `attachments` table, the cleanup is one extra `tx.delete(...)`
 *     plus a storage-driver call inside the same atomic block.
 *   - Tasks themselves have no children that need manual cleanup at the DB
 *     layer today; the schema's cascade rules (FK from columns/users) only
 *     fire on parent deletes, not on a task delete, so a plain DELETE row is
 *     sufficient for the current model.
 *
 * Atomicity:
 *   - The whole operation runs inside `db.transaction(...)` so even though the
 *     attachment cleanup is a no-op today, callers can rely on the contract
 *     "either everything is gone, or nothing changed" once attachments ship.
 *   - We re-read the task FOR UPDATE inside the transaction so a concurrent
 *     DELETE of the same row collapses to a single winner; the loser sees
 *     "row not found" under the lock and 404s cleanly instead of double-
 *     deleting and then trying to remove already-removed storage objects.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { taskId: rawTaskId } = await context.params;
  const taskIdParse = taskIdParamSchema.safeParse(rawTaskId);
  if (!taskIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid task id");
  }

  try {
    // 1. Resolve the task's owning project OUTSIDE the transaction so we can
    //    reuse the shared access helper (which itself queries the DB). The
    //    helper enforces the tenant + visibility gate; cross-tenant rows
    //    collapse to 404 in the same shape as every other task endpoint.
    const [taskRow] = await db
      .select({
        id: tasks.id,
        projectId: columns.projectId,
      })
      .from(tasks)
      .innerJoin(columns, eq(columns.id, tasks.columnId))
      .where(eq(tasks.id, taskIdParse.data))
      .limit(1);

    if (!taskRow) {
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    const access = await resolveProjectAccessByProjectId({
      projectId: taskRow.projectId,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this task",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // Membership gate. Public projects let non-members read but writes require
    // team membership.
    if (!access.isMember) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team members can delete tasks",
      );
    }

    // 2. Atomic delete. The attachment cleanup is a no-op today (no schema /
    //    storage driver yet) but the transaction boundary is the right place
    //    for it to land later: row-deletes for `attachments` rows go before
    //    the storage-driver calls, and both happen before the task DELETE so
    //    a failure at any step rolls everything back.
    const result = await db.transaction(async (tx) => {
      // Re-read the task under a row lock so a concurrent DELETE serializes
      // through us. If the row is gone by the time we acquire the lock the
      // peer transaction won the race and we 404.
      const [locked] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, taskRow.id))
        .for("update");

      if (!locked) {
        return { kind: "not_found" as const };
      }

      // --- Attachment cascade (placeholder) ---------------------------------
      // When the attachments table + storage driver ship:
      //   1. SELECT all attachment rows for `tasks.id` inside this tx.
      //   2. Delete the storage objects (idempotent; ignore "already gone").
      //   3. tx.delete(attachments).where(eq(attachments.taskId, locked.id)).
      // Until then there is nothing to clean up — the GET endpoint hard-codes
      // an empty `attachments` array on the wire, so no client expects any
      // physical attachments to exist for any task in production.
      // ----------------------------------------------------------------------

      await tx.delete(tasks).where(eq(tasks.id, locked.id));

      return { kind: "ok" as const };
    });

    if (result.kind === "not_found") {
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // 204 No Content: the resource is gone and there's no representation to
    // return. Body MUST be empty per the HTTP spec — `new NextResponse(null,
    // ...)` is the right shape (json() would emit "null" as a body).
    return new NextResponse(null, { status: 204 });
  } catch (err: unknown) {
    console.error("[DELETE /api/tasks/[taskId]] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to delete task at this time",
    );
  }
}
