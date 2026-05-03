import { asc, eq } from "drizzle-orm";
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

type TasksErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: TasksErrorCode,
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
 * GET /api/projects/[projectId]/tasks
 *
 * Returns every task across every column in the project. Each task carries a
 * small assignee profile slice (id, name, email) inlined onto the row so the
 * board UI can render avatars / @-tags without an N+1 follow-up. Tasks
 * without an assignee return `assignee: null`.
 *
 * Ordering: by columnId then by position ascending. The board groups by
 * column anyway, but a stable order means the response is deterministic and
 * the per-column slice the client extracts is already in render order.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - If the project is `private`, caller must be a team member of the
 *     owning team (403 otherwise).
 *   - If the project is `public`, any tenant member can read it.
 *
 * Response shape:
 *   {
 *     tasks: Array<{
 *       id, columnId, title, description, position, createdAt, updatedAt,
 *       assignee: { id, name, email } | null,
 *     }>
 *   }
 *
 * Implementation note: we constrain the join to columns belonging to the
 * resolved project (rather than going via `projects` directly) so that
 * tasks pointing at a column from a different project — which the schema
 * permits but the app never produces — would still be filtered out.
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

    // INNER JOIN tasks→columns scopes us to columns of *this* project. LEFT
    // JOIN tasks→users keeps unassigned tasks (assigneeId is nullable on
    // SET NULL semantics from schema.ts).
    const rows = await db
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
      })
      .from(tasks)
      .innerJoin(columns, eq(columns.id, tasks.columnId))
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .where(eq(columns.projectId, access.project.id))
      .orderBy(asc(tasks.columnId), asc(tasks.position));

    // Reshape into a stable `assignee: { id, name, email } | null` so the
    // wire format keeps the join's nullability explicit on a single field
    // instead of three nullable scalars.
    const reshaped = rows.map((row) => ({
      id: row.id,
      columnId: row.columnId,
      title: row.title,
      description: row.description,
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      assignee:
        row.assigneeId === null
          ? null
          : {
              id: row.assigneeId,
              // Email is NOT NULL in the schema; the LEFT JOIN can still
              // produce null here in the unreachable "assignee row missing"
              // case. We coerce to "" rather than leak a TS-unsound shape;
              // a follow-up could surface this as a hard data integrity
              // error instead.
              name: row.assigneeName,
              email: row.assigneeEmail ?? "",
            },
    }));

    return NextResponse.json({ tasks: reshaped }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[GET /api/projects/[projectId]/tasks] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load tasks at this time",
    );
  }
}
