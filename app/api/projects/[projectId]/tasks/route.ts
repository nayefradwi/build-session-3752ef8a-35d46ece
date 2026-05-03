import { and, asc, eq } from "drizzle-orm";
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

type TasksErrorCode =
  | "INVALID_JSON"
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

// Hard upper bounds on user-supplied text. Title is a single line on the
// board card, description is the long-form body. Both clamp the wire size so
// a pathological client can't shove megabytes through this endpoint.
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 10_000;

const createTaskInputSchema = z.object({
  // columnId is the lane the task lives in. We accept it in the body rather
  // than the URL because a project owns multiple columns and the route is
  // already keyed by projectId; column-scope is part of the payload.
  columnId: z.uuid(),
  // Trim before length-checking so a whitespace-only title fails the
  // non-empty rule.
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH),
  // Description is optional. Empty / whitespace-only strings normalize to
  // null so the DB column matches the "no description" semantic exactly.
  description: z
    .string()
    .max(DESCRIPTION_MAX_LENGTH)
    .optional()
    .nullable()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      const trimmed = v.trim();
      return trimmed === "" ? null : trimmed;
    }),
  // Assignee is optional. When present it must be a UUID (team-membership
  // gating happens after we resolve project access).
  assigneeId: z.uuid().optional().nullable(),
});

/**
 * POST /api/projects/[projectId]/tasks
 *
 * Create a new task in a project column.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - Caller must be a *team member* of the owning team. This is stricter
 *     than the GET endpoint's read gate: even on `public` projects, only
 *     team members may write tasks. Non-members get 403.
 *
 * Validation:
 *   - `title` non-empty after trim, max 200 chars.
 *   - `columnId` must reference a column belonging to THIS project (cross-
 *     project column ids resolve to 422, not 500).
 *   - `assigneeId`, if provided, must be a member of the owning team. We
 *     intentionally don't fall back to "any tenant user" — assigning work
 *     outside the team would let a board push tasks onto someone who can't
 *     even view the project.
 *
 * Position assignment:
 *   - `position = max(existing positions in column) + 1`, or 0 if the column
 *     is empty. The lookup + insert run inside a transaction with FOR UPDATE
 *     on the column row, so two concurrent creates serialize against each
 *     other — same pattern as the columns endpoint. The tasks table has no
 *     unique (columnId, position) constraint (the schema explicitly
 *     tolerates transient ties for client-side reorder UX), so the lock is
 *     the only thing preventing duplicate positions on append.
 *
 * Response: 201 with `{ task: { id, columnId, title, description, position,
 *   createdAt, updatedAt, assignee: { id, name, email } | null } }`. The
 *   assignee slice is inlined (matching the GET shape) so the client doesn't
 *   need a follow-up roundtrip to render the avatar.
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

  const parsed = createTaskInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { columnId, title, description, assigneeId } = parsed.data;

  try {
    // 1. Resolve project access. This enforces tenant isolation (cross-tenant
    //    project => 404) and the visibility rule. We then layer the team-
    //    member requirement on top: writes require membership even on public
    //    projects.
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

    // 2. Team-member gate. Public-project visibility lets non-members READ
    //    the board, but creating tasks requires belonging to the owning
    //    team. resolveProjectAccess already loaded `isMember`, so the gate
    //    is a single boolean check with no extra round-trip.
    if (!access.isMember) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team members can create tasks",
      );
    }

    // 3. Assignee membership check. Done before the transaction so we can
    //    422-fail fast without holding a row lock. The column-belongs-to-
    //    project check happens inside the tx (under the column lock) so the
    //    column can't be deleted out from under us between steps.
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

    // 4. Transactional column-scope check + position derivation + insert.
    //    Locking the column row serializes concurrent create-task calls in
    //    the same column so `max(position) + 1` is authoritative for the
    //    duration of the tx. Cross-project columnIds collapse to "column
    //    not found in this project" → 422.
    const result = await db.transaction(async (tx) => {
      const [column] = await tx
        .select({ id: columns.id, projectId: columns.projectId })
        .from(columns)
        .where(eq(columns.id, columnId))
        .for("update");

      if (!column || column.projectId !== access.project.id) {
        return { kind: "bad_column" as const };
      }

      const existing = await tx
        .select({ position: tasks.position })
        .from(tasks)
        .where(eq(tasks.columnId, column.id));

      // Empty column bootstraps at 0; otherwise append after the current
      // max so existing positions stay stable for any open board UIs.
      const nextPosition =
        existing.length === 0
          ? 0
          : Math.max(...existing.map((row) => row.position)) + 1;

      const [created] = await tx
        .insert(tasks)
        .values({
          columnId: column.id,
          title,
          description,
          assigneeId: assigneeId ?? null,
          position: nextPosition,
          // createdAt / updatedAt fall through to the schema defaults
          // (defaultNow on both). We let Postgres stamp them so the two
          // values match exactly on insert without clock-skew between the
          // app server and the DB.
        })
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

      return { kind: "ok" as const, task: created };
    });

    if (result.kind === "bad_column") {
      return errorResponse(
        422,
        "INVALID_INPUT",
        "Column does not belong to this project",
      );
    }

    // 5. Hydrate the assignee slice for the response. We do this outside
    //    the transaction (one extra round-trip on the happy path with an
    //    assignee) to keep the tx tight; the membership check above already
    //    proved the user exists, so this lookup is a known-hit.
    let assignee: { id: string; name: string | null; email: string } | null =
      null;
    if (result.task.assigneeId !== null) {
      const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, result.task.assigneeId))
        .limit(1);
      // Guard against the assignee being deleted between the membership
      // check and this read — vanishingly unlikely, but we'd rather emit
      // `assignee: null` than crash the response.
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
      { status: 201 },
    );
  } catch (err: unknown) {
    console.error(
      "[POST /api/projects/[projectId]/tasks] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to create task at this time",
    );
  }
}
