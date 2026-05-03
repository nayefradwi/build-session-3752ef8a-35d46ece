import { and, asc, eq, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns, tasks, users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every call mutates state and is gated by the session
// cookie + tenant scope, so prerender / route caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MoveErrorCode =
  | "INVALID_INPUT"
  | "INVALID_JSON"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: MoveErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// Dynamic route segment validation: avoid letting a malformed taskId reach
// Postgres' uuid cast and panic with a 500.
const taskIdParamSchema = z.uuid();

/**
 * Move payload.
 *
 *   - `targetColumnId` is the column the caller wants the task to land in.
 *     Must belong to the same project as the task's current column. Same-
 *     column reorders are allowed (target == source).
 *   - `newPosition` is the 0-based slot the task should occupy in the target
 *     column AFTER the move. The server clamps to the valid range
 *     [0, columnLength] for cross-column moves and [0, columnLength - 1] for
 *     same-column moves, so a client passing an out-of-range index lands at
 *     the nearest end rather than 400-failing — kanban DnD often computes
 *     drop indices that are technically off-by-one at the boundary.
 */
const moveTaskInputSchema = z.object({
  targetColumnId: z.uuid(),
  newPosition: z.number().int().min(0),
});

/**
 * PATCH /api/tasks/[taskId]/move
 *
 * Move a task to a new slot — either reordering within its current column or
 * crossing into a sibling column of the same project. The server is the
 * authority on the resulting positions: it accepts a desired index, clamps
 * it to the valid range, and re-stamps every affected row in the target
 * (and, for cross-column moves, source) column to a contiguous 0..N-1 range.
 *
 * Authorization (mirrors PUT /api/tasks/[taskId]):
 *   - Caller must be authenticated (401 otherwise).
 *   - Task's owning project must live in the caller's tenant. Cross-tenant
 *     or non-existent task ids collapse to 404 to avoid leaking existence.
 *   - Caller must be a *team member* of the owning team. Public-project
 *     visibility lets non-members read; writes require membership (403
 *     otherwise).
 *
 * Validation:
 *   - `targetColumnId` must reference a column belonging to the same project
 *     as the task's current column. Cross-project / cross-tenant target ids
 *     resolve to 422 (not 500), same as the create endpoint.
 *   - `newPosition` is a non-negative integer; out-of-range values are
 *     clamped server-side rather than rejected.
 *
 * Concurrency strategy (integer shift via full re-stamp under column locks):
 *   - We acquire `SELECT ... FOR UPDATE` on the source column row, then on
 *     the target column row (when distinct). Lock acquisition is in
 *     canonical column-id order to avoid deadlocking against another move
 *     going the opposite direction.
 *   - The existing position-mutating endpoints (POST /tasks, POST /columns)
 *     all coordinate via the same column-row lock, so this PATCH serializes
 *     correctly against concurrent appends.
 *   - Inside the transaction we read the target column's tasks ordered by
 *     position (excluding the moving task), splice the moving task in at the
 *     clamped index, and re-stamp positions 0..N. For cross-column moves we
 *     also compact the source column to close the gap left behind.
 *   - Only the *moving* task gets `updatedAt` bumped. Sibling rows whose
 *     position shifted are renumbered but not marked as user-modified — a
 *     drag-and-drop shouldn't appear as "everyone touched every card".
 *
 * Response shape (200): same as PUT /api/tasks/[taskId] —
 *   { task: { id, columnId, title, description, position, createdAt,
 *     updatedAt, assignee: { id, name, email } | null } }
 */
export async function PATCH(
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

  const parsed = moveTaskInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { targetColumnId, newPosition } = parsed.data;

  try {
    // 1. Locate the task and its current owning project. Tenant + visibility
    //    gates run via the shared helper; cross-tenant rows collapse to 404.
    const [taskRow] = await db
      .select({
        id: tasks.id,
        columnId: tasks.columnId,
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

    if (!access.isMember) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team members can move tasks",
      );
    }

    // 2. Transactional move. We re-resolve the moving task's current column
    //    inside the tx so a concurrent move can't slip the row sideways
    //    between step 1 and the column locks below.
    const result = await db.transaction(async (tx) => {
      const [moving0] = await tx
        .select({
          id: tasks.id,
          columnId: tasks.columnId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskRow.id))
        .limit(1);

      if (!moving0) {
        return { kind: "task_gone" as const };
      }

      const sourceColumnId = moving0.columnId;
      const sameColumn = sourceColumnId === targetColumnId;

      // Acquire FOR UPDATE locks on column rows in canonical id order.
      // Locking sequentially in sorted order is the textbook fix for the
      // A->B vs B->A move deadlock — Postgres won't auto-detect this
      // pattern, but consistent ordering eliminates it entirely.
      const lockOrder = sameColumn
        ? [sourceColumnId]
        : [sourceColumnId, targetColumnId].sort();
      const lockedCols = new Map<string, { id: string; projectId: string }>();
      for (const id of lockOrder) {
        const [col] = await tx
          .select({ id: columns.id, projectId: columns.projectId })
          .from(columns)
          .where(eq(columns.id, id))
          .for("update");
        if (!col) {
          // Source missing => the task's column was cascade-deleted between
          // step 1 and now (extremely unlikely but possible); surface as 404.
          // Target missing => bad client input, 422 like POST /tasks.
          if (id === sourceColumnId) {
            return { kind: "task_gone" as const };
          }
          return { kind: "bad_target_column" as const };
        }
        lockedCols.set(id, col);
      }

      const srcCol = lockedCols.get(sourceColumnId);
      const tgtCol = lockedCols.get(targetColumnId);
      // The map is populated above for both ids (or just one when
      // sameColumn); these guards exist purely for the type narrower.
      if (!srcCol || !tgtCol) {
        return { kind: "task_gone" as const };
      }

      // Both columns must belong to the access-resolved project. Source
      // ought to match by construction, but if a race migrated the task to
      // another project we want to bail rather than splice into the wrong
      // place. Target mismatch is the standard cross-project 422.
      if (srcCol.projectId !== access.project.id) {
        return { kind: "task_gone" as const };
      }
      if (tgtCol.projectId !== access.project.id) {
        return { kind: "bad_target_column" as const };
      }

      // Re-read the moving task under the column locks. If a concurrent
      // PATCH or DELETE got there first, columnId may have shifted away
      // from sourceColumnId or the row may be gone outright.
      const [moving] = await tx
        .select({
          id: tasks.id,
          columnId: tasks.columnId,
          position: tasks.position,
        })
        .from(tasks)
        .where(eq(tasks.id, taskRow.id))
        .limit(1);

      if (!moving || moving.columnId !== sourceColumnId) {
        return { kind: "task_gone" as const };
      }

      // 3. Compute the new ordering for the target column. Pull every task
      //    currently in the target column EXCEPT the moving one, sort by
      //    position (asc id is the deterministic tiebreaker since the
      //    schema explicitly tolerates transient ties), and splice the
      //    moving task in at the clamped insert index.
      const targetExisting = await tx
        .select({ id: tasks.id, position: tasks.position })
        .from(tasks)
        .where(and(eq(tasks.columnId, tgtCol.id), ne(tasks.id, moving.id)))
        .orderBy(asc(tasks.position), asc(tasks.id));

      const insertIndex = Math.min(
        Math.max(Math.floor(newPosition), 0),
        targetExisting.length,
      );

      const newOrder: Array<{ id: string; oldPosition: number | null }> = [
        ...targetExisting
          .slice(0, insertIndex)
          .map((row) => ({ id: row.id, oldPosition: row.position })),
        // The moving task is included with a sentinel oldPosition so the
        // re-stamp loop always issues an UPDATE (we may also be flipping
        // its columnId, which the per-row diff alone wouldn't catch).
        { id: moving.id, oldPosition: null },
        ...targetExisting
          .slice(insertIndex)
          .map((row) => ({ id: row.id, oldPosition: row.position })),
      ];

      // 4. Re-stamp 0..N-1. We skip rows whose position is already the
      //    correct value (no-op) to keep the write set minimal — a typical
      //    drop only shifts a contiguous window of cards by one.
      for (let i = 0; i < newOrder.length; i++) {
        const row = newOrder[i];
        if (row.id === moving.id) {
          await tx
            .update(tasks)
            .set({
              columnId: tgtCol.id,
              position: i,
              updatedAt: sql`now()`,
            })
            .where(eq(tasks.id, moving.id));
        } else if (row.oldPosition !== i) {
          await tx
            .update(tasks)
            .set({ position: i })
            .where(eq(tasks.id, row.id));
        }
      }

      // 5. Cross-column move: compact the source column so its remaining
      //    tasks form a contiguous 0..M-1. Same-column moves don't need
      //    this step (the splice above already handled both ends).
      if (!sameColumn) {
        const sourceRemaining = await tx
          .select({ id: tasks.id, position: tasks.position })
          .from(tasks)
          .where(eq(tasks.columnId, srcCol.id))
          .orderBy(asc(tasks.position), asc(tasks.id));

        for (let i = 0; i < sourceRemaining.length; i++) {
          const row = sourceRemaining[i];
          if (row.position !== i) {
            await tx
              .update(tasks)
              .set({ position: i })
              .where(eq(tasks.id, row.id));
          }
        }
      }

      // 6. Read the moving task back for the response payload.
      const [updated] = await tx
        .select({
          id: tasks.id,
          columnId: tasks.columnId,
          title: tasks.title,
          description: tasks.description,
          position: tasks.position,
          assigneeId: tasks.assigneeId,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(eq(tasks.id, moving.id))
        .limit(1);

      if (!updated) {
        // Should be unreachable — we just updated this row inside the
        // same tx — but treat as 404 rather than 500 if it ever happens.
        return { kind: "task_gone" as const };
      }

      return { kind: "ok" as const, task: updated };
    });

    if (result.kind === "task_gone") {
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }
    if (result.kind === "bad_target_column") {
      return errorResponse(
        422,
        "INVALID_INPUT",
        "Target column does not belong to this project",
      );
    }

    // 7. Hydrate the assignee slice for the response (matches the GET / PUT
    //    /api/tasks/[taskId] shape so the client sees a single canonical
    //    payload across read and every kind of write).
    let assignee: { id: string; name: string | null; email: string } | null =
      null;
    if (result.task.assigneeId !== null) {
      const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, result.task.assigneeId))
        .limit(1);
      assignee = user
        ? { id: user.id, name: user.name, email: user.email }
        : null;
    }

    return NextResponse.json(
      {
        task: {
          id: result.task.id,
          columnId: result.task.columnId,
          title: result.task.title,
          description: result.task.description,
          position: result.task.position,
          createdAt: result.task.createdAt,
          updatedAt: result.task.updatedAt,
          assignee,
        },
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("[PATCH /api/tasks/[taskId]/move] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to move task at this time",
    );
  }
}
