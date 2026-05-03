import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns, tasks, users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every read pulls the session cookie and queries the DB,
// and the response is tenant- + visibility-scoped, so prerender / route
// caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TaskDetailErrorCode =
  | "INVALID_INPUT"
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
